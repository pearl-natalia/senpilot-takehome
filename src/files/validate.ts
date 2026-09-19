import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { PDFDocument } from 'pdf-lib';
import { FilingError, type ValidatedFile } from '../domain.js';

export function safeFilename(name: string): string {
  const clean = basename(name.replaceAll('\\', '/')).normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  const extension = extname(clean).slice(0, 12);
  return (clean.length > 160 ? clean.slice(0, 160 - extension.length) + extension : clean) || 'document';
}

export async function validateFile(path: string, filename: string, maxBytes: number): Promise<ValidatedFile> {
  const { size } = await stat(path);
  if (!size || size > maxBytes) throw new FilingError('FILE_SIZE', 'File is empty or exceeds the size limit');
  const bytes = await readFile(path);
  const prefix = bytes.subarray(0, 1024).toString('utf8').trimStart();
  if (/^(<!doctype\s+html|<html|<head|<body)/i.test(prefix)) {
    throw new FilingError('INVALID_FILE', 'Download returned an HTML page');
  }
  const extension = extname(filename).slice(1).toLowerCase();
  const detected = await fileTypeFromBuffer(bytes);
  let validation: ValidatedFile['validation'] = 'signature';
  let mimeType = detected?.mime;
  if (extension === 'pdf' || detected?.ext === 'pdf') {
    if (detected?.ext !== 'pdf' || extension !== 'pdf') throw new FilingError('INVALID_FILE', 'PDF signature does not match the filename');
    try {
      const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
      if (pdf.getPageCount() < 1) throw new Error('No pages');
    } catch {
      throw new FilingError('INVALID_PDF', 'PDF could not be parsed or is encrypted');
    }
    validation = 'pdf-parsed';
  } else if (['txt', 'csv'].includes(extension)) {
    if (detected || bytes.includes(0)) throw new FilingError('INVALID_FILE', 'Expected a text file');
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
      throw new FilingError('INVALID_FILE', 'Text is not valid UTF-8');
    }
    mimeType = extension === 'csv' ? 'text/csv' : 'text/plain';
    validation = 'text';
  } else {
    const aliases: Record<string, string[]> = { jpg: ['jpg', 'jpeg'], tif: ['tif', 'tiff'], mov: ['mov', 'mp4'], mp4: ['mp4', 'm4a', 'm4v'], cfb: ['doc', 'xls', 'ppt'] };
    if (!detected || !(aliases[detected.ext] ?? [detected.ext]).includes(extension)) {
      throw new FilingError('INVALID_FILE', 'Unsupported file type or signature does not match the filename');
    }
  }
  return { path, filename: safeFilename(filename), size, sha256: createHash('sha256').update(bytes).digest('hex'), mimeType: mimeType!, validation };
}
