import { createHash, randomUUID } from 'node:crypto';
import { mkdir, copyFile, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { Storage } from '@google-cloud/storage';
import type { Pool } from 'pg';
import type { Config } from '../config.js';
import type { DocumentReference, FilingFile, FilingRequest } from '../domain.js';
import { validateFile, safeFilename } from '../files/validate.js';

interface StoredFile extends Omit<FilingFile, 'path' | 'cacheHit'> { key: string }
interface Entry { fingerprint: string; expiresAt: string; files: StoredFile[] }

export function fingerprint(doc: DocumentReference): string {
  return createHash('sha256').update(JSON.stringify([doc.id, doc.title, doc.date, doc.extension, doc.security])).digest('hex');
}

export class DocumentCache {
  private storage: Storage | undefined;
  private namespace: string;
  constructor(private config: Config, private pool?: Pool) {
    this.namespace = config.CACHE_BACKEND === 'gcs' ? `gcs:${config.GCS_CACHE_BUCKET}` : `local:${config.CACHE_DIRECTORY}`;
    if (config.CACHE_BACKEND === 'gcs') this.storage = new Storage({ projectId: config.GOOGLE_CLOUD_PROJECT });
  }

  private identity(request: FilingRequest, doc: DocumentReference) {
    return [this.namespace, request.matterNumber, request.documentType, doc.id];
  }

  private manifestPath(request: FilingRequest, doc: DocumentReference) {
    const hash = createHash('sha256').update(JSON.stringify(this.identity(request, doc))).digest('hex');
    return join(this.config.CACHE_DIRECTORY, 'manifests', `${hash}.json`);
  }

  async get(request: FilingRequest, doc: DocumentReference, directory: string, limit: number): Promise<FilingFile[] | null> {
    if (this.config.CACHE_BACKEND === 'off') return null;
    let entry: Entry | undefined;
    if (this.pool) {
      const { rows } = await this.pool.query('SELECT source_fingerprint AS fingerprint, expires_at AS "expiresAt", files FROM cached_documents WHERE namespace=$1 AND matter_number=$2 AND document_type=$3 AND document_id=$4', this.identity(request, doc));
      entry = rows[0];
    } else {
      try { entry = JSON.parse(await readFile(this.manifestPath(request, doc), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    }
    if (!entry || entry.fingerprint !== fingerprint(doc) || new Date(entry.expiresAt).getTime() <= Date.now()) return null;
    if (!Array.isArray(entry.files) || !entry.files.length) return null;
    const result: FilingFile[] = [];
    for (const file of entry.files.slice(0, limit)) {
      if (!/^objects\/[a-f0-9]{64}$/.test(file.key) || file.filename !== safeFilename(file.filename)) throw new Error('Invalid cache manifest');
      const path = join(directory, file.filename);
      if (this.storage) await this.storage.bucket(this.config.GCS_CACHE_BUCKET!).file(file.key).download({ destination: path, validation: 'crc32c' });
      else await copyFile(join(this.config.CACHE_DIRECTORY, file.key), path);
      const validated = await validateFile(path, file.filename, this.config.MAX_FILE_BYTES);
      if (validated.sha256 !== file.sha256 || validated.size !== file.size) throw new Error('Cached file failed integrity check');
      const { key: _, ...metadata } = file;
      result.push({ ...metadata, ...validated, cacheHit: true });
    }
    return result;
  }

  async put(request: FilingRequest, doc: DocumentReference, files: FilingFile[]): Promise<void> {
    if (this.config.CACHE_BACKEND === 'off' || !files.length) return;
    const stored: StoredFile[] = [];
    for (const file of files) {
      const key = `objects/${file.sha256}`;
      if (this.storage) {
        try {
          await this.storage.bucket(this.config.GCS_CACHE_BUCKET!).upload(file.path, { destination: key, resumable: false, validation: 'crc32c', preconditionOpts: { ifGenerationMatch: 0 }, metadata: { contentType: file.mimeType } });
        } catch (error) { if ((error as { code?: number }).code !== 412) throw error; }
      } else {
        const destination = join(this.config.CACHE_DIRECTORY, key);
        await mkdir(join(this.config.CACHE_DIRECTORY, 'objects'), { recursive: true });
        const temporary = `${destination}.${randomUUID()}.tmp`;
        await copyFile(file.path, temporary);
        await rename(temporary, destination);
      }
      const { path: _, cacheHit: __, ...metadata } = file;
      stored.push({ ...metadata, key });
    }
    const entry: Entry = { fingerprint: fingerprint(doc), files: stored, expiresAt: new Date(Date.now() + this.config.CACHE_TTL_SECONDS * 1000).toISOString() };
    if (this.pool) {
      await this.pool.query(`INSERT INTO cached_documents(namespace,matter_number,document_type,document_id,source_fingerprint,files,expires_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(namespace,matter_number,document_type,document_id)
        DO UPDATE SET source_fingerprint=EXCLUDED.source_fingerprint,files=EXCLUDED.files,cached_at=now(),expires_at=EXCLUDED.expires_at`, [...this.identity(request, doc), entry.fingerprint, JSON.stringify(stored), entry.expiresAt]);
    } else {
      const path = this.manifestPath(request, doc);
      await mkdir(join(this.config.CACHE_DIRECTORY, 'manifests'), { recursive: true });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(entry));
      await rename(temporary, path);
    }
  }
}
