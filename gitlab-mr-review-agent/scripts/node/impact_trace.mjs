#!/usr/bin/env node
/**
 * impact_trace.mjs — deterministic call-graph backtrace for the MR-review "impact" step.
 *
 * Given the changed files + changed line ranges of an MR (changed-index.json), this uses the
 * TypeScript language service (via ts-morph) to:
 *   1. Find the function/method/accessor declarations whose body overlaps the changed lines
 *      ("touched symbols").
 *   2. Walk callers UPWARD (findReferences -> enclosing declaration -> recurse) until it reaches
 *      an ENTRY POINT (an Express controller method on a class extending BaseController, or a
 *      handler in a *PubSub.ts file), or hits a depth/breadth cap.
 *   3. Mark BLIND SPOTS where a static trace cannot see the real runtime edge — interface methods,
 *      factory/DI boundaries, or symbols with zero static references (likely dynamic dispatch).
 *
 * Output (into --out dir):
 *   impact-map.md   — human/agent-readable: per touched symbol, the chains to entry points,
 *                     blind spots, and boundary crossings. Honest about incompleteness.
 *   impact-map.json — structured sidecar.
 *
 * This is GROUNDING for the LLM's regression + design judgment, NOT a licence to comment on
 * unchanged callers. Enumeration is mechanical (here); the risk judgment stays with the model.
 *
 * Usage:
 *   node impact_trace.mjs <cloneDir> <changedIndexJson> <outDir>
 *        [--max-depth 6] [--max-callers 25] [--max-nodes 500]
 */

import fs from "node:fs";
import path from "node:path";
import { Project, Node } from "ts-morph";

// ---- args ----
const [, , cloneArg, changedIndexArg, outArg, ...rest] = process.argv;
if (!cloneArg || !changedIndexArg || !outArg) {
  console.error(
    "usage: impact_trace.mjs <cloneDir> <changedIndexJson> <outDir> [--max-depth N] [--max-callers N] [--max-nodes N]",
  );
  process.exit(2);
}
const opt = (name, def) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] ? parseInt(rest[i + 1], 10) : def;
};
const MAX_DEPTH = opt("--max-depth", 6);
const MAX_CALLERS = opt("--max-callers", 25);
const MAX_NODES = opt("--max-nodes", 500);

const clone = path.resolve(cloneArg);
const outDir = path.resolve(outArg);
const changedIndex = JSON.parse(fs.readFileSync(changedIndexArg, "utf8")); // {relPath: [lines]}

