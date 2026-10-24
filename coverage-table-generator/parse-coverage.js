#!/usr/bin/env node
/**
 * Reads an Istanbul coverage report for one repo and prints one line:
 *   <lines%>|<branches%>|<functions%>|<statements%>
 * Percentages are rounded to 2 dp, or "NA" when unavailable.
 *
 * Resolution order (first that exists wins):
 *   1. coverage/coverage-summary.json  (json-summary reporter — has totals)
 *   2. coverage/coverage-final.json    (per-file counters — we total them)
 *
 * Usage: node parse-coverage.js <repoDir>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const pct = (covered, total) => (total > 0 ? Math.ceil((covered / total) * 100) : 'NA');

/** Total a coverage-final.json map into lines/branches/functions/statements. */
function fromFinal(final) {
    const acc = {
        s: [0, 0], // statements [covered, total]
        b: [0, 0], // branches
        f: [0, 0], // functions
        l: [0, 0], // lines
    };
    for (const file of Object.values(final)) {
        // statements
        for (const hit of Object.values(file.s || {})) {
            acc.s[1] += 1;
            if (hit > 0) acc.s[0] += 1;
        }
        // functions
        for (const hit of Object.values(file.f || {})) {
            acc.f[1] += 1;
            if (hit > 0) acc.f[0] += 1;
        }
        // branches (each entry is an array of counts per branch path)
        for (const paths of Object.values(file.b || {})) {
            for (const hit of paths) {
                acc.b[1] += 1;
                if (hit > 0) acc.b[0] += 1;
            }
        }
        // lines: derive from statementMap line numbers + s counts
        const stmtMap = file.statementMap || {};
        const lineHits = {};
        for (const [id, loc] of Object.entries(stmtMap)) {
            const line = loc.start && loc.start.line;
            if (line == null) continue;
            const hit = (file.s || {})[id] || 0;
            // a line counts as covered if any statement on it ran
            if (!(line in lineHits) || hit > lineHits[line]) lineHits[line] = hit;
        }
        for (const hit of Object.values(lineHits)) {
            acc.l[1] += 1;
            if (hit > 0) acc.l[0] += 1;
        }
    }
    return {
        lines: pct(acc.l[0], acc.l[1]),
        branches: pct(acc.b[0], acc.b[1]),
        functions: pct(acc.f[0], acc.f[1]),
        statements: pct(acc.s[0], acc.s[1]),
    };
}

function fromSummary(summary) {
    const t = summary.total || {};
    const get = (k) => (t[k] && typeof t[k].pct === 'number' ? Math.ceil(t[k].pct) : 'NA');
    return {
        lines: get('lines'),
        branches: get('branches'),
        functions: get('functions'),
        statements: get('statements'),
    };
}

function main() {
    const repoDir = process.argv[2];
    if (!repoDir) {
        process.stderr.write('usage: node parse-coverage.js <repoDir>\n');
        process.exit(2);
    }
    const summaryPath = path.join(repoDir, 'coverage', 'coverage-summary.json');
    const finalPath = path.join(repoDir, 'coverage', 'coverage-final.json');

    let result;
    try {
        if (fs.existsSync(summaryPath)) {
            result = fromSummary(JSON.parse(fs.readFileSync(summaryPath, 'utf8')));
        } else if (fs.existsSync(finalPath)) {
            result = fromFinal(JSON.parse(fs.readFileSync(finalPath, 'utf8')));
        } else {
            process.stdout.write('NA|NA|NA|NA\n');
            return;
        }
    } catch (err) {
        process.stderr.write(`parse-coverage: ${err.message}\n`);
        process.stdout.write('NA|NA|NA|NA\n');
        return;
    }
    process.stdout.write(`${result.lines}|${result.branches}|${result.functions}|${result.statements}\n`);
}

// --- tiny self-check: `node parse-coverage.js --selftest` ---
if (process.argv[2] === '--selftest') {
    const assert = require('assert');
    const s = fromSummary({ total: { lines: { pct: 92 }, branches: { pct: 80 }, functions: { pct: 75 }, statements: { pct: 90.005 } } });
    assert.strictEqual(s.lines, 92);
    assert.strictEqual(s.branches, 80);
    assert.strictEqual(s.statements, 91); // 90.005 -> ceil -> 91
    const f = fromFinal({
        'a.js': {
            statementMap: { '0': { start: { line: 1 } }, '1': { start: { line: 2 } } },
            s: { '0': 1, '1': 0 },
            f: { '0': 1 },
            b: { '0': [1, 0] },
        },
    });
    assert.strictEqual(f.lines, 50); // 1 of 2 lines
    assert.strictEqual(f.statements, 50); // 1 of 2 statements
    assert.strictEqual(f.functions, 100); // 1 of 1
    assert.strictEqual(f.branches, 50); // 1 of 2 branch paths
    process.stdout.write('parse-coverage selftest OK\n');
    process.exit(0);
}

main();
