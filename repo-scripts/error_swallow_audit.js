#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

// ------------ CONFIG ------------

const ROOT_DIR = process.cwd();
const SCAN_DIRS = ['src']; // add more as needed
const OUTPUT_CSV = path.join(ROOT_DIR, 'error_swallow_audit.csv');

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.next', '.turbo']);

// names considered logger-ish (extend if needed)
const LOGGER_IDENTIFIERS = new Set(['logger', 'log', 'console']);

// ------------ HELPERS ------------

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

function getFunctionNameFromPath(fnPath) {
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
    if (lower.includes('service')) return 'service';
    if (lower.includes('repo') || lower.includes('repository')) return 'repository';
    return 'unknown';
}

function isLoggerCall(node) {
    // logger.error(...), logger.info(...), console.error(...), log.error(...)
    if (node.type !== 'CallExpression') return false;
    const callee = node.callee;

    if (callee.type === 'MemberExpression') {
        const obj = callee.object;
        if (obj.type === 'Identifier' && LOGGER_IDENTIFIERS.has(obj.name)) {
            return true;
        }
    } else if (callee.type === 'Identifier') {
        // plain 'log(...)' if you ever use that
        if (LOGGER_IDENTIFIERS.has(callee.name)) return true;
    }

    return false;
}

function hasIstanbulIgnore(comments) {
    if (!comments || !comments.length) return false;
    return comments.some(c => {
        const txt = (c.value || '').toLowerCase();
        return txt.includes('istanbul ignore');
    });
}

// Analyze catch block body for swallowing behaviour
function analyzeCatchBody(catchBodyNodes, catchParamName) {
    let hasThrow = false;
    let hasRethrow = false; // throw e; throw err;
    let hasReturn = false;
    let hasLogger = false;
    let hasOtherStatements = false;
    let hasIstanbulIgnoreNext = false;

    for (const stmt of catchBodyNodes) {
        if (stmt.leadingComments && hasIstanbulIgnore(stmt.leadingComments)) {
            hasIstanbulIgnoreNext = true;
        }

        if (stmt.type === 'ThrowStatement') {
            hasThrow = true;
            if (
                catchParamName &&
                stmt.argument &&
                stmt.argument.type === 'Identifier' &&
                stmt.argument.name === catchParamName
            ) {
                hasRethrow = true;
            }
            hasOtherStatements = true;
            continue;
        }

        if (stmt.type === 'ReturnStatement') {
            hasReturn = true;
            hasOtherStatements = true;
            continue;
        }

        if (stmt.type === 'ExpressionStatement' && stmt.expression) {
            if (isLoggerCall(stmt.expression)) {
                hasLogger = true;
                // don't mark as "other" yet, logger-only catch is what we want to detect
                continue;
            }
        }

        // anything else is "other"
        hasOtherStatements = true;
    }

    const isEmpty = catchBodyNodes.length === 0;
    const loggerOnly = hasLogger && !hasThrow && !hasReturn && !hasOtherStatements;

    // suspicion rules:
    // - completely empty
    // - logger-only (like your example)
    // - has istanbul ignore & only logger
    const suspectedSwallow = isEmpty || loggerOnly || (loggerOnly && hasIstanbulIgnoreNext);

    return {
        hasThrow,
        hasRethrow,
        hasReturn,
        hasLogger,
        hasOtherStatements,
        hasIstanbulIgnoreNext,
        isEmpty,
        loggerOnly,
        suspectedSwallow,
    };
}

// Analyze a "catch handler function" body for Promise.catch(...)
function analyzeCatchFunctionBody(fnNode, catchParamName) {
    const body = fnNode.body && fnNode.body.type === 'BlockStatement' ? fnNode.body.body : [];

    return analyzeCatchBody(body, catchParamName);
}

// ------------ MAIN ANALYSIS ------------

