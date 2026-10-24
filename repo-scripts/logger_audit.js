#!/usr/bin/env node
/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const ROOT_DIR = process.cwd();
const SCAN_DIRS = ['src']; // add more if needed
const OUTPUT_CSV = path.join(ROOT_DIR, 'logger_audit.csv');

const LOOP_NODE_TYPES = new Set([
    'ForStatement',
    'ForInStatement',
    'ForOfStatement',
    'WhileStatement',
    'DoWhileStatement',
]);

const PII_KEYWORDS = ['password', 'secret', 'token', 'authorization', 'auth', 'otp', 'ssn', 'pan', 'aadhar', 'aadhaar'];

const REQUEST_KEYS = ['request', 'req', 'payload', 'body', 'headers'];
const RESPONSE_KEYS = ['response', 'res', 'result', 'data'];

const EXCLUDE_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git', '.next', '.turbo']);

/**
 * Simple CSV escape
 */
function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * Recursively walk directories and return file paths (js/ts/tsx)
 */
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

/**
 * Heuristic: is file a test file?
 */
function isTestFile(filePath) {
    return (
        filePath.includes('__tests__') ||
        filePath.includes('/test/') ||
        /\.test\./.test(filePath) ||
        /\.spec\./.test(filePath)
    );
}

/**
 * Get function/method name for a node path
 */
function getFunctionName(pathNode) {
    const funcPath = pathNode.findParent(
        p => p.isFunctionDeclaration() || p.isFunctionExpression() || p.isArrowFunctionExpression() || p.isClassMethod()
    );

    if (!funcPath) return '<top-level>';

    const node = funcPath.node;

    if (node.id && node.id.name) {
        return node.id.name;
    }

    if (funcPath.isClassMethod() && node.key && node.key.name) {
        return node.key.name;
    }

    // Look for variable declarator: const foo = () => {}
    const parentPath = funcPath.parentPath;
    if (parentPath && parentPath.isVariableDeclarator()) {
        const id = parentPath.node.id;
        if (id && id.name) {
            return id.name;
        }
    }

    return '<anonymous>';
}

/**
 * Heuristic: is inside loop?
 */
function isInLoop(pathNode) {
    const loopPath = pathNode.findParent(p => LOOP_NODE_TYPES.has(p.node.type));
    if (loopPath) return true;

    // also treat obvious .forEach/.map as "loop-ish"
    const callParent = pathNode.findParent(p => p.isCallExpression());
    if (callParent && callParent.node.callee && callParent.node.callee.type === 'MemberExpression') {
        const prop = callParent.node.callee.property;
        if (prop && prop.type === 'Identifier') {
            if (['forEach', 'map', 'filter'].includes(prop.name)) return true;
        }
    }
    return false;
}

/**
 * Get source code lines for a file
 */
function getFileLines(code) {
    return code.split(/\r?\n/);
}

/**
 * Extract source snippet for a node using lines
 */
function expressionToSource(node, lines) {
    if (!node.loc || !lines) return '';
    const startLine = node.loc.start.line - 1;
    const endLine = node.loc.end.line - 1;
    if (startLine < 0 || endLine >= lines.length) return '';
    const slice = lines.slice(startLine, endLine + 1);
    return slice.join('\n').trim();
}

/**
 * Extract (best-effort) string content for a logger message expression.
 * Handles:
 *  - StringLiteral
 *  - TemplateLiteral
 *  - ParenthesizedExpression
 *  - BinaryExpression composed of string-like pieces
 */
function extractLogMessageFromArg(node, lines) {
    if (!node) return null;

    switch (node.type) {
        case 'StringLiteral':
            return node.value;

        case 'TemplateLiteral': {
            const parts = [];
            node.quasis.forEach((q, i) => {
                parts.push(q.value.cooked || '');
                if (i < node.expressions.length) {
                    // placeholder marker for expressions in template
                    parts.push('${expr}');
                }
            });
            return parts.join('');
        }

        case 'ParenthesizedExpression':
            return extractLogMessageFromArg(node.expression, lines);

        case 'BinaryExpression': {
            // try to concatenate left and right string-ish parts
            const left = extractLogMessageFromArg(node.left, lines);
            const right = extractLogMessageFromArg(node.right, lines);

            if (left === null && right === null) {
                return null;
            }

            const leftPart = left !== null ? left : '${expr}';
            const rightPart = right !== null ? right : '${expr}';

            return leftPart + rightPart;
        }

        default:
            // unsupported / dynamic expression
            return null;
    }
}

