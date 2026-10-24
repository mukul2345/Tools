#!/usr/bin/env node
/**
 * mr-review — entry point of the @dfg/mr-review package.
 *
 * Loads secrets from the macOS keychain into the environment (never from argv), then runs the
 * deterministic Python spine shipped in this package. All flags are handled by run_pipeline.py
 * (`mr-review --help`); `--version` is answered here from package.json.
 *
 * Secrets (keychain service names; env vars win when already exported):
 *   GITLAB_PERSONAL_ACCESS_TOKEN  <- 'gitlab-pat'   (api scope; falls back to the @dfg registry
 *                                                    token in ~/.npmrc, which can fetch but may
 *                                                    lack the scope to post)
 *   ATLASSIAN_EMAIL               <- 'atlassian-email'
 *   ATLASSIAN_API_TOKEN           <- 'atlassian-api-token'
 *   JIRA_BASE_URL                 <- 'jira-base-url'
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PKG_DIR = path.resolve(__dirname, '..');
const pkg = require(path.join(PKG_DIR, 'package.json'));
const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
    console.log(`${pkg.name} ${pkg.version}`);
    process.exit(0);
}

// ---- `mr-review config` — per-user defaults, like `git config` -------------------------------
// Stored in ~/.config/mr-review/config.json. Precedence: CLI flag > env var > config > built-in.
const CONFIG_PATH = path.join(os.homedir(), '.config', 'mr-review', 'config.json');
const CONFIG_KEYS = {
    'find-model': { env: 'KIRO_MR_FIND_MODEL', help: 'model for the finder stages', model: true },
    'verify-model': { env: 'KIRO_MR_VERIFY_MODEL', help: 'model for verify + gap stages', model: true },
    depth: { env: 'KIRO_MR_DEPTH', help: 'quick | standard | deep', values: ['quick', 'standard', 'deep'] },
    threshold: { env: 'KIRO_MR_THRESHOLD', help: 'min verifier confidence 0-100', int: [0, 100] },
    parallel: { env: 'KIRO_MR_PARALLEL', help: 'max concurrent kiro-cli sessions', int: [1, 8] },
    engine: { env: 'KIRO_MR_ENGINE', help: 'kiro-cli engine: v2 | v3', values: ['v2', 'v3'] },
};

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function writeConfig(cfg) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

/** Reject unknown models up front, so a typo fails here and not 10 minutes into a review. */
function validateModel(model) {
    try {
        const out = execFileSync('kiro-cli', ['chat', '--list-models', '--format', 'json'], {
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString();
        const data = JSON.parse(out);
        const list = Array.isArray(data) ? data : data.models || [];
        const ids = list.map((m) => m.model_id || m.id).filter(Boolean);
        if (ids.length && !ids.includes(model)) {
            console.error(`unknown model '${model}'. Available: ${ids.join(', ')}`);
            process.exit(2);
        }
    } catch {
        console.error('[mr-review] note: could not list kiro-cli models; saved without validation.');
    }
}

function configCommand(sub, key, value) {
    const cfg = readConfig();
    const usage =
        'usage: mr-review config list | get <key> | set <key> <value> | unset <key>\n\nkeys:\n' +
        Object.entries(CONFIG_KEYS)
            .map(([k, v]) => `  ${k.padEnd(13)} ${v.help}`)
            .join('\n');
    if (!sub || sub === 'list') {
        const keys = Object.keys(cfg);
        console.log(keys.length ? keys.map((k) => `${k}=${cfg[k]}`).join('\n') : '(no settings — built-in defaults apply)');
        return 0;
    }
    if (!CONFIG_KEYS[key]) {
        console.error(key ? `unknown key '${key}'\n\n${usage}` : usage);
        return 2;
    }
    const spec = CONFIG_KEYS[key];
    if (sub === 'get') {
        if (cfg[key] !== undefined) console.log(cfg[key]);
        return cfg[key] !== undefined ? 0 : 1;
    }
    if (sub === 'unset') {
        delete cfg[key];
        writeConfig(cfg);
        return 0;
    }
    if (sub === 'set' && value !== undefined) {
        if (spec.values && !spec.values.includes(value)) {
            console.error(`${key} must be one of: ${spec.values.join(', ')}`);
            return 2;
        }
        if (spec.int) {
            const n = Number(value);
            if (!Number.isInteger(n) || n < spec.int[0] || n > spec.int[1]) {
                console.error(`${key} must be an integer ${spec.int[0]}-${spec.int[1]}`);
                return 2;
            }
        }
        if (spec.model) validateModel(value);
        cfg[key] = value;
        writeConfig(cfg);
        return 0;
    }
    console.error(usage);
    return 2;
}

if (args[0] === 'config') {
    process.exit(configCommand(args[1], args[2], args[3]));
}

// ---- once-a-day update notice ----------------------------------------------------------------
// Never installs anything and never blocks a run: one `npm view` (3s timeout) at most every 24h,
// cached in ~/.config/mr-review/update-check.json. Opt out with MR_REVIEW_NO_UPDATE_CHECK=1.
const UPDATE_CACHE = path.join(path.dirname(CONFIG_PATH), 'update-check.json');
const DAY_MS = 24 * 60 * 60 * 1000;

function newerThan(a, b) {
    const pa = String(a).split('-')[0].split('.').map(Number);
    const pb = String(b).split('-')[0].split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
}

function latestVersion() {
    let cache = {};
    try {
        cache = JSON.parse(fs.readFileSync(UPDATE_CACHE, 'utf8'));
    } catch {
        // first run or unreadable cache — check now
    }
    if (cache.latest && Date.now() - (cache.checkedAt || 0) < DAY_MS) return cache.latest;
    let latest = '';
    try {
        latest = execFileSync('npm', ['view', pkg.name, 'version'], {
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 3000,
        })
            .toString()
            .trim();
    } catch {
        // offline / registry unreachable — remember the attempt so we don't retry every run
    }
    try {
        fs.mkdirSync(path.dirname(UPDATE_CACHE), { recursive: true });
        fs.writeFileSync(UPDATE_CACHE, JSON.stringify({ checkedAt: Date.now(), latest: latest || cache.latest || '' }));
    } catch {
        // cache is best-effort
    }
    return latest || cache.latest || '';
}

if (!process.env.MR_REVIEW_NO_UPDATE_CHECK) {
    const latest = latestVersion();
    if (latest && newerThan(latest, pkg.version)) {
        console.error(
            `[mr-review] ${pkg.name} ${latest} is available (you have ${pkg.version}). ` +
                `Update: npm i -g ${pkg.name}@latest`,
        );
    }
}

function keychain(service) {
    try {
        return execFileSync('security', ['find-generic-password', '-s', service, '-w'], {
            stdio: ['ignore', 'pipe', 'ignore'],
        })
            .toString()
            .trim();
    } catch {
        return '';
    }
}

/** The @dfg registry token every VPT dev already has in ~/.npmrc (to install @dfg packages). */
function npmrcGitlabToken() {
    try {
        const npmrc = fs.readFileSync(path.join(os.homedir(), '.npmrc'), 'utf8');
        const m = npmrc.match(/^\/\/gitlab\.com\/api\/v4\/[^\n]*:_authToken=(\S+)$/m);
        return m ? m[1] : '';
    } catch {
        return '';
    }
}

// ---- `mr-review setup` — store secrets in the macOS keychain ---------------------------------
// `security ... -w` with no value makes macOS prompt for it (twice, hidden), so a secret never
// lands in argv, shell history, or a file. Runs automatically on first use from a terminal.
const SECRETS = [
    { service: 'gitlab-pat', label: 'GitLab personal access token (api scope — needed to post comments)', required: true },
    { service: 'atlassian-email', label: 'Atlassian email (Jira business context)' },
    { service: 'atlassian-api-token', label: 'Atlassian API token (id.atlassian.com → Security → API tokens)' },
    { service: 'jira-base-url', label: 'Jira URL, e.g. https://<site>.atlassian.net' },
];

function askTty(question) {
    process.stderr.write(question);
    const fd = fs.openSync('/dev/tty', 'r');
    try {
        const buf = Buffer.alloc(1024);
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        return buf.toString('utf8', 0, n).trim();
    } finally {
        fs.closeSync(fd);
    }
}

function setup(reset) {
    try {
        fs.closeSync(fs.openSync('/dev/tty', 'r'));
    } catch {
        console.error('[mr-review setup] needs a terminal. Run `mr-review setup` from Terminal/iTerm.');
        return false;
    }
    console.error(`[mr-review setup] secrets go to the macOS keychain (${reset ? 'replacing' : 'only missing ones'}).`);
    for (const s of SECRETS) {
        if (!reset && keychain(s.service)) {
            console.error(`  ✓ ${s.service} already stored`);
            continue;
        }
        const answer = askTty(`  ${s.label}\n    store '${s.service}' now? [Y/n] `);
        if (/^n/i.test(answer)) {
            console.error(`    skipped${s.required ? ' — reviews need this; run `mr-review setup` later' : ''}`);
            continue;
        }
        const r = spawnSync('security', ['add-generic-password', '-U', '-s', s.service, '-a', os.userInfo().username, '-w'], {
            stdio: 'inherit',
        });
        console.error(r.status === 0 ? `    ✓ saved ${s.service}` : `    ✗ could not save ${s.service}`);
    }
    console.error('[mr-review setup] done. Re-run any time; `mr-review setup --reset` replaces stored values.');
    return true;
}

if (args[0] === 'setup') {
    process.exit(setup(args.includes('--reset')) ? 0 : 2);
}

const env = { ...process.env, MR_REVIEW_VERSION: pkg.version };
// user config fills the env defaults run_pipeline.py reads; an exported env var still wins
const userConfig = readConfig();
for (const [key, spec] of Object.entries(CONFIG_KEYS)) {
    if (!env[spec.env] && userConfig[key] !== undefined) env[spec.env] = String(userConfig[key]);
}
const fromKeychain = {
    GITLAB_PERSONAL_ACCESS_TOKEN: 'gitlab-pat',
    ATLASSIAN_EMAIL: 'atlassian-email',
    ATLASSIAN_API_TOKEN: 'atlassian-api-token',
    JIRA_BASE_URL: 'jira-base-url',
};
for (const [name, service] of Object.entries(fromKeychain)) {
    if (!env[name]) env[name] = keychain(service);
}
const isHelp = args.length === 0 || args.includes('--help') || args.includes('-h');
const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
if (!env.GITLAB_PERSONAL_ACCESS_TOKEN && !isHelp && interactive) {
    // first run from a terminal: walk through setup instead of failing
    console.error('[mr-review] first run — no GitLab token in the keychain yet.');
    setup(false);
    for (const [name, service] of Object.entries(fromKeychain)) {
        if (!env[name]) env[name] = keychain(service);
    }
}
if (!env.GITLAB_PERSONAL_ACCESS_TOKEN && !isHelp) {
    env.GITLAB_PERSONAL_ACCESS_TOKEN = npmrcGitlabToken();
    if (env.GITLAB_PERSONAL_ACCESS_TOKEN) {
        console.error(
            '[mr-review] using the GitLab token from ~/.npmrc. If posting fails with 403, store an ' +
                'api-scope PAT with:  mr-review setup',
        );
    } else {
        console.error('[mr-review] no GitLab token. Store one with:  mr-review setup');
        process.exit(2);
    }
}
if (!isHelp && !(env.ATLASSIAN_EMAIL && env.ATLASSIAN_API_TOKEN && env.JIRA_BASE_URL)) {
    console.error('[mr-review] note: Jira secrets not fully set (mr-review setup) — business context will be limited.');
}

const result = spawnSync(
    'python3',
    [path.join(PKG_DIR, 'scripts', 'run_pipeline.py'), ...(args.length ? args : ['--help'])],
    { stdio: 'inherit', env },
);
if (result.error) {
    console.error(`[mr-review] could not start python3: ${result.error.message}`);
    process.exit(127);
}
process.exit(result.status ?? 1);
