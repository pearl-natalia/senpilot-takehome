import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { CloudTasksClient } from '@google-cloud/tasks';
import { type Config } from './config.js';
import { requestSchema, FilingError, type FilingRequest } from './domain.js';
import { DocumentCache } from './cache/documents.js';
import { fetchDocuments } from './fetch.js';
import { createArchive } from './files/zip.js';
import { GmailClient, GmailError, type IncomingEmail } from './gmail/client.js';
import { extractRequest } from './gmail/extract.js';
import { clarification, formatReply } from './gmail/reply.js';

interface Job {
  id: string;
  gmail_message_id: string;
  status: string;
  attempts: number;
  request: FilingRequest | null;
  incoming: IncomingEmail | null;
  reply_message_id: string | null;
  reply_status: string | null;
}

export class JobRunner {
  private tasks = new CloudTasksClient();
  constructor(private pool: Pool, private gmail: GmailClient, private config: Config) {}

  async dispatch() {
    const serviceUrl = process.env.SERVICE_URL;
    const queue = process.env.TASK_QUEUE;
    const caller = process.env.CALLER_SERVICE_ACCOUNT;
    if (!serviceUrl || !queue || !caller) throw new Error('Task queue configuration is incomplete');
    const selected = await this.pool.query<{ id: string; dispatch_version: number }>(`
      UPDATE jobs SET queued_at = now(), dispatch_version = dispatch_version + 1
      WHERE id IN (
        SELECT id FROM jobs WHERE mailbox = $1
          AND status NOT IN ('completed', 'failed', 'needs_clarification')
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
          AND (queued_at IS NULL OR queued_at < now() - interval '20 minutes')
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 20
      ) RETURNING id, dispatch_version`, [this.gmail.mailbox]);
    for (const job of selected.rows) {
      const name = `${queue}/tasks/${job.id}-${job.dispatch_version}`;
      try {
        await this.tasks.createTask({ parent: queue, task: {
          name, dispatchDeadline: { seconds: 900 },
          httpRequest: { httpMethod: 'POST', url: `${serviceUrl}/process`,
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify({ jobId: job.id })).toString('base64'),
            oidcToken: { serviceAccountEmail: caller, audience: serviceUrl },
          },
        } });
        await this.pool.query('UPDATE jobs SET task_name = $2 WHERE id = $1 AND dispatch_version = $3', [job.id, name, job.dispatch_version]);
      } catch (error) {
        if ((error as { code?: number }).code === 6) continue;
        await this.pool.query('UPDATE jobs SET queued_at = NULL WHERE id = $1 AND dispatch_version = $2', [job.id, job.dispatch_version]);
        throw error;
      }
    }
    return selected.rowCount;
  }

  async process(id: string) {
    const owner = randomUUID();
    const claimed = await this.pool.query<Job>(`
      UPDATE jobs SET lease_owner = $2, lease_expires_at = now() + interval '16 minutes',
        attempts = attempts + 1, updated_at = now()
      WHERE id = $1 AND status NOT IN ('completed', 'failed', 'needs_clarification')
        AND (lease_expires_at IS NULL OR lease_expires_at < now()) RETURNING *`, [id, owner]);
    const job = claimed.rows[0];
    if (!job) return;
    let directory: string | undefined;
    let sendStarted = job.status === 'sending';
    const update = async (sql: string, values: unknown[] = []) => {
      const result = await this.pool.query(`UPDATE jobs SET ${sql}, updated_at = now() WHERE id = $1 AND lease_owner = $2`, [id, owner, ...values]);
      if (!result.rowCount) throw new Error('Job lease lost');
    };
    try {
      if (job.status === 'sending') {
        const found = job.reply_message_id ? await this.gmail.findReply(job.reply_message_id) : undefined;
        if (found) {
          await update('status = $3, outgoing_message_id = $4, last_error = NULL, lease_owner = NULL, lease_expires_at = NULL', [job.reply_status ?? 'completed', found]);
        } else {
          await update("last_error = 'Delivery uncertain; check Sent mail before manually retrying', lease_owner = NULL, lease_expires_at = NULL");
          console.error(JSON.stringify({ event: 'delivery_uncertain', jobId: id }));
        }
        return;
      }
      const incoming = job.incoming ?? await this.gmail.readIncoming(job.gmail_message_id);
      if (!incoming) {
        await update("status = 'completed', result = $3, lease_owner = NULL, lease_expires_at = NULL", [{ ignored: true }]);
        return;
      }
      await update("status = 'extracting', incoming = $3", [incoming]);
      let request: FilingRequest | null = job.request ? requestSchema.parse(job.request) : null;
      let text = '';
      let attachment: string | undefined;
      let terminal = 'completed';
      if (job.attempts > 3) {
        terminal = 'failed';
        text = 'I could not complete this request after retrying. The source website or another service may be unavailable. Please try again later. No files are attached.';
      } else {
        const extracted = request ? { request, issues: [] } : await extractRequest(incoming);
        request = extracted.request;
        if (!request) {
          terminal = 'needs_clarification'; text = clarification(extracted.issues);
        } else {
          await update("status = 'retrieving', request = $3", [request]);
          directory = await mkdtemp(join(tmpdir(), 'uarb-'));
          const result = await fetchDocuments(request, this.config, join(directory, 'files'), new DocumentCache(this.config, this.pool));
          await update("status = 'packaging', result = $3", [{ ...result, files: result.files.map(({ path: _, ...file }) => file) }]);
          if (result.files.length) {
            attachment = join(directory, `${request.matterNumber}-${request.documentType.replaceAll(' ', '-')}.zip`);
            await createArchive(result.files, attachment, this.config.MAX_TOTAL_BYTES);
          }
          text = formatReply(result);
        }
      }
      const messageId = `<uarb-${id}@${this.gmail.mailbox.split('@')[1]}>`;
      const raw = await this.gmail.composeReply(incoming, text, messageId, attachment);
      await update("status = 'sending', reply_message_id = $3, reply_status = $4, send_started_at = now()", [messageId, terminal]);
      sendStarted = true;
      const sent = await this.gmail.send(raw, incoming.threadId);
      await update('status = $3, outgoing_message_id = $4, last_error = NULL, lease_owner = NULL, lease_expires_at = NULL', [terminal, sent.id]);
      console.log(JSON.stringify({ event: 'reply_sent', jobId: id, status: terminal }));
    } catch (error) {
      if (error instanceof GmailError && error.status === 404 && !job.incoming && !sendStarted) {
        await update("status = 'completed', last_error = 'Incoming message no longer exists', lease_owner = NULL, lease_expires_at = NULL");
        return;
      }
      const code = error instanceof FilingError ? error.code : error instanceof GmailError ? `GMAIL_${error.status}` : 'PROCESSING_ERROR';
      const definiteSendFailure = sendStarted && error instanceof GmailError && error.status >= 400 && error.status < 500 && error.status !== 408;
      await update(`status = $3, last_error = $4, lease_owner = NULL, lease_expires_at = NULL`, [sendStarted && !definiteSendFailure ? 'sending' : 'pending', code]);
      console.error(JSON.stringify({ event: 'job_failed', jobId: id, code, deliveryUncertain: sendStarted && !definiteSendFailure }));
      throw new Error(code);
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
}
