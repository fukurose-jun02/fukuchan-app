import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildD1SyncPlan } from '../../workers/finance-sync/src/d1-sync.js';
import { importFinanceCsv } from '../../workers/finance-sync/src/csv-importer.js';

function usageError() {
  throw new Error('usage: --input <csv> --output <sql> --as-of <iso> --sync-id <id> [--source-version <version>] [--dry-run]');
}

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    if (!argument.startsWith('--') || index + 1 >= argv.length) usageError();
    const key = argument.slice(2);
    if (!['input', 'output', 'as-of', 'sync-id', 'source-version'].includes(key)) usageError();
    const optionKey = {
      input: 'input',
      output: 'output',
      'as-of': 'asOf',
      'sync-id': 'syncId',
      'source-version': 'sourceVersion',
    }[key];
    options[optionKey] = argv[index + 1];
    index += 1;
  }
  if (!options.input || !options.asOf || !options.syncId || (!options.output && !options.dryRun)) usageError();
  return options;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') throw new Error('invalid_sql_value');
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderD1Sql(plan) {
  const orderedStatements = plan.statements.length >= 2
    && plan.statements.at(-2).sql.includes("status = 'superseded'")
    && plan.statements.at(-1).sql.includes("status = 'active'")
    ? [...plan.statements.slice(0, -2), plan.statements.at(-1), plan.statements.at(-2)]
    : plan.statements;
  const statements = orderedStatements.map(({ sql, params }) => {
    let parameterIndex = 0;
    return sql.replaceAll('?', () => {
      if (parameterIndex >= params.length) throw new Error('sql_parameter_mismatch');
      const value = sqlLiteral(params[parameterIndex]);
      parameterIndex += 1;
      return value;
    });
  });
  return [
    '-- Generated from aggregate-only CSV. Do not commit this file.',
    '-- D1 CLI does not accept explicit transaction statements; validate before execution.',
    '-- New active is set before older active rows are superseded.',
    ...statements.map((statement) => `${statement};`),
    '',
  ].join('\n');
}

function nowIso() {
  return new Date().toISOString();
}

function decodeCsvBytes(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

export async function runImport(argv) {
  const options = parseArgs(argv);
  const inputPath = resolve(options.input);
  const outputPath = options.output ? resolve(options.output) : null;
  if (outputPath && inputPath === outputPath) throw new Error('input_output_must_differ');

  const csvText = decodeCsvBytes(await readFile(inputPath));
  const asOf = options.asOf;
  const snapshot = importFinanceCsv(csvText, { asOf });
  const startedAt = nowIso();
  const plan = buildD1SyncPlan(snapshot, {
    syncId: options.syncId,
    sourceVersion: options.sourceVersion ?? 'manual-csv-v1',
    startedAt,
    completedAt: startedAt,
  });

  if (!options.dryRun) await writeFile(outputPath, renderD1Sql(plan), 'utf8');
  console.log(JSON.stringify({
    status: 'ok',
    mode: options.dryRun ? 'dry-run' : 'sql-generated',
    granularity: plan.granularity,
    counts: plan.counts,
    statementCount: plan.statements.length,
  }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await runImport(process.argv.slice(2));
  } catch {
    console.error('manual_csv_import_failed');
    process.exitCode = 1;
  }
}
