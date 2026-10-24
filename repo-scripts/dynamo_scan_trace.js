#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

// ---------- CONFIG ----------
const ROOT_DIR = process.cwd();
const SCAN_DIRS = ['src']; // add more if needed, e.g. ['src', 'apps']
const OUTPUT_CSV = path.join(ROOT_DIR, 'dynamo_scan_call_paths.csv');

const METHODS_OF_INTEREST = new Set([
    'fetchIndexedRecords', // may internally use Query/Scan depending on keys
    'getCount', // always uses Scan
]);

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.next', '.turbo']);

// ---------- HELPERS ----------

function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function walkDir(dir, files = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch (err) {
        console.warn(`Failed to read directory: ${dir}`, err.message);
        return files;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (EXCLUDE_DIRS.has(entry.name)) continue;
            if (entry.name === 'test' || entry.name === '__tests__') continue;
            walkDir(fullPath, files);
        } else {
            if (
                entry.name.endsWith('.js') ||
                entry.name.endsWith('.ts') ||
                entry.name.endsWith('.jsx') ||
                entry.name.endsWith('.tsx')
            ) {
                files.push(fullPath);
            }
        }
    }

    return files;
}

function getFileLines(code) {
    return code.split(/\r?\n/);
}

// ---------- GLOBAL STATE ----------

// fnId → { id, name, file_path, start_line, roleHint }
const functions = new Map();
// name → Set<fnId>
const nameToFnIds = new Map();
// fnId → Set<calleeName>  (temporary string-based edges)
const callEdgesByFnId = new Map();
// list of scan calls
const scanCalls = [];

// for giving unique ids
let fnCounter = 0;
let scanCounter = 0;

// ---------- FUNCTION REGISTRATION ----------

function getFunctionNameFromPath(fnPath, filePath) {
    const node = fnPath.node;

    // function foo() {}
    if (fnPath.isFunctionDeclaration() && node.id && node.id.name) {
        return node.id.name;
    }

    // const foo = () => {} / function() {}
    const parent = fnPath.parentPath;
    if (parent && parent.isVariableDeclarator()) {
        const id = parent.node.id;
        if (id && id.type === 'Identifier') {
            return id.name;
        }
    }

    // class MyService { foo() {} }
    if (fnPath.isClassMethod() || fnPath.isObjectMethod()) {
        const methodName = node.key && node.key.name ? node.key.name : null;
        let className = null;

        const classPath = fnPath.findParent(p => p.isClassDeclaration() || p.isClassExpression());
        if (classPath && classPath.node.id && classPath.node.id.name) {
            className = classPath.node.id.name;
        }

        if (className && methodName) {
            return `${className}.${methodName}`;
        }
        if (methodName) return methodName;
    }

    // fallback: anonymous@line
    const line = node.loc ? node.loc.start.line : 0;
    return `<anonymous@${line}>`;
}

function classifyRoleByFile(filePath) {
    const lower = filePath.toLowerCase();

    if (lower.includes('controller')) return 'controller';
    if (lower.includes('consumer')) return 'consumer';
    if (lower.includes('producer')) return 'producer';
    if (lower.includes('listener')) return 'listener';
    if (lower.includes('handler')) return 'handler';
    if (lower.includes('router')) return 'router';

    return 'unknown';
}

function registerFunction(fnPath, relPath) {
    const name = getFunctionNameFromPath(fnPath, relPath);
    const line = fnPath.node.loc ? fnPath.node.loc.start.line : 0;

    const fnId = `${relPath}::${name}::${line}::${++fnCounter}`;

    fnPath.node.__fnId = fnId;

    const roleHint = classifyRoleByFile(relPath);

    const info = {
        id: fnId,
        name,
        file_path: relPath,
        start_line: line,
        roleHint,
    };

    functions.set(fnId, info);

    if (name !== '<anonymous>' && !name.startsWith('<anonymous@')) {
        if (!nameToFnIds.has(name)) {
            nameToFnIds.set(name, new Set());
        }
        nameToFnIds.get(name).add(fnId);
    }

    return fnId;
}

function ensureModuleFunction(relPath, ast) {
    // pseudo "module root" function to attach top-level calls
    const moduleId = `${relPath}::<module>::0::module`;
    if (!functions.has(moduleId)) {
        const info = {
            id: moduleId,
            name: '<module>',
            file_path: relPath,
            start_line: 0,
            roleHint: classifyRoleByFile(relPath),
        };
        functions.set(moduleId, info);
    }
    return moduleId;
}

function addCallEdge(callerFnId, calleeName) {
    if (!callerFnId || !calleeName) return;
    if (!callEdgesByFnId.has(callerFnId)) {
        callEdgesByFnId.set(callerFnId, new Set());
    }
    callEdgesByFnId.get(callerFnId).add(calleeName);
}

// ---------- ANALYSIS PER FILE ----------

