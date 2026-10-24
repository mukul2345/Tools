/**
 * DT-56285: Split an Athena CSV export into one JSON file per
 * (claimStatus, currentStage) bucket.
 *
 * Purely local. No network, no prod access. The source CSV is left untouched.
 *
 * Why split: the widened query mixes several distinct situations. A VALIDATED claim
 * on a COMPLETED workflow is unambiguous; a DRAFT claim on a REPORT_QC workflow is a
 * different animal and probably a different defect. Separate files make each bucket
 * reviewable and mitigable on its own terms, rather than as one undifferentiated pile.
 *
 * Output: input-files/split/<claimStatus>__<currentStage>.json
 *         plus split/_summary.json with the bucket counts.
 *
 * Usage:
 *   node split-by-status.mjs                              # defaults to the oct-13 export
 *   node split-by-status.mjs input-files/<other>.csv
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CSV = path.join(SCRIPT_DIR, 'input-files', 'DT-56285-oct-13.csv');
const OUTPUT_DIR = path.join(SCRIPT_DIR, 'input-files', 'split');

// Emitted as numbers rather than strings, so downstream comparisons are not
// tripped up by "0" being truthy.
const NUMERIC_COLUMNS = new Set([
    'workflowVersion',
    'appealCount',
    'validationResponseCount',
    'verificationResponseCount',
    'verificationQcResponseCount',
    'reportQcResponseCount',
    'claimUpdatedAt',
]);

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
 * line break does not get torn into two rows.
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

function parseCsv(csvPath) {
    const records = splitCsvRecords(fs.readFileSync(csvPath, 'utf-8'));
    if (records.length < 2) {
        console.error(`${path.basename(csvPath)}: fewer than 2 records, nothing to split`);
        process.exit(1);
    }

    const header = splitCsvLine(records[0]).map((h) => h.trim().replace(/^"|"$/g, ''));
    for (const required of ['claimItemId', 'claimStatus', 'currentStage']) {
        if (!header.includes(required)) {
            console.error(`${path.basename(csvPath)}: missing required column ${required}`);
            process.exit(1);
        }
    }

    const rows = [];
    const seen = new Set();
    let duplicates = 0;
    let skippedNoId = 0;
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

    return { header, rows, duplicates, skippedNoId, ragged };
}

function bucketKey(row) {
    return `${row.claimStatus}__${row.currentStage}`;
}

function main() {
    const named = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
    const csvPath = named.length ? path.resolve(SCRIPT_DIR, named[0]) : DEFAULT_CSV;

    if (!fs.existsSync(csvPath)) {
        console.error(`Not found: ${csvPath}`);
        process.exit(1);
    }

    console.log('='.repeat(72));
    console.log('  DT-56285: split by claimStatus x currentStage (local only, no network)');
    console.log(`  Source: ${path.relative(SCRIPT_DIR, csvPath)}`);
    console.log('='.repeat(72));

    const { header, rows, duplicates, skippedNoId, ragged } = parseCsv(csvPath);

    console.log(`  Parsed ${rows.length} rows, ${header.length} columns`);
    if (duplicates > 0) console.log(`  ${duplicates} duplicate claimItemId collapsed`);
    if (skippedNoId > 0) console.log(`  ${skippedNoId} rows dropped with no claimItemId`);
    if (ragged > 0) console.log(`  ${ragged} rows had a cell count != header count`);

    const buckets = new Map();
    for (const row of rows) {
        const key = bucketKey(row);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(row);
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const ordered = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
    const summary = [];

    console.log('\n  rows  file');
    console.log('  ' + '-'.repeat(68));

    for (const [key, bucketRows] of ordered) {
        const fileName = `${key}.json`;
        fs.writeFileSync(
            path.join(OUTPUT_DIR, fileName),
            JSON.stringify(bucketRows, null, 2)
        );

        // Secondary breakdowns kept in the summary rather than as more files —
        // workflowState/workflowStatus turned out to be near-perfectly correlated
        // with currentStage, so splitting on them too would just make singletons.
        const states = {};
        const evidence = {};
        for (const row of bucketRows) {
            const s = `${row.workflowState}/${row.workflowStatus}`;
            states[s] = (states[s] ?? 0) + 1;
            evidence[row.progressEvidence] = (evidence[row.progressEvidence] ?? 0) + 1;
        }

        summary.push({
            file: fileName,
            claimStatus: bucketRows[0].claimStatus,
            currentStage: bucketRows[0].currentStage,
            claims: bucketRows.length,
            cases: new Set(bucketRows.map((r) => r.caseId)).size,
            workflowStateAndStatus: states,
            progressEvidence: evidence,
        });

        console.log(`  ${String(bucketRows.length).padStart(4)}  ${fileName}`);
    }

    fs.writeFileSync(
        path.join(OUTPUT_DIR, '_summary.json'),
        JSON.stringify(
            {
                generatedAt: new Date().toISOString(),
                sourceFile: path.basename(csvPath),
                totalClaims: rows.length,
                buckets: summary,
            },
            null,
            2
        )
    );

    const total = summary.reduce((sum, b) => sum + b.claims, 0);
    console.log('  ' + '-'.repeat(68));
    console.log(`  ${String(total).padStart(4)}  total across ${summary.length} buckets`);
    console.log(`\nWrote ${path.relative(SCRIPT_DIR, OUTPUT_DIR)}/ (${summary.length} files + _summary.json)`);

    if (total !== rows.length) {
        console.error(`\nWARNING: bucket total ${total} != parsed rows ${rows.length}`);
        process.exit(1);
    }
}

main();