/**
 * Heuristic: look ahead a few lines after the log to see if we call serviceCaller
 */
function looksLikePreApiCall(lines, startLine, logMessage) {
    const lowerMsg = (logMessage || '').toLowerCase();
    const interesting =
        REQUEST_KEYS.some(k => lowerMsg.includes(k)) ||
        lowerMsg.includes('calling') ||
        lowerMsg.includes('invoking') ||
        lowerMsg.includes('request');

    if (!interesting) return false;

    const maxLookahead = 10;
    for (let i = startLine; i < Math.min(lines.length, startLine + maxLookahead); i++) {
        const line = lines[i].toLowerCase();
        if (line.includes('servicecaller')) {
            return true;
        }
    }
    return false;
}

/**
 * Flags for top-level handler heuristics
 */
function isTopLevelHandler(filePath, functionName) {
    const lowerPath = filePath.toLowerCase();
    const lowerFn = (functionName || '').toLowerCase();

    if (
        lowerPath.includes('controller') ||
        lowerPath.includes('handler') ||
        lowerPath.includes('route') ||
        lowerPath.includes('router') ||
        lowerPath.includes('consumer') ||
        lowerPath.includes('worker') ||
        lowerPath.includes('listener')
    ) {
        return true;
    }

    if (
        lowerFn.includes('handler') ||
        lowerFn.includes('handle') ||
        lowerFn.includes('controller') ||
        lowerFn.includes('process') ||
        lowerFn.includes('consume') ||
        lowerFn.includes('worker')
    ) {
        return true;
    }

    return false;
}

function stringIncludesAny(str, list) {
    const lower = (str || '').toLowerCase();
    return list.some(k => lower.includes(k));
}

/**
 * Detect JSON.stringify or *.stringify in a node subtree
 */
function containsStringify(node) {
    if (!node) return false;

    const stack = [node];

    while (stack.length) {
        const current = stack.pop();

        if (!current || typeof current !== 'object') continue;

        if (current.type === 'CallExpression') {
            const callee = current.callee;

            if (callee.type === 'MemberExpression') {
                const obj = callee.object;
                const prop = callee.property;

                if (
                    obj &&
                    obj.type === 'Identifier' &&
                    obj.name === 'JSON' &&
                    prop &&
                    prop.type === 'Identifier' &&
                    prop.name === 'stringify'
                ) {
                    return true;
                }

                if (prop && prop.type === 'Identifier' && prop.name === 'stringify') {
                    // any .stringify(...)
                    return true;
                }
            } else if (callee.type === 'Identifier' && callee.name === 'stringify') {
                return true;
            }
        }

        for (const key of Object.keys(current)) {
            const value = current[key];
            if (Array.isArray(value)) {
                value.forEach(v => stack.push(v));
            } else if (value && typeof value === 'object') {
                stack.push(value);
            }
        }
    }

    return false;
}

/**
 * Determine log_rank and candidate flags
 */
function computeRankAndRemovalFlags(entry) {
    let rank = 3;

    const level = (entry.log_level || '').toLowerCase();
    const msg = (entry.log_message || '').toLowerCase();

    if (entry.is_invalid_message) {
        rank = 1;
    }

    if (level === 'error' || level === 'warn') {
        rank += 2;
    } else if (level === 'debug') {
        rank -= 1;
    }

    if (stringIncludesAny(msg, ['failed', 'failure', 'exception', 'error', 'retry', 'critical', 'timeout'])) {
        rank += 1;
    }

    if (msg.length < 10) {
        rank -= 1;
    }

    if (entry.in_loop) {
        rank -= 1;
    }

    if (entry.is_very_verbose_metadata) {
        rank -= 1;
    }

    if (entry.looks_like_pre_api_call_log) {
        rank -= 1;
    }

    if (entry.is_duplicate_message && level === 'debug') {
        rank -= 1;
    }

    if (rank > 5) rank = 5;
    if (rank < 1) rank = 1;

    // overwrite rank for stringify-based logs → worst
    if (entry.has_stringify_in_args) {
        rank = 1;
    }

    // candidate for removal
    const isCandidate =
        rank <= 2 ||
        entry.is_invalid_message ||
        entry.looks_like_pre_api_call_log ||
        entry.has_stringify_in_args ||
        (level === 'debug' && !entry.is_top_level_handler && !entry.likely_entry_log && !entry.likely_exit_log);

    entry.log_rank = rank;
    entry.is_candidate_for_removal = isCandidate;
}