function analyzeFile(filePath) {
    const relPath = path.relative(ROOT_DIR, filePath);
    const code = fs.readFileSync(filePath, 'utf8');
    const lines = getFileLines(code);

    let ast;
    try {
        ast = parser.parse(code, {
            sourceType: 'unambiguous',
            plugins: ['typescript', 'jsx', 'classProperties', 'decorators-legacy'],
            errorRecovery: true,
        });
    } catch (err) {
        console.warn(`Failed to parse file: ${relPath}`, err.message);
        return;
    }

    const dynamoUtilsNames = new Set();

    // First pass: find imports of DynamoUtils
    traverse(ast, {
        Program(pathProgram) {
            for (const node of pathProgram.node.body) {
                if (node.type === 'ImportDeclaration') {
                    const sourceValue = node.source.value || '';
                    // heuristic: any import path ending with 'DynamoUtils' or having it
                    if (sourceValue.toLowerCase().includes('dynamoutils')) {
                        for (const s of node.specifiers) {
                            if (s.type === 'ImportSpecifier' && s.imported && s.imported.name === 'DynamoUtils') {
                                dynamoUtilsNames.add(s.local.name);
                            } else if (s.type === 'ImportDefaultSpecifier') {
                                dynamoUtilsNames.add(s.local.name);
                            } else if (s.type === 'ImportNamespaceSpecifier') {
                                // namespace import, e.g. import * as DynamoUtils from ...
                                dynamoUtilsNames.add(s.local.name);
                            }
                        }
                    }
                }
            }
        },
    });

    // Second pass: register functions & scan calls
    traverse(ast, {
        FunctionDeclaration(pathFn) {
            registerFunction(pathFn, relPath);
        },
        FunctionExpression(pathFn) {
            registerFunction(pathFn, relPath);
        },
        ArrowFunctionExpression(pathFn) {
            registerFunction(pathFn, relPath);
        },
        ClassMethod(pathFn) {
            registerFunction(pathFn, relPath);
        },
        ObjectMethod(pathFn) {
            registerFunction(pathFn, relPath);
        },
        CallExpression(pathNode) {
            const node = pathNode.node;
            const callee = node.callee;

            // Identify calling function (or module)
            let funcPath = pathNode.getFunctionParent();
            let callerFnId = null;
            if (funcPath && funcPath.node.__fnId) {
                callerFnId = funcPath.node.__fnId;
            } else if (funcPath) {
                // function not registered yet (rare), register now
                callerFnId = registerFunction(funcPath, relPath);
            } else {
                // top-level call
                callerFnId = ensureModuleFunction(relPath, ast);
            }

            // ----- Detect DynamoUtils.* calls -----
            if (callee && callee.type === 'MemberExpression') {
                const obj = callee.object;
                const prop = callee.property;

                if (obj && obj.type === 'Identifier' && dynamoUtilsNames.has(obj.name)) {
                    if (prop && prop.type === 'Identifier') {
                        const methodName = prop.name;
                        if (METHODS_OF_INTEREST.has(methodName)) {
                            const line = node.loc ? node.loc.start.line : 0;
                            const accessorInfo = functions.get(callerFnId);

                            scanCalls.push({
                                id: ++scanCounter,
                                dynamo_method: methodName,
                                dynamo_file: relPath,
                                dynamo_line: line,
                                accessor_fn_id: callerFnId,
                                accessor_fn_name: accessorInfo ? accessorInfo.name : '<unknown>',
                                accessor_file: accessorInfo ? accessorInfo.file_path : relPath,
                            });
                        }
                    }
                }
            }

            // ----- Build generic call edges (for call graph) -----
            let calleeName = null;

            if (callee.type === 'Identifier') {
                calleeName = callee.name;
            } else if (callee.type === 'MemberExpression') {
                // foo.bar() → treat "bar" as callee name
                if (callee.property && callee.property.type === 'Identifier') {
                    calleeName = callee.property.name;
                }
            }

            if (calleeName) {
                addCallEdge(callerFnId, calleeName);
            }
        },
    });

    // Ensure module root exists if no functions were found but we had scan calls
    if (scanCalls.some(c => c.dynamo_file === relPath)) {
        ensureModuleFunction(relPath, ast);
    }
}

// ---------- BUILD CALL GRAPH (fnId → fnId) ----------

function buildGraph() {
    const graph = new Map(); // fnId -> Set<fnId>
    const reverseGraph = new Map(); // fnId -> Set<fnId>

    for (const [callerFnId, calleeNames] of callEdgesByFnId.entries()) {
        for (const calleeName of calleeNames) {
            const targetFnIds = nameToFnIds.get(calleeName);
            if (!targetFnIds) continue;

            for (const targetFnId of targetFnIds) {
                if (targetFnId === callerFnId) continue;

                if (!graph.has(callerFnId)) graph.set(callerFnId, new Set());
                graph.get(callerFnId).add(targetFnId);

                if (!reverseGraph.has(targetFnId)) reverseGraph.set(targetFnId, new Set());
                reverseGraph.get(targetFnId).add(callerFnId);
            }
        }
    }

    return {graph, reverseGraph};
}

