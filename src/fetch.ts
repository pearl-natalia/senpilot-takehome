import { mkdir } from 'node:fs/promises';
import type { Config } from './config.js';
import { FilingError, requestSchema, type FilingRequest, type FetchResult, type FilingFile } from './domain.js';
import { UarbClient } from './uarb/client.js';
import { DocumentCache } from './cache/documents.js';
import { validateFile } from './files/validate.js';

type DocumentSource = Pick<UarbClient, 'open' | 'visibleDocuments' | 'nextPage' | 'openAttachments' | 'download' | 'closeAttachments' | 'screenshot' | 'timedOut' | 'close'>;

export async function fetchDocuments(input: FilingRequest, config: Config, directory: string, cache: DocumentCache, headed = false, source?: DocumentSource): Promise<FetchResult> {
  const request = requestSchema.parse(input);
  await mkdir(directory, { recursive: true });
  const client = source ?? new UarbClient(config, directory, headed);
  let result: FetchResult | undefined;
  try {
    const matter = await client.open(request);
    result = { request, matter, files: [], skipped: [], warnings: [], listingExhausted: false };
    const retrieved = result;
    let totalBytes = 0;
    const seen = new Set<string>();
    const accept = (file: FilingFile) => {
      // Reserve room for ZIP headers within the attachment budget.
      if (totalBytes + file.size > config.MAX_TOTAL_BYTES - 4096) {
        retrieved.skipped.push({ documentId: file.documentId, filename: file.originalFilename, reason: 'Would exceed the total attachment size limit' });
        return false;
      }
      totalBytes += file.size;
      retrieved.files.push(file);
      return true;
    };
    if (!matter.counts[request.documentType]) { result.listingExhausted = true; return result; }
    while (result.files.length < request.limit) {
      const visible = await client.visibleDocuments();
      if (!visible.length) throw new FilingError('PAGE_CHANGED', 'Document rows could not be read');
      for (const doc of visible) {
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        if (doc.security && doc.security.toLowerCase() !== 'public') {
          result.skipped.push({ documentId: doc.id, documentTitle: doc.title, reason: 'Document is not public' });
          continue;
        }
        let hit: FilingFile[] | null = null;
        try { hit = await cache.get(request, doc, directory, request.limit - result.files.length); }
        catch { result.warnings.push(`Cache read failed for ${doc.id}; fetched from UARB instead.`); }
        if (hit) {
          hit.forEach(accept);
        } else {
          let attachments: string[] = [];
          try { attachments = await client.openAttachments(doc); }
          catch {
            if (client.timedOut) throw new FilingError('JOB_TIMEOUT', 'Retrieval exceeded its time limit');
            result.skipped.push({ documentId: doc.id, documentTitle: doc.title, reason: 'Could not open the attachment dialog' });
            await client.closeAttachments();
            continue;
          }
          const downloaded: FilingFile[] = [];
          let complete = true;
          try {
            for (const [index, filename] of attachments.entries()) {
              if (result.files.length >= request.limit) { complete = false; break; }
              let file: FilingFile | undefined;
              let reason = 'Download failed';
              for (let attempt = 0; attempt < config.DOWNLOAD_ATTEMPTS; attempt++) {
                try {
                  if (attempt) await client.openAttachments(doc);
                  const raw = await client.download(doc, index, filename);
                  const validated = await validateFile(raw.path, raw.filename, config.MAX_FILE_BYTES);
                  file = { ...validated, documentId: doc.id, documentTitle: doc.title, originalFilename: filename, downloadedAt: new Date().toISOString(), cacheHit: false };
                  break;
                } catch (error) {
                  if (client.timedOut) throw new FilingError('JOB_TIMEOUT', 'Retrieval exceeded its time limit');
                  reason = error instanceof FilingError ? error.message : 'Download failed or timed out';
                  if (error instanceof FilingError && ['FILE_SIZE', 'INVALID_FILE', 'INVALID_PDF'].includes(error.code)) break;
                }
              }
              if (file) { downloaded.push(file); accept(file); }
              else { complete = false; result.skipped.push({ documentId: doc.id, documentTitle: doc.title, filename, reason }); }
            }
          } finally { await client.closeAttachments(); }
          if (complete) {
            try { await cache.put(request, doc, downloaded); }
            catch { result.warnings.push(`Could not cache document ${doc.id}.`); }
          }
        }
        if (result.files.length >= request.limit) break;
      }
      if (result.files.length >= request.limit) break;
      if (!await client.nextPage()) { result.listingExhausted = true; break; }
    }
    if (seen.size >= matter.counts[request.documentType]) result.listingExhausted = true;
    if (result.listingExhausted && seen.size < matter.counts[request.documentType]) result.warnings.push(`The list ended after ${seen.size} of ${matter.counts[request.documentType]} document rows; results may be incomplete.`);
    return result;
  } catch (error) {
    await client.screenshot();
    if (client.timedOut && result) {
      result.warnings.push('Retrieval reached its time limit; some documents could not be checked. You can access the remaining files on UARB.');
      return result;
    }
    if (client.timedOut) throw new FilingError('JOB_TIMEOUT', 'Retrieval exceeded its time limit');
    throw error;
  } finally { await client.close(); }
}