/**
 * Main analysis for one file
 */
function analyzeFile(filePath) {
    const relPath = path.relative(ROOT_DIR, filePath);
    const code = fs.readFileSync(filePath, 'utf8');
    const lines = getFileLines(code);
    const logs = [];

    let ast;
    try {
        ast = parser.parse(code, {
            sourceType: 'unambiguous',
            plugins: ['typescript', 'jsx', 'classProperties', 'decorators-legacy'],
            errorRecovery: true,
        });
    } catch (err) {
        console.warn(`Failed to parse file: ${relPath}`, err.message);
        return logs;
    }

    traverse(ast, {
        CallExpression(pathNode) {
            const callee = pathNode.node.callee;

            if (!callee || callee.type !== 'MemberExpression') return;
            const obj = callee.object;
            const prop = callee.property;

            if (!obj || obj.type !== 'Identifier' || obj.name !== 'logger') return;
            if (!prop || prop.type !== 'Identifier') return;

            const logLevel = prop.name;
            const args = pathNode.node.arguments || [];

            const firstArg = args[0];
            const secondArg = args[1];

            let logMessage = null;
            let isInvalidMessage = false;

            if (!firstArg) {
                isInvalidMessage = true;
            } else {
                const extracted = extractLogMessageFromArg(firstArg, lines);
                if (extracted !== null) {
                    logMessage = extracted;
                    if (!logMessage || logMessage.trim() === '') {
                        isInvalidMessage = true;
                    }
                } else {
                    // complex/dynamic expression: capture snippet but mark invalid
                    logMessage = expressionToSource(firstArg, lines);
                    if (!logMessage || logMessage.trim() === '') {
                        isInvalidMessage = true;
                    } else {
                        isInvalidMessage = true; // message exists but not a simple literal
                    }
                }
            }

            let metadataKeys = [];
            if (secondArg && secondArg.type === 'ObjectExpression') {
                metadataKeys = secondArg.properties
                    .filter(p => p.key && (p.key.name || p.key.value))
                    .map(p => p.key.name || p.key.value);
            }

            const hasRequestPayload = metadataKeys.some(k => REQUEST_KEYS.includes(String(k)));
            const hasResponsePayload = metadataKeys.some(k => RESPONSE_KEYS.includes(String(k)));

            const containsPiiLikeKeys =
                metadataKeys.some(k => stringIncludesAny(String(k), PII_KEYWORDS)) ||
                stringIncludesAny(logMessage || '', PII_KEYWORDS);

            const inLoop = isInLoop(pathNode);
            const functionName = getFunctionName(pathNode);
            const lineNumber = pathNode.node.loc ? pathNode.node.loc.start.line : null;
            const inTest = isTestFile(relPath);

            const isVeryVerboseMetadata = metadataKeys.length > 5;
            const isVeryLongMessage = (logMessage || '').length > 120;

            const likelyEntryLog = stringIncludesAny(logMessage || '', [
                'start',
                'starting',
                'received',
                'incoming',
                'handle',
                'handling',
                'begin',
            ]);
            const likelyExitLog = stringIncludesAny(logMessage || '', [
                'completed',
                'finished',
                'done',
                'responding',
                'success',
                'successful',
            ]);

            const isTopLevel = isTopLevelHandler(relPath, functionName);
            const looksPreApi = looksLikePreApiCall(lines, (lineNumber || 1) - 1, logMessage);
            const isErrorWithoutContext = (logLevel === 'error' || logLevel === 'warn') && metadataKeys.length === 0;

            const hasStringifyInArgs = containsStringify(pathNode.node);

            const entry = {
                file_path: relPath,
                line_number: lineNumber,
                function_or_method: functionName,
                log_level: logLevel,
                log_message: logMessage || '',
                is_invalid_message: isInvalidMessage,
                metadata_keys: metadataKeys,
                has_request_payload: hasRequestPayload,
                has_response_payload: hasResponsePayload,
                in_test_file: inTest,
                in_loop: inLoop,
                contains_pii_like_keys: containsPiiLikeKeys,
                is_very_verbose_metadata: isVeryVerboseMetadata,
                is_very_long_message: isVeryLongMessage,
                looks_like_pre_api_call_log: looksPreApi,
                is_top_level_handler: isTopLevel,
                likely_entry_log: likelyEntryLog,
                likely_exit_log: likelyExitLog,
                suspicious_pii_log: containsPiiLikeKeys,
                is_error_without_context: isErrorWithoutContext,
                has_stringify_in_args: hasStringifyInArgs,
                // filled later:
                is_duplicate_message: false,
                total_occurrences_for_message: 0,
                unique_files_for_message: 0,
                log_rank: 0,
                is_candidate_for_removal: false,
            };

            logs.push(entry);
        },
    });

    return logs;
}