function isEntryFunction(fnId, reverseGraph) {
    const info = functions.get(fnId);
    if (!info) return {isEntry: false, role: 'unknown'};

    let role = info.roleHint || 'unknown';
    let isEntry = false;

    if (['controller', 'consumer', 'producer', 'listener', 'router'].includes(role)) {
        isEntry = true;
    }

    // If nothing calls this function, treat as entry/root as well
    if (!reverseGraph.has(fnId) || reverseGraph.get(fnId).size === 0) {
        if (!isEntry) role = role === 'unknown' ? 'root' : role;
        isEntry = true;
    }

    return {isEntry, role};
}

// BFS upwards from accessor to entry functions
function findEntryPaths(accessorFnId, reverseGraph, maxDepth = 8, maxPaths = 10) {
    const paths = [];
    const queue = [];
    const visited = new Set();

    queue.push({fnId: accessorFnId, path: [accessorFnId], depth: 0});
    visited.add(accessorFnId);

    while (queue.length && paths.length < maxPaths) {
        const {fnId, path, depth} = queue.shift();

        const {isEntry, role} = isEntryFunction(fnId, reverseGraph);
        if (isEntry) {
            paths.push({
                fnIds: path.slice().reverse(), // root → ... → accessor
                entryRole: role,
            });
            // don't necessarily stop here; there might be higher-level callers
            // but we limit by maxPaths and maxDepth anyway
        }

        if (depth >= maxDepth) continue;

        const callers = reverseGraph.get(fnId);
        if (!callers || callers.size === 0) continue;

        for (const callerId of callers) {
            if (visited.has(callerId)) continue;
            visited.add(callerId);
            queue.push({
                fnId: callerId,
                path: [...path, callerId],
                depth: depth + 1,
            });
        }
    }

    // If nothing found, at least return accessor itself as a "root"
    if (paths.length === 0) {
        const info = functions.get(accessorFnId);
        const fallbackRole = info ? info.roleHint || 'unknown' : 'unknown';
        paths.push({
            fnIds: [accessorFnId],
            entryRole: fallbackRole || 'unknown',
        });
    }

    return paths;
}

// ---------- CSV OUTPUT ----------

function toCsvRows(scanCalls, graph, reverseGraph) {
    const headers = [
        'scan_id',
        'dynamo_method',
        'dynamo_file',
        'dynamo_line',
        'accessor_function',
        'accessor_file',
        'entry_function',
        'entry_role',
        'entry_file',
        'call_chain',
    ];

    const rows = [headers.map(csvEscape).join(',')];

    for (const scan of scanCalls) {
        const accessorFnId = scan.accessor_fn_id;
        const accessorInfo = functions.get(accessorFnId);

        const paths = findEntryPaths(accessorFnId, reverseGraph, 8, 10);

        for (const p of paths) {
            const fnIds = p.fnIds;
            const entryFnId = fnIds[0];
            const entryInfo = functions.get(entryFnId);

            const chainNames = fnIds
                .map(id => {
                    const info = functions.get(id);
                    if (!info) return id;
                    return `${info.name} (${info.file_path})`;
                })
                .join(' -> ');

            const row = [
                scan.id,
                scan.dynamo_method,
                scan.dynamo_file,
                scan.dynamo_line,
                accessorInfo ? accessorInfo.name : scan.accessor_fn_name,
                accessorInfo ? accessorInfo.file_path : scan.accessor_file,
                entryInfo ? entryInfo.name : '<unknown>',
                p.entryRole,
                entryInfo ? entryInfo.file_path : '<unknown>',
                `${chainNames} -> DynamoUtils.${scan.dynamo_method}`,
            ].map(csvEscape);

            rows.push(row.join(','));
        }
    }

    return rows.join('\n');
}

// ---------- MAIN ----------

function main() {
    console.log('Dynamo scan backtrace audit started...');

    const allFiles = [];
    for (const dir of SCAN_DIRS) {
        const full = path.join(ROOT_DIR, dir);
        if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
            walkDir(full, allFiles);
        }
    }

    console.log(`Scanning ${allFiles.length} files...`);

    for (const file of allFiles) {
        analyzeFile(file);
    }

    console.log(`Found ${scanCalls.length} DynamoUtils scan-risk calls.`);

    const {graph, reverseGraph} = buildGraph();

    const csv = toCsvRows(scanCalls, graph, reverseGraph);
    fs.writeFileSync(OUTPUT_CSV, csv, 'utf8');

    console.log(`Dynamo scan backtrace audit completed.`);
    console.log(`Output written to: ${OUTPUT_CSV}`);
}

main();
