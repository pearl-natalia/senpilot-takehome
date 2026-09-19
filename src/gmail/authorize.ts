import 'dotenv/config';
import { createServer, type ServerResponse } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const scopes = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
const clientPath = resolve(process.env.GOOGLE_OAUTH_CREDENTIALS_PATH ?? 'secrets/google-oauth.json');
const tokenPath = resolve(process.env.GOOGLE_OAUTH_TOKEN_PATH ?? 'secrets/google-token.json');
const expectedEmail = process.env.AGENT_EMAIL;
if (!expectedEmail) throw new Error('Set AGENT_EMAIL before authorizing Gmail');
const raw = JSON.parse(await readFile(clientPath, 'utf8'));
const client = raw.web ?? raw.installed;
const redirect = new URL(process.env.GOOGLE_OAUTH_REDIRECT_URI ?? 'http://localhost:3000/oauth2callback');
if (!['localhost', '127.0.0.1'].includes(redirect.hostname) || redirect.protocol !== 'http:' || !redirect.port) {
  throw new Error('The local authorization helper requires an HTTP localhost callback with an explicit port');
}
if (!client?.client_id || !client.client_secret || !client.redirect_uris?.includes(redirect.toString())) {
  throw new Error('The OAuth client JSON must include this callback, a client ID, and a client secret');
}

const state = randomBytes(32).toString('base64url');
const verifier = randomBytes(48).toString('base64url');
const startPath = `/authorize/${randomBytes(24).toString('base64url')}`;
const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
authorization.search = new URLSearchParams({
  client_id: client.client_id, redirect_uri: redirect.toString(), response_type: 'code',
  scope: scopes.join(' '), access_type: 'offline', prompt: 'consent select_account',
  login_hint: expectedEmail, state, code_challenge_method: 'S256',
  code_challenge: createHash('sha256').update(verifier).digest('base64url'),
}).toString();

async function exchange(parameters: Record<string, string>) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, ...parameters }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Google token exchange failed (HTTP ${response.status}); restart authorization`);
  return await response.json() as { access_token: string; refresh_token?: string; expires_in: number; scope?: string; token_type: string; refresh_token_expires_in?: number };
}

function canonicalEmail(email: string) {
  const lower = email.toLowerCase();
  const [local, domain] = lower.split('@');
  return domain === 'gmail.com' ? `${local!.replaceAll('.', '')}@gmail.com` : lower;
}

function reply(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  response.end(message);
}

let busy = false;
let completed = false;
const server = createServer((request, response) => {
  void (async () => {
    if (request.method !== 'GET') { reply(response, 405, 'Method not allowed'); return; }
    const url = new URL(request.url ?? '/', redirect.origin);
    if (url.pathname === startPath) {
      response.writeHead(302, { Location: authorization.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      response.end();
      return;
    }
    if (url.pathname !== redirect.pathname) { reply(response, 404, 'Open the authorization link printed in the terminal.'); return; }
    const actualState = Buffer.from(url.searchParams.get('state') ?? '');
    const expectedState = Buffer.from(state);
    if (actualState.length !== expectedState.length || !timingSafeEqual(actualState, expectedState)) {
      reply(response, 400, 'Invalid authorization state. Use the original local authorization link.');
      return;
    }
    if (busy || completed) { reply(response, 409, 'This authorization is already being processed.'); return; }
    if (url.searchParams.has('error')) { reply(response, 400, 'Authorization was cancelled or denied. No credentials were saved.'); return; }
    const code = url.searchParams.get('code');
    if (!code) { reply(response, 400, 'The callback is missing an authorization code.'); return; }
    busy = true;
    try {
      const token = await exchange({ code, grant_type: 'authorization_code', redirect_uri: redirect.toString(), code_verifier: verifier });
      if (!token.refresh_token) throw new Error('Google did not issue a refresh token. Restart and approve offline access');
      if (!scopes.every(scope => token.scope?.split(' ').includes(scope))) throw new Error('Both Gmail read and send permissions must be approved');
      const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: token.refresh_token });
      const profileResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${refreshed.access_token}` }, signal: AbortSignal.timeout(30_000),
      });
      if (!profileResponse.ok) throw new Error(`Gmail profile check failed (HTTP ${profileResponse.status}); check that Gmail API is enabled`);
      const profile = await profileResponse.json() as { emailAddress: string };
      if (canonicalEmail(profile.emailAddress) !== canonicalEmail(expectedEmail!)) {
        throw new Error(`Wrong mailbox authorized. Restart and choose ${expectedEmail}`);
      }
      const saved = { ...token, ...refreshed, refresh_token: token.refresh_token, expiry_date: Date.now() + refreshed.expires_in * 1000, email_address: profile.emailAddress };
      await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
      const temporary = `${tokenPath}.${randomBytes(8).toString('hex')}.tmp`;
      await writeFile(temporary, JSON.stringify(saved, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, tokenPath);
      completed = true;
      console.log(`Authorized ${profile.emailAddress}; read/send scopes and token refresh verified. Saved ${tokenPath}`);
      reply(response, 200, `Gmail authorization complete for ${profile.emailAddress}. You can close this tab. No email was sent.`);
      clearTimeout(expiration);
      server.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authorization failed';
      console.error(message);
      reply(response, 400, `${message}. No new credentials were saved. Restart npm run gmail:authorize to try again.`);
      clearTimeout(expiration);
      server.close();
      process.exitCode = 1;
    }
  })().catch(() => { if (!response.headersSent) reply(response, 500, 'Authorization failed. Restart the helper.'); });
});

const expiration = setTimeout(() => { console.error('Authorization expired. Run npm run gmail:authorize again.'); server.closeAllConnections(); server.close(); process.exitCode = 1; }, 15 * 60_000);
server.on('error', (error: NodeJS.ErrnoException) => { clearTimeout(expiration); console.error(error.code === 'EADDRINUSE' ? 'The OAuth callback port is already in use. Stop its other process or configure another registered callback.' : 'Could not start the local OAuth callback server'); process.exitCode = 1; });
server.listen(Number(redirect.port), '127.0.0.1', () => {
  console.log(`Authorize ${expectedEmail} using: ${redirect.origin}${startPath}`);
  console.log('The link expires in 15 minutes. Only approve Gmail read and send access for the agent inbox.');
});
