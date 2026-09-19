import { chromium, type Browser, type Page, type Locator, type Download, type Request } from 'playwright';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { DOCUMENT_TYPES, FilingError, type DocumentReference, type FilingRequest, type Matter } from '../domain.js';
import { parseCounts, parseDate } from './parse.js';
import { safeFilename } from '../files/validate.js';

export const UARB_URL = 'https://uarb.novascotia.ca/fmi/webd/UARB15';

export class UarbClient {
  private browser?: Browser;
  private page?: Page;
  private timer?: NodeJS.Timeout;
  private expired = false;
  private idField = 201;
  private extensionField = 308;
  private datedRows = false;
  constructor(private config: Config, private directory: string, private headed = false) {}

  async open(request: FilingRequest): Promise<Matter> {
    this.browser = await chromium.launch({ headless: !this.headed });
    this.timer = setTimeout(() => { this.expired = true; void this.browser?.close(); }, this.config.JOB_TIMEOUT_MS);
    this.page = await this.browser.newPage({ acceptDownloads: true, viewport: { width: 1280, height: 720 } });
    this.page.setDefaultTimeout(this.config.STEP_TIMEOUT_MS);
    await this.page.goto(UARB_URL, { waitUntil: 'domcontentloaded' });
    const input = this.page.locator('.inner_border').filter({ has: this.page.getByText('eg M01234', { exact: true }) }).locator('.text');
    await input.click();
    await this.page.locator('[contenteditable="true"]').fill(request.matterNumber);
    await this.page.locator('[contenteditable="true"]').press('Tab');
    await this.page.locator('#b0p0o258i0i0r1').click();
    try { await this.page.getByRole('button', { name: /^Exhibits -/ }).waitFor(); }
    catch { throw new FilingError('MATTER_NOT_FOUND', `Could not open ${request.matterNumber}; check the matter number or try again`); }
    await this.waitForCounts();
    const initialCounts = parseCounts(await this.page.locator('button').allTextContents());
    const selectedType = initialCounts[request.documentType] ? request.documentType : DOCUMENT_TYPES.find(type => initialCounts[type] > 0);
    if (!selectedType) {
      const field = async (id: number) => (await this.page!.locator(`.fm_object_${id}`).innerText()).trim();
      if (await field(286) !== request.matterNumber) throw new FilingError('WRONG_MATTER', 'The website returned a different matter');
      return {
        number: request.matterNumber, title: (await this.page.locator('#b0p0o290i0i0r1').innerText()).trim(),
        status: await field(289) || null, type: await field(287) || null, category: await field(298) || null,
        receivedDate: parseDate(await field(292)), finalSubmissionDate: null, decisionDate: parseDate(await field(294)),
        outcome: await field(295) || null, counts: initialCounts, totalDocuments: 0, retrievedAt: new Date().toISOString(), sourceUrl: UARB_URL,
      };
    }
    this.idField = selectedType === 'Key Documents' ? 268 : selectedType === 'Exhibits' ? 300 : 201;
    this.extensionField = selectedType === 'Key Documents' ? 284 : selectedType === 'Exhibits' ? 314 : 308;
    this.datedRows = selectedType === 'Transcripts' || selectedType === 'Recordings';
    await this.page.getByRole('button', { name: new RegExp(`^${selectedType} -`) }).click();
    await this.page.waitForFunction(expected => document.querySelector('.fm_object_219')?.textContent?.trim() === expected, request.matterNumber);
    await this.page.waitForFunction(expected => document.querySelector('table[role="grid"]')?.getAttribute('aria-rowcount') === String(expected), initialCounts[selectedType]);
    await this.page.locator('tr.v-grid-row-has-data').first().getByRole('button', { name: 'GO GET IT', exact: true }).waitFor();
    await this.page.locator('.v-loading-indicator').waitFor({ state: 'hidden' });
    const field = async (id: number) => (await this.page!.locator(`.fm_object_${id}`).innerText()).trim();
    const number = await field(219);
    if (number !== request.matterNumber) throw new FilingError('WRONG_MATTER', 'The website returned a different matter');
    const counts = initialCounts;
    const title = (await this.page.locator('#b0p0o223i0i0r1').innerText()).trim();
    if (!title) throw new FilingError('PAGE_CHANGED', 'Matter title is missing');
    return {
      number, title, status: await field(222) || null, type: await field(220) || null,
      category: await field(231) || null, receivedDate: parseDate(await field(225)),
      finalSubmissionDate: parseDate(await field(227)), outcome: await field(228) || null,
      counts, totalDocuments: Object.values(counts).reduce((sum, count) => sum + count, 0),
      retrievedAt: new Date().toISOString(), sourceUrl: UARB_URL,
    };
  }