function analyzeFile(filePath, findings) {
    const relPath = path.relative(ROOT_DIR, filePath);
    const code = fs.readFileSync(filePath, 'utf8');

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

    const roleHint = classifyRoleByFile(relPath);

    traverse(ast, {
        // try { ... } catch (e) { ... }
        TryStatement(pathNode) {
            const node = pathNode.node;
            const handler = node.handler;
            if (!handler) return;

            const param = handler.param;
            const catchParamName = param && param.type === 'Identifier' ? param.name : null;
            const bodyNodes = handler.body && handler.body.body ? handler.body.body : [];

            const {
                hasThrow,
                hasRethrow,
                hasReturn,
                hasLogger,
                hasOtherStatements,
                hasIstanbulIgnoreNext,
                isEmpty,
                loggerOnly,
                suspectedSwallow,
            } = analyzeCatchBody(bodyNodes, catchParamName);

            const funcPath = pathNode.getFunctionParent();
            const functionName = funcPath ? getFunctionNameFromPath(funcPath) : '<module>';
            const fnRoleHint = funcPath ? roleHint : roleHint;
            const line = handler.loc ? handler.loc.start.line : node.loc ? node.loc.start.line : 0;

            findings.push({
                kind: 'try-catch',
                file_path: relPath,
                role_hint: fnRoleHint,
                function_name: functionName,
                catch_param: catchParamName || '',
                line_number: line,
                has_throw: hasThrow,
                has_rethrow: hasRethrow,
                has_return: hasReturn,
                has_logger: hasLogger,
                has_other_statements: hasOtherStatements,
                has_istanbul_ignore: hasIstanbulIgnoreNext,
                is_empty_catch: isEmpty,
                is_logger_only: loggerOnly,
                suspected_swallow: suspectedSwallow,
            });
        },

        // Promise.catch(e => { ... }) / .catch(function(e) { ... })
        CallExpression(pathNode) {
            const node = pathNode.node;
            const callee = node.callee;

            if (
                callee.type === 'MemberExpression' &&
                callee.property &&
                callee.property.type === 'Identifier' &&
                callee.property.name === 'catch'
            ) {
                const handlerFn = node.arguments[0];
                if (
                    !handlerFn ||
                    !(handlerFn.type === 'ArrowFunctionExpression' || handlerFn.type === 'FunctionExpression')
                ) {
                    return;
                }

                const param = handlerFn.params[0];
                const catchParamName = param && param.type === 'Identifier' ? param.name : null;

                const {
                    hasThrow,
                    hasRethrow,
                    hasReturn,
                    hasLogger,
                    hasOtherStatements,
                    hasIstanbulIgnoreNext,
                    isEmpty,
                    loggerOnly,
                    suspectedSwallow,
                } = analyzeCatchFunctionBody(handlerFn, catchParamName);

                const funcPath = pathNode.getFunctionParent();
                const functionName = funcPath ? getFunctionNameFromPath(funcPath) : '<module>';
                const fnRoleHint = funcPath ? roleHint : roleHint;
                const line = handlerFn.loc ? handlerFn.loc.start.line : node.loc ? node.loc.start.line : 0;

                findings.push({
                    kind: 'promise-catch',
                    file_path: relPath,
                    role_hint: fnRoleHint,
                    function_name: functionName,
                    catch_param: catchParamName || '',
                    line_number: line,
                    has_throw: hasThrow,
                    has_rethrow: hasRethrow,
                    has_return: hasReturn,
                    has_logger: hasLogger,
                    has_other_statements: hasOtherStatements,
                    has_istanbul_ignore: hasIstanbulIgnoreNext,
                    is_empty_catch: isEmpty,
                    is_logger_only: loggerOnly,
                    suspected_swallow: suspectedSwallow,
                });
            }
        },
    });
}

// ------------ CSV OUTPUT ------------

function toCsv(findings) {
    const headers = [
        'kind',
        'file_path',
        'role_hint',
        'function_name',
        'catch_param',
        'line_number',
        'has_throw',
        'has_rethrow',
        'has_return',
        'has_logger',
        'has_other_statements',
        'has_istanbul_ignore',
        'is_empty_catch',
        'is_logger_only',
        'suspected_swallow',
    ];

    const rows = [headers.map(csvEscape).join(',')];

    for (const f of findings) {
        const row = [
            f.kind,
            f.file_path,
            f.role_hint,
            f.function_name,
            f.catch_param,
            f.line_number,
            f.has_throw,
            f.has_rethrow,
            f.has_return,
            f.has_logger,
            f.has_other_statements,
            f.has_istanbul_ignore,
            f.is_empty_catch,
            f.is_logger_only,
            f.suspected_swallow,
        ].map(csvEscape);

        rows.push(row.join(','));
    }

    return rows.join('\n');
}

// ------------ MAIN ------------

function main() {
    console.log('Error swallowing audit started...');
    const allFiles = [];

    for (const dir of SCAN_DIRS) {
        const full = path.join(ROOT_DIR, dir);
        if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
            walkDir(full, allFiles);
        }
    }

    console.log(`Scanning ${allFiles.length} files...`);

    const findings = [];

    for (const file of allFiles) {
        analyzeFile(file, findings);
    }

    console.log(`Found ${findings.length} catch handlers.`);

    const csv = toCsv(findings);
    fs.writeFileSync(OUTPUT_CSV, csv, 'utf8');

    console.log(`Error swallowing audit completed.`);
    console.log(`Output written to: ${OUTPUT_CSV}`);
}

main();