/**
 * Deduplicate by log_message and compute occurrence stats
 */
function annotateDuplicates(entries) {
    const byMessage = new Map();

    for (const entry of entries) {
        const key = entry.log_message || '<null-message>';
        if (!byMessage.has(key)) {
            byMessage.set(key, {
                occurrences: 0,
                files: new Set(),
            });
        }
        const stats = byMessage.get(key);
        stats.occurrences += 1;
        stats.files.add(entry.file_path);
    }

    for (const entry of entries) {
        const key = entry.log_message || '<null-message>';
        const stats = byMessage.get(key);
        entry.total_occurrences_for_message = stats.occurrences;
        entry.unique_files_for_message = stats.files.size;
        entry.is_duplicate_message = stats.occurrences > 1;
    }
}

/**
 * Convert entries to CSV string
 */
function toCsv(entries) {
    const headers = [
        'file_path',
        'line_number',
        'function_or_method',
        'log_level',
        'log_message',
        'is_invalid_message',
        'metadata_keys',
        'has_request_payload',
        'has_response_payload',
        'in_test_file',
        'in_loop',
        'contains_pii_like_keys',
        'is_duplicate_message',
        'total_occurrences_for_message',
        'unique_files_for_message',
        'looks_like_pre_api_call_log',
        'is_very_verbose_metadata',
        'is_very_long_message',
        'has_stringify_in_args',
        'is_candidate_for_removal',
        'is_top_level_handler',
        'likely_entry_log',
        'likely_exit_log',
        'suspicious_pii_log',
        'is_error_without_context',
        'log_rank',
    ];

    const rows = [headers.map(csvEscape).join(',')];

    for (const e of entries) {
        const row = [
            e.file_path,
            e.line_number,
            e.function_or_method,
            e.log_level,
            e.log_message,
            e.is_invalid_message,
            (e.metadata_keys || []).join(';'),
            e.has_request_payload,
            e.has_response_payload,
            e.in_test_file,
            e.in_loop,
            e.contains_pii_like_keys,
            e.is_duplicate_message,
            e.total_occurrences_for_message,
            e.unique_files_for_message,
            e.looks_like_pre_api_call_log,
            e.is_very_verbose_metadata,
            e.is_very_long_message,
            e.has_stringify_in_args,
            e.is_candidate_for_removal,
            e.is_top_level_handler,
            e.likely_entry_log,
            e.likely_exit_log,
            e.suspicious_pii_log,
            e.is_error_without_context,
            e.log_rank,
        ].map(csvEscape);
        rows.push(row.join(','));
    }

    return rows.join('\n');
}

/**
 * MAIN
 */
function main() {
    console.log('Logger audit started...');
    const allFiles = [];

    for (const dir of SCAN_DIRS) {
        const full = path.join(ROOT_DIR, dir);
        if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
            walkDir(full, allFiles);
        }
    }

    console.log(`Scanning ${allFiles.length} files...`);

    let allEntries = [];
    for (const file of allFiles) {
        const entries = analyzeFile(file);
        allEntries = allEntries.concat(entries);
    }

    console.log(`Found ${allEntries.length} logger calls.`);

    annotateDuplicates(allEntries);

    for (const entry of allEntries) {
        computeRankAndRemovalFlags(entry);
    }

    const csv = toCsv(allEntries);
    fs.writeFileSync(OUTPUT_CSV, csv, 'utf8');

    console.log(`Logger audit completed. Output written to: ${OUTPUT_CSV}`);
}

main();