  private rows() { return this.page!.locator('tr.v-grid-row-has-data'); }

  private async waitForCounts() {
    await this.page!.waitForFunction(types => types.every(type => Array.from(document.querySelectorAll('button')).some(button => new RegExp(`^${type} -\\s*[\\d,]+\\s*$`).test(button.textContent?.trim() ?? ''))), DOCUMENT_TYPES);
  }

  async visibleDocuments(): Promise<DocumentReference[]> {
    const documents = await this.rows().evaluateAll((rows, fields) => rows.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top).flatMap(row => {
      const id = row.querySelector(`.fm_object_${fields.id}`)?.textContent?.trim() ?? '';
      const title = Array.from(row.querySelectorAll('.fm_object_202')).map(el => el.textContent?.trim()).filter(Boolean).join(' | ');
      return id ? [{ id,
        rowKey: row.querySelector(`.fm_object_${fields.id}`)?.id,
        position: Math.round(new DOMMatrix(getComputedStyle(row).transform).m42 / row.getBoundingClientRect().height),
        title,
        date: fields.dated ? id : row.querySelector('.fm_object_203')?.textContent?.trim() ?? '',
        security: row.querySelector('.fm_object_204')?.textContent?.trim() ?? '',
        extension: fields.dated ? '' : row.querySelector(`.fm_object_${fields.extension}`)?.textContent?.trim() ?? '',
      }] : [];
    }), { id: this.idField, extension: this.extensionField, dated: this.datedRows });
    return documents.map(({ position, ...doc }) => ({ ...doc, id: this.datedRows ? `row-${position}-${createHash('sha256').update(`${doc.date}|${doc.title}`).digest('hex').slice(0, 16)}` : doc.id }));
  }

  async nextPage(): Promise<boolean> {
    const scroller = this.page!.locator('.v-grid-scroller-vertical');
    const before = await this.rows().evaluateAll(rows => rows.map(row => `${(row as HTMLElement).style.transform}:${row.textContent}`).join('|'));
    const moved = await scroller.evaluate(el => {
      const previous = el.scrollTop;
      el.scrollTop = Math.min(el.scrollTop + Math.max(68, el.clientHeight - 68), el.scrollHeight - el.clientHeight);
      return el.scrollTop > previous;
    });
    if (!moved) return false;
    await this.page!.waitForFunction(({ previous, field }) => {
      const rows = Array.from(document.querySelectorAll('tr.v-grid-row-has-data'));
      const content = rows.map(row => `${(row as HTMLElement).style.transform}:${row.textContent}`).join('|');
      return rows.length > 0 && content !== previous && rows.every(row => row.querySelector(`.fm_object_${field}`)?.textContent?.trim() && row.querySelector('.fm_object_202'));
    }, { previous: before, field: this.idField });
    await this.page!.locator('.v-loading-indicator').waitFor({ state: 'hidden' });
    return true;
  }

  private row(doc: DocumentReference): Locator {
    if (doc.rowKey) return this.rows().filter({ has: this.page!.locator(`[id="${doc.rowKey}"]`) });
    const escaped = doc.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return this.rows().filter({ has: this.page!.locator(`.fm_object_${this.idField}`).filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`) }) });
  }

  async openAttachments(doc: DocumentReference): Promise<string[]> {
    await this.closeAttachments();
    const current = (await this.visibleDocuments()).find(row => row.rowKey === doc.rowKey);
    if (doc.rowKey && (!current || current.id !== doc.id || current.title !== doc.title)) throw new FilingError('PAGE_CHANGED', 'The selected document row changed');
    await this.row(doc).getByRole('button', { name: 'GO GET IT', exact: true }).click();
    await this.page!.getByText('Export Field to File', { exact: true }).or(this.page!.getByText('Download Files', { exact: true })).first().waitFor();
    if (await this.page!.getByText('Export Field to File', { exact: true }).isVisible()) {
      await this.page!.getByRole('button', { name: 'OK', exact: true }).click();
    }
    await this.page!.getByText('Download Files', { exact: true }).waitFor();
    const buttons = this.page!.locator('.fm-download-button');
    await buttons.first().waitFor();
    return (await buttons.allTextContents()).map(name => name.trim());
  }

  async download(doc: DocumentReference, attachmentIndex: number, filename: string): Promise<{ path: string; filename: string }> {
    const button = this.page!.locator('.fm-download-button').nth(attachmentIndex);
    if ((await button.innerText()).trim() !== filename) throw new FilingError('PAGE_CHANGED', 'Attachment list changed while downloading');
    type Source = { download: Download } | { malformedHeaderUrl: string };
    let resolve!: (source: Source) => void;
    let reject!: (error: Error) => void;
    const event = new Promise<Source>((yes, no) => { resolve = yes; reject = no; });
    const onDownload = (download: Download) => {
      if (download.suggestedFilename().normalize('NFC') === filename.normalize('NFC')) resolve({ download });
      else void download.cancel();
    };
    const onFailure = (request: Request) => {
      if (request.failure()?.errorText.includes('ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_DISPOSITION')) resolve({ malformedHeaderUrl: request.url() });
    };
    this.page!.on('download', onDownload);
    this.page!.on('requestfailed', onFailure);
    const timeout = setTimeout(() => reject(new FilingError('DOWNLOAD_FAILED', 'Download did not start before the timeout')), this.config.DOWNLOAD_TIMEOUT_MS);
    let source: Source;
    try { [source] = await Promise.all([event, button.click()]); }
    finally {
      clearTimeout(timeout);
      this.page!.off('download', onDownload);
      this.page!.off('requestfailed', onFailure);
    }
    if ('malformedHeaderUrl' in source) return this.downloadWithMalformedHeader(source.malformedHeaderUrl, doc, attachmentIndex, filename);
    const { download } = source;
    const name = safeFilename(`${doc.id}-${attachmentIndex + 1}-${download.suggestedFilename()}`);
    const path = join(this.directory, name);
    const abort = setTimeout(() => { void download.cancel(); }, this.config.DOWNLOAD_TIMEOUT_MS);
    try {
      const stream = await download.createReadStream();
      await this.saveStream(stream, path);
      const failure = await download.failure();
      if (failure) throw new FilingError('DOWNLOAD_FAILED', 'The browser could not complete this download');
      return { path, filename: name };
    } catch (error) {
      await download.cancel().catch(() => {});
      await rm(path, { force: true });
      throw error;
    } finally { clearTimeout(abort); await download.delete().catch(() => {}); }
  }

  private async saveStream(stream: Readable, path: string) {
    let received = 0;
    const limiter = new Transform({ transform: (chunk: Buffer, _, callback) => {
      received += chunk.length;
      callback(received > this.config.MAX_FILE_BYTES ? new FilingError('FILE_SIZE', 'File exceeds the size limit') : null, chunk);
    } });
    await pipeline(stream, limiter, createWriteStream(path));
  }

  private async downloadWithMalformedHeader(url: string, doc: DocumentReference, index: number, originalFilename: string) {
    const target = new URL(url);
    if (target.origin !== new URL(UARB_URL).origin || !target.pathname.startsWith('/fmi/webd/APP/connector/')) {
      throw new FilingError('DOWNLOAD_FAILED', 'Unexpected download location');
    }
    const filename = safeFilename(`${doc.id}-${index + 1}-${originalFilename}`);
    const path = join(this.directory, filename);
    const cookies = await this.page!.context().cookies(url);
    const response = await fetch(url, { headers: { Cookie: cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') }, redirect: 'error', signal: AbortSignal.timeout(this.config.DOWNLOAD_TIMEOUT_MS) });
    try {
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new FilingError('DOWNLOAD_FAILED', `Source returned HTTP ${response.status}`);
      }
      if (Number(response.headers.get('content-length')) > this.config.MAX_FILE_BYTES) {
        await response.body.cancel();
        throw new FilingError('FILE_SIZE', 'File exceeds the size limit');
      }
      await this.saveStream(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), path);
      return { path, filename };
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  async closeAttachments(): Promise<void> {
    const close = this.page?.getByRole('button', { name: 'Close', exact: true });
    if (close && await close.isVisible()) await close.click();
    if (await this.page?.getByText('Export Field to File', { exact: true }).isVisible()) {
      await this.page!.getByRole('button', { name: 'Cancel', exact: true }).click();
    }
  }

  async screenshot(): Promise<void> {
    if (this.page && !this.page.isClosed()) await this.page.screenshot({ path: join(this.directory, 'failure.png'), fullPage: true }).catch(() => {});
  }

  get timedOut() { return this.expired; }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    await this.browser?.close();
  }
}
