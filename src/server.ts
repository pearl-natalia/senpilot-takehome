import { createServer } from 'node:http';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { readConfig } from './config.js';
import { createPool } from './db/client.js';
import { GmailClient, canonicalEmail } from './gmail/client.js';
import { Inbox } from './gmail/inbox.js';
import { JobRunner } from './jobs.js';

const config = readConfig();
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = createPool(config.DATABASE_URL);
const identity = new OAuth2Client();
let services: Promise<{ inbox: Inbox; jobs: JobRunner }> | undefined;
function getServices() {
  return services ??= GmailClient.create().then(gmail => ({ inbox: new Inbox(pool, gmail), jobs: new JobRunner(pool, gmail, config) })).catch(error => { services = undefined; throw error; });
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') { response.writeHead(200).end('ok'); return; }
    if (request.method !== 'POST' || !['/inbox', '/process', '/maintain'].includes(request.url ?? '')) { response.writeHead(404).end(); return; }
    const token = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!token || !process.env.SERVICE_URL || !process.env.CALLER_SERVICE_ACCOUNT) { response.writeHead(401).end(); return; }
    try {
      const ticket = await identity.verifyIdToken({ idToken: token, audience: process.env.SERVICE_URL });
      const payload = ticket.getPayload();
      if (!payload?.email_verified || payload.email !== process.env.CALLER_SERVICE_ACCOUNT) { response.writeHead(403).end(); return; }
    } catch { response.writeHead(401).end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 100_000) { response.writeHead(413).end(); request.destroy(); return; }
      chunks.push(chunk);
    }
    let body: unknown;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { response.writeHead(400).end(); return; }
    const { inbox, jobs } = await getServices();
    if (request.url === '/process') {
      const input = z.object({ jobId: z.string().uuid() }).safeParse(body);
      if (!input.success) { response.writeHead(400).end(); return; }
      await jobs.process(input.data.jobId);
    } else if (request.url === '/inbox') {
      const input = z.object({ message: z.object({ data: z.string() }) }).safeParse(body);
      if (!input.success) { response.writeHead(400).end(); return; }
      let notification: { emailAddress?: string };
      try { notification = JSON.parse(Buffer.from(input.data.message.data, 'base64').toString()); } catch { response.writeHead(400).end(); return; }
      if (canonicalEmail(notification.emailAddress ?? '') !== canonicalEmail(process.env.AGENT_EMAIL ?? '')) { response.writeHead(204).end(); return; }
      await inbox.sync();
      await jobs.dispatch();
    } else {
      await inbox.renewWatch();
      await inbox.sync();
      await jobs.dispatch();
      await pool.query('DELETE FROM cached_documents WHERE expires_at < now()');
      await pool.query("DELETE FROM jobs WHERE status IN ('completed', 'failed', 'needs_clarification') AND updated_at < now() - interval '30 days'");
    }
    response.writeHead(204).end();
  } catch (error) {
    console.error(JSON.stringify({ event: 'request_failed', route: request.url, type: error instanceof Error ? error.name : 'Error' }));
    response.writeHead(503).end('Temporary processing failure');
  }
});
server.requestTimeout = 910_000;
server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => console.log('Email agent listening'));
process.on('SIGTERM', () => server.close(() => { void pool.end(); }));
