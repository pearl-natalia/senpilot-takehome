import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig } from './config.js';
import { FilingError, requestSchema } from './domain.js';
import { createPool } from './db/client.js';
import { DocumentCache } from './cache/documents.js';
import { fetchDocuments } from './fetch.js';
import { createArchive } from './files/zip.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  limit: { type: 'string', default: '10' }, output: { type: 'string' }, headed: { type: 'boolean', default: false },
} });
if (positionals.length !== 2) {
  console.error('Usage: npm run fetch -- M12205 "Other Documents" [--limit 10] [--headed] [--output directory]');
  process.exit(1);
}
const request = requestSchema.parse({ matterNumber: positionals[0], documentType: positionals[1], limit: Number(values.limit) });
const config = readConfig();
const pool = config.DATABASE_URL ? createPool(config.DATABASE_URL) : undefined;
const directory = resolve(values.output ?? join('outputs', `${request.matterNumber}-${randomUUID().slice(0, 8)}`));
try {
  await mkdir(directory, { recursive: true });
  const filesDirectory = join(directory, 'files');
  console.log(`Retrieving ${request.documentType} for ${request.matterNumber}...`);
  const result = await fetchDocuments(request, config, filesDirectory, new DocumentCache(config, pool), values.headed);
  const archive = result.files.length ? join(directory, `${request.matterNumber}-${request.documentType.replaceAll(' ', '-')}.zip`) : null;
  if (archive) await createArchive(result.files, archive, config.MAX_TOTAL_BYTES);
  const report = { ...result, files: result.files.map(({ path: _, ...file }) => file), archive: archive ? archive.split('/').pop() : null };
  await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ matter: result.matter.title, counts: result.matter.counts, downloaded: result.files.length, cacheHits: result.files.filter(file => file.cacheHit).length, skipped: result.skipped.length, warnings: result.warnings, archive, report: join(directory, 'report.json') }, null, 2));
  if (result.matter.counts[request.documentType] > 0 && !result.files.length) process.exitCode = 2;
} catch (error) {
  console.error(error instanceof FilingError ? `${error.code}: ${error.message}` : `Retrieval failed (${error instanceof Error ? error.name : 'unknown error'}). Check the failure screenshot and configuration.`);
  process.exitCode = 1;
} finally { await pool?.end(); }
