/**
 * DT-56285: Convert the Athena CSV export into the JSON that analyze.mjs consumes.
 *
 * Purely local. Reads *.csv in this directory and writes a .json next to each one.
 * No network, no prod access. The CSVs are left untouched.
 *
 * Every column is carried across, with these normalisations:
 *   - header and cell quotes stripped, values trimmed
 *   - empty strings become null, so "no value" is explicit rather than ambiguous
 *   - the numeric count/timestamp columns are emitted as numbers, not strings,
 *     because analyze.mjs and any later triage will want to compare them
 *   - rows with no claimItemId are dropped, duplicates are collapsed
 *
 * Usage:
 *   node csv-to-json.mjs                 # convert every CSV in this directory
 *   node csv-to-json.mjs <file.csv>      # convert one named file
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const inScriptDir = (fileName) => path.join(SCRIPT_DIR, fileName);

// Emitted as numbers rather than strings.
const NUMERIC_COLUMNS = new Set([
    'workflowVersion',
    'appealCount',
    'validationResponseCount',
    'verificationResponseCount',
    'verificationQcResponseCount',
    'reportQcResponseCount',
    'claimUpdatedAt',
]);

// Emitted as real booleans when the cell says true/false.
const BOOLEAN_COLUMNS = new Set([
    'isVerificationRequired',
    'isVerifiedComponentAttached',
    'isAdditionalComponent',
    'legacy',
]);

function splitCsvLine(line) {
    const cells = [];
    let cell = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cell += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (ch === ',' && !inQuotes) {
            cells.push(cell);
            cell = '';
        } else {
            cell += ch;
        }
    }
    cells.push(cell);
    return cells;
}

/**
 * Splits on newlines that are NOT inside a quoted field, so a cell containing a
 * line break (Athena will quote those) does not get torn into two rows.
 */
function splitCsvRecords(text) {
    const records = [];
    let record = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            if (inQuotes && text[i + 1] === '"') {
                record += '""';
                i++;
                continue;
            }
            inQuotes = !inQuotes;
            record += ch;
        } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            if (record.trim()) records.push(record);
            record = '';
        } else {
            record += ch;
        }
    }
    if (record.trim()) records.push(record);
    return records;
}

function coerce(column, rawValue) {
    const value = rawValue.trim();
    if (value === '') return null;

    if (NUMERIC_COLUMNS.has(column)) {
        const asNumber = Number(value);
        return Number.isFinite(asNumber) ? asNumber : value;
    }

    if (BOOLEAN_COLUMNS.has(column)) {
        const lower = value.toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
        return value;
    }

    return value;
}

function convert(csvFileName) {
    const csvPath = inScriptDir(csvFileName);
    const records = splitCsvRecords(fs.readFileSync(csvPath, 'utf-8'));

    if (records.length < 2) {
        console.error(`  ${csvFileName}: fewer than 2 records, nothing to convert`);
        return null;
    }

    const header = splitCsvLine(records[0]).map((h) => h.trim().replace(/^"|"$/g, ''));
    if (!header.includes('claimItemId')) {
        console.error(`  ${csvFileName}: no claimItemId column, skipping`);
        return null;
    }

    const rows = [];
    const seen = new Set();
    let skippedNoId = 0;
    let duplicates = 0;
    let ragged = 0;

    for (let i = 1; i < records.length; i++) {
        const cells = splitCsvLine(records[i]);
        if (cells.length !== header.length) ragged++;

        const row = {};
        header.forEach((column, idx) => {
            row[column] = coerce(column, cells[idx] ?? '');
        });

        if (!row.claimItemId) {
            skippedNoId++;
            continue;
        }
        if (seen.has(row.claimItemId)) {
            duplicates++;
            continue;
        }
        seen.add(row.claimItemId);
        rows.push(row);
    }

    const jsonFileName = csvFileName.replace(/\.csv$/i, '.json');
    fs.writeFileSync(inScriptDir(jsonFileName), JSON.stringify(rows, null, 2));

    console.log(`  ${csvFileName} -> ${jsonFileName}`);
    console.log(`      ${rows.length} rows, ${header.length} columns`);
    if (duplicates > 0) console.log(`      ${duplicates} duplicate claimItemId collapsed`);
    if (skippedNoId > 0) console.log(`      ${skippedNoId} rows dropped with no claimItemId`);
    if (ragged > 0) console.log(`      ${ragged} rows had a cell count != header count`);

    return { jsonFileName, rowCount: rows.length };
}

function main() {
    const named = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

    const csvFiles = named.length
        ? named.map((arg) => path.basename(arg))
        : fs.readdirSync(SCRIPT_DIR).filter((f) => f.toLowerCase().endsWith('.csv')).sort();

    if (csvFiles.length === 0) {
        console.error(`No CSV files found in ${SCRIPT_DIR}`);
        process.exit(1);
    }

    console.log('='.repeat(72));
    console.log('  DT-56285: CSV -> JSON conversion (local only, no network)');
    console.log(`  Directory: ${SCRIPT_DIR}`);
    console.log('='.repeat(72));

    const converted = [];
    for (const csvFile of csvFiles) {
        const result = convert(csvFile);
        if (result) converted.push(result);
    }

    if (converted.length === 0) {
        console.error('\nNothing converted.');
        process.exit(1);
    }

    console.log(`\nConverted ${converted.length} file(s). analyze.mjs will pick up:`);
    console.log('  claim_items_with_progress_evidence.json  (first match in INPUT_CANDIDATES)');
    console.log('\nThe original CSVs were not modified.');
}

main();
