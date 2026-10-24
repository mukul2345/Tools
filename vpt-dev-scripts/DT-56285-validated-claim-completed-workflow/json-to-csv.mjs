/**
 * DT-56285: Convert the component-status-enriched JSON buckets back to CSV.
 *
 * Purely local. No network, no prod access. Source JSON left untouched.
 *
 * Input:  input-files/split-with-component-status/*.json
 * Output: input-files/split-final-csv/*.csv
 *         one CSV per bucket, same filenames with a .csv extension, plus
 *         _all-buckets.csv containing every row for when you want one sheet.
 *
 * Usage:
 *   node json-to-csv.mjs                              # all buckets
 *   node json-to-csv.mjs VALIDATED__COMPLETED.json    # one bucket
 *   node json-to-csv.mjs --from input-files/split     # convert a different folder
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INPUT_DIR = path.join(SCRIPT_DIR, 'input-files', 'split-with-component-status');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'input-files', 'split-final-csv');

// The columns most people open these files to look at, pulled to the front.
// Anything not listed keeps its original order after these.
const LEADING_COLUMNS = [
    'claimItemId',
    'claimStatus',
    'componentStatus',
    'recoveredClaimStatus',
    'isRecoverable',
    'currentStage',
    'workflowState',
    'caseId',
    'claimWorkflowId',
    'componentId',
    'componentTypeId',
];

function parseFromDir() {
    const idx = process.argv.indexOf('--from');
    if (idx === -1) return DEFAULT_INPUT_DIR;

    const value = process.argv[idx + 1];
    if (!value || value.startsWith('--')) {
        console.error('--from needs a folder, e.g. --from input-files/split');
        process.exit(1);
    }
    return path.resolve(SCRIPT_DIR, value);
}

/**
 * Serialises one value into a CSV cell.
 *
 * null and undefined become an empty cell rather than the strings "null"/"undefined",
 * so a spreadsheet shows a blank. Arrays and objects are JSON-encoded rather than
 * stringified, because "[object Object]" is worse than useless.
 */
function toCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value) || typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

/**
 * Quotes a cell when it could otherwise break the row: commas, quotes, newlines,
 * and leading/trailing whitespace that a reader would silently trim. Internal
 * quotes are doubled, per RFC 4180.
 */
function escapeCell(raw) {
    const needsQuoting = /[",\r\n]/.test(raw) || raw !== raw.trim();
    if (!needsQuoting) return raw;
    return `"${raw.replace(/"/g, '""')}"`;
}

function buildColumnOrder(rows) {
    const present = new Set();
    for (const row of rows) {
        for (const key of Object.keys(row)) present.add(key);
    }

    const ordered = LEADING_COLUMNS.filter((c) => present.has(c));
    const seen = new Set(ordered);

    // Preserve the original field order for everything else, taken from the first
    // row rather than from Set iteration, so output column order is stable.
    for (const row of rows) {
        for (const key of Object.keys(row)) {
            if (!seen.has(key)) {
                ordered.push(key);
                seen.add(key);
            }
        }
    }

    return ordered;
}

function toCsv(rows) {
    if (rows.length === 0) return '';

    const columns = buildColumnOrder(rows);
    const lines = [columns.map((c) => escapeCell(c)).join(',')];

    for (const row of rows) {
        lines.push(columns.map((c) => escapeCell(toCell(row[c]))).join(','));
    }

    // Trailing newline so the file ends cleanly and `wc -l` matches row count + 1.
    return lines.join('\n') + '\n';
}

function main() {
    const inputDir = parseFromDir();

    if (!fs.existsSync(inputDir)) {
        console.error(`Not found: ${inputDir}`);
        console.error('Run add-component-status.mjs first.');
        process.exit(1);
    }

    const named = process.argv
        .slice(2)
        .filter((arg) => !arg.startsWith('--'))
        .filter((arg) => arg !== path.relative(SCRIPT_DIR, inputDir));

    const candidates = named.length
        ? named.map((arg) => path.basename(arg))
        : fs
              .readdirSync(inputDir)
              .filter((f) => f.endsWith('.json') && f !== '_summary.json')
              .sort();

    const missing = candidates.filter((f) => !fs.existsSync(path.join(inputDir, f)));
    if (missing.length > 0) {
        console.error(`Not found in ${inputDir}: ${missing.join(', ')}`);
        process.exit(1);
    }

    console.log('='.repeat(72));
    console.log('  DT-56285: JSON -> CSV (local only, no network)');
    console.log(`  Source: ${path.relative(SCRIPT_DIR, inputDir)}`);
    console.log(`  Output: ${path.relative(SCRIPT_DIR, OUTPUT_DIR)}`);
    console.log('='.repeat(72));

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const everyRow = [];
    let filesWritten = 0;

    console.log('\n  rows  columns  file');
    console.log('  ' + '-'.repeat(64));

    for (const fileName of candidates) {
        const rows = JSON.parse(fs.readFileSync(path.join(inputDir, fileName), 'utf-8'));
        if (!Array.isArray(rows)) {
            console.error(`  ${fileName} is not a JSON array, skipping`);
            continue;
        }

        const csvName = fileName.replace(/\.json$/i, '.csv');
        fs.writeFileSync(path.join(OUTPUT_DIR, csvName), toCsv(rows));
        filesWritten++;
        everyRow.push(...rows);

        const columns = rows.length ? buildColumnOrder(rows).length : 0;
        console.log(`  ${String(rows.length).padStart(4)}  ${String(columns).padStart(7)}  ${csvName}`);
    }

    // One combined sheet as well — easier to pivot than ten separate files.
    if (everyRow.length > 0) {
        fs.writeFileSync(path.join(OUTPUT_DIR, '_all-buckets.csv'), toCsv(everyRow));
        console.log('  ' + '-'.repeat(64));
        console.log(`  ${String(everyRow.length).padStart(4)}  ${String(buildColumnOrder(everyRow).length).padStart(7)}  _all-buckets.csv`);
    }

    console.log(`\nWrote ${filesWritten} CSV file(s)${everyRow.length ? ' + _all-buckets.csv' : ''}`);
    console.log('The source JSON was not modified.');
}

main();