// ---- load project ----
function findTsConfig(root) {
  const candidates = [
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.build.json",
  ];
  for (const c of candidates) {
    const p = path.join(root, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const tsConfigFilePath = findTsConfig(clone);
let project;
try {
  project = tsConfigFilePath
    ? new Project({ tsConfigFilePath, skipAddingFilesFromTsConfig: false })
    : new Project({ compilerOptions: { allowJs: false } });
  if (!tsConfigFilePath) {
    project.addSourceFilesAtPaths([
      `${clone}/**/*.ts`,
      `!${clone}/**/*.d.ts`,
      `!${clone}/**/node_modules/**`,
    ]);
  }
} catch (e) {
  console.error(`[impact] failed to load TS project: ${e.message}`);
  process.exit(3);
}

// ---- helpers ----
const CALLER_KINDS = (n) =>
  Node.isMethodDeclaration(n) ||
  Node.isFunctionDeclaration(n) ||
  Node.isConstructorDeclaration(n) ||
  Node.isGetAccessorDeclaration(n) ||
  Node.isSetAccessorDeclaration(n) ||
  Node.isArrowFunction(n) ||
  Node.isFunctionExpression(n);

function enclosingClass(node) {
  return node.getFirstAncestor((a) => Node.isClassDeclaration(a)) || null;
}

function extendsText(cls) {
  try {
    return cls?.getExtends()?.getExpression().getText() || "";
  } catch {
    return "";
  }
}

function declLabel(decl) {
  const cls = enclosingClass(decl);
  let name = "";
  if (Node.isConstructorDeclaration(decl)) name = "constructor";
  else if (typeof decl.getName === "function") name = decl.getName() || "";
  if (!name) {
    // arrow/function expression assigned to a variable or class property
    const named = decl.getFirstAncestor(
      (a) => Node.isVariableDeclaration(a) || Node.isPropertyDeclaration(a),
    );
    if (named && typeof named.getName === "function") name = named.getName();
  }
  const cname = cls && typeof cls.getName === "function" ? cls.getName() : "";
  return cname ? `${cname}.${name || "<anon>"}` : name || "<anon>";
}

function loc(node) {
  const sf = node.getSourceFile();
  const rel = path.relative(clone, sf.getFilePath());
  return `${rel}:${node.getStartLineNumber()}`;
}

function nodeId(decl) {
  return `${decl.getSourceFile().getFilePath()}#${decl.getStart()}`;
}

// entry-point classification (stack-specific recognizers, confirmed with the team)
function entryKind(decl) {
  const cls = enclosingClass(decl);
  const ext = extendsText(cls);
  if (/\bBaseController\b/.test(ext)) return "http_controller";
  const file = decl.getSourceFile().getBaseName();
  if (/PubSub\.ts$/.test(file)) return "sqs_pubsub";
  if (
    /\b(Consumer|Producer)\b/.test(ext) ||
    /(Consumer|Producer)\.ts$/.test(file)
  )
    return "sqs_pubsub";
  return null;
}

// boundary crossings (trace can't follow past these — flag for the LLM + sibling MRs)
function boundaryKind(decl) {
  const cls = enclosingClass(decl);
  const cname =
    cls && typeof cls.getName === "function" ? cls.getName() || "" : "";
  const file = decl.getSourceFile().getBaseName();
  if (/ServiceClient$/.test(cname) || /ServiceClient\.ts$/.test(file))
    return "external_http_client";
  if (/PubSub\.ts$/.test(file) || /Producer/.test(cname)) return "sqs_boundary";
  return null;
}

function isFactoryContext(decl) {
  const cls = enclosingClass(decl);
  const cname =
    cls && typeof cls.getName === "function" ? cls.getName() || "" : "";
  const file = decl.getSourceFile().getBaseName();
  return /Factory/.test(cname) || /Factory\.ts$/.test(file);
}

// ---- seed: declarations overlapping changed lines ----
function collectDeclsInFile(sf) {
  const decls = [];
  sf.getFunctions().forEach((f) => decls.push(f));
  sf.getClasses().forEach((c) => {
    c.getMethods().forEach((m) => decls.push(m));
    c.getConstructors().forEach((m) => decls.push(m));
    c.getGetAccessors().forEach((m) => decls.push(m));
    c.getSetAccessors().forEach((m) => decls.push(m));
    c.getProperties().forEach((p) => {
      const arrow = p.getFirstDescendant((d) => Node.isArrowFunction(d));
      if (arrow) decls.push(arrow);
    });
  });
  return decls;
}

const seeds = [];
const blindSpots = [];
for (const [rel, lines] of Object.entries(changedIndex)) {
  if (!rel.endsWith(".ts") || rel.endsWith(".d.ts")) continue;
  if (rel.endsWith(".test.ts") || rel.endsWith(".spec.ts")) continue;
  const abs = path.resolve(clone, rel);
  let sf = project.getSourceFile(abs);
  if (!sf && fs.existsSync(abs)) sf = project.addSourceFileAtPathIfExists(abs);
  if (!sf) continue;
  const changed = new Set(lines);
  for (const decl of collectDeclsInFile(sf)) {
    const start = decl.getStartLineNumber();
    const end = decl.getEndLineNumber();
    let overlaps = false;
    for (const l of changed) {
      if (l >= start && l <= end) {
        overlaps = true;
        break;
      }
    }
    if (overlaps) seeds.push(decl);
  }
}

// dedupe seeds
const seenSeed = new Set();
const uniqueSeeds = [];
for (const s of seeds) {
  const id = nodeId(s);
  if (!seenSeed.has(id)) {
    seenSeed.add(id);
    uniqueSeeds.push(s);
  }
}

// ---- BFS upward from each seed ----
function callersOf(decl) {
  let refs = [];
  try {
    refs = decl.findReferencesAsNodes();
  } catch {
    return { callers: [], zeroRefs: false, error: true };
  }
  const callers = [];
  const seen = new Set();
  for (const ref of refs) {
    // skip the declaration's own name node
    if (
      ref.getSourceFile() === decl.getSourceFile() &&
      Math.abs(ref.getStartLineNumber() - decl.getStartLineNumber()) === 0
    )
      continue;
    const owner = ref.getFirstAncestor((a) => CALLER_KINDS(a));
    if (!owner) continue;
    const id = nodeId(owner);
    if (seen.has(id) || id === nodeId(decl)) continue;
    seen.add(id);
    callers.push(owner);
    if (callers.length >= MAX_CALLERS) break;
  }
  // zero *real* references on an exported symbol => likely dynamic dispatch / DI / external
  const zeroRefs = callers.length === 0;
  return { callers, zeroRefs, error: false };
}

const results = [];
let totalNodes = 0;

for (const seed of uniqueSeeds) {
  const seedLabel = declLabel(seed);
  const seedLoc = loc(seed);
  const chains = []; // arrays of {label, loc, entry}
  const localBlind = [];
  const boundaries = [];
  const entriesReached = new Set();

  // is the seed itself an entry point / interface?
  const seedEntry = entryKind(seed);

  // BFS with parent pointers
  const queue = [{ decl: seed, depth: 0, parent: null }];
  const visited = new Set([nodeId(seed)]);

  function buildChain(node) {
    const arr = [];
    let cur = node;
    while (cur) {
      arr.unshift({ label: declLabel(cur.decl), loc: loc(cur.decl) });
      cur = cur.parent;
    }
    return arr;
  }

  if (seedEntry) {
    entriesReached.add(seedEntry);
    chains.push({
      entry: seedEntry,
      path: [{ label: seedLabel, loc: seedLoc }],
    });
  }

  while (queue.length && totalNodes < MAX_NODES) {
    const cur = queue.shift();
    totalNodes++;

    const bk = boundaryKind(cur.decl);
    if (bk)
      boundaries.push({
        kind: bk,
        label: declLabel(cur.decl),
        loc: loc(cur.decl),
      });

    if (cur.depth >= MAX_DEPTH) {
      localBlind.push(
        `depth cap reached at ${declLabel(cur.decl)} (${loc(cur.decl)})`,
      );
      continue;
    }

    const { callers, zeroRefs, error } = callersOf(cur.decl);
    if (error) {
      localBlind.push(
        `reference lookup failed at ${declLabel(cur.decl)} (${loc(cur.decl)})`,
      );
      continue;
    }

    if (zeroRefs && cur.depth > 0) {
      const why = isFactoryContext(cur.decl)
        ? "factory/DI boundary — real caller resolved at runtime"
        : "no static callers — possible dynamic dispatch, DI, or external/cross-service caller";
      localBlind.push(`${declLabel(cur.decl)} (${loc(cur.decl)}): ${why}`);
    }

    for (const caller of callers) {
      const id = nodeId(caller);
      const ek = entryKind(caller);
      const child = { decl: caller, depth: cur.depth + 1, parent: cur };
      if (ek) {
        entriesReached.add(ek);
        chains.push({ entry: ek, path: buildChain(child) });
        continue; // stop at the entry point
      }
      if (isFactoryContext(caller)) {
        localBlind.push(
          `factory boundary at ${declLabel(caller)} (${loc(caller)}) — downstream callers not statically resolvable`,
        );
      }
      if (!visited.has(id)) {
        visited.add(id);
        queue.push(child);
      }
    }
  }

  results.push({
    symbol: seedLabel,
    location: seedLoc,
    entriesReached: [...entriesReached],
    chains: chains.slice(0, 12),
    blindSpots: [...new Set(localBlind)].slice(0, 20),
    boundaries: dedupeBy(boundaries, (b) => b.loc + b.kind).slice(0, 20),
  });
}

function dedupeBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

// ---- render ----
const ENTRY_LABEL = {
  http_controller: "HTTP route (BaseController)",
  sqs_pubsub: "SQS consumer/producer (PubSub)",
};

function renderChain(ch) {
  const arrow = ch.path.map((p) => `\`${p.label}\` (${p.loc})`).join("  ⭠  ");
  return `- **${ENTRY_LABEL[ch.entry] || ch.entry}** ⭠ ${arrow}`;
}

let md = `# Impact map — touch points → entry points\n\n`;
md += `> Deterministic static backtrace (ts-morph). Read \`⭠\` as "is called by". This is grounding\n`;
md += `> for regression + design judgment, NOT a licence to comment on unchanged code.\n`;
md += `>\n`;
md += `> **Incomplete by construction:** DI/factory/interface boundaries and cross-service calls are\n`;
md += `> marked as ⚠️ blind spots — a missing edge does NOT mean "no impact". Caps: depth ${MAX_DEPTH},\n`;
md += `> ${MAX_CALLERS} callers/symbol, ${MAX_NODES} nodes.\n\n`;

if (!results.length) {
  md += `_No touched function/method declarations were resolved from the diff. The change may be\n`;
  md += `config/data-only, or the TS project failed to load — verify manually._\n`;
}

let totalEntries = new Set();
let totalBlind = 0;
for (const r of results) {
  md += `## \`${r.symbol}\` (${r.location}) — changed\n\n`;
  if (r.chains.length) {
    md += `**Reaches entry points:**\n`;
    for (const ch of r.chains) {
      md += renderChain(ch) + "\n";
      r.entriesReached.forEach((e) => totalEntries.add(e));
    }
    md += `\n`;
  } else {
    md += `**No entry point reached statically** (see blind spots below).\n\n`;
  }
  if (r.boundaries.length) {
    md += `**Boundary crossings** (trace stops here — check sibling-service MRs):\n`;
    for (const b of r.boundaries)
      md += `- ${b.kind}: \`${b.label}\` (${b.loc})\n`;
    md += `\n`;
  }
  if (r.blindSpots.length) {
    totalBlind += r.blindSpots.length;
    md += `**⚠️ Blind spots:**\n`;
    for (const b of r.blindSpots) md += `- ${b}\n`;
    md += `\n`;
  }
}

md += `## Summary\n`;
md += `- Touched symbols traced: ${results.length}\n`;
md += `- Entry-point types reached: ${[...totalEntries].map((e) => ENTRY_LABEL[e] || e).join(", ") || "none"}\n`;
md += `- Blind spots flagged: ${totalBlind}\n`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "impact-map.md"), md);
fs.writeFileSync(
  path.join(outDir, "impact-map.json"),
  JSON.stringify(
    {
      maxDepth: MAX_DEPTH,
      maxCallers: MAX_CALLERS,
      maxNodes: MAX_NODES,
      touched: results,
    },
    null,
    2,
  ),
);

console.log(
  `[impact] traced ${results.length} touched symbol(s); ` +
    `entry types: ${[...totalEntries].join(",") || "none"}; blind spots: ${totalBlind}. ` +
    `Wrote impact-map.md/json`,
);
