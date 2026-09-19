import { readFile } from 'node:fs/promises';
import { OAuth2Client } from 'google-auth-library';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

export interface IncomingEmail {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  text: string;
  messageId?: string;
  references: string[];
}

export class GmailError extends Error {
  constructor(public readonly status: number) { super(`Gmail request failed (${status})`); }
}

export function canonicalEmail(email: string) {
  const value = email.trim().toLowerCase();
  const [local, domain] = value.split('@');
  return ['gmail.com', 'googlemail.com'].includes(domain ?? '')
    ? `${local!.replaceAll('.', '').split('+')[0]}@gmail.com` : value;
}

export class GmailClient {
  private constructor(private auth: OAuth2Client, readonly mailbox: string) {}

  static async create() {
    const credentials = JSON.parse(await readFile(process.env.GOOGLE_OAUTH_CREDENTIALS_PATH ?? './secrets/google-oauth.json', 'utf8'));
    const client = credentials.web ?? credentials.installed;
    const token = JSON.parse(await readFile(process.env.GOOGLE_OAUTH_TOKEN_PATH ?? './secrets/google-token.json', 'utf8'));
    const mailbox = process.env.AGENT_EMAIL;
    if (!mailbox || !token.refresh_token) throw new Error('Agent mailbox and Gmail refresh token are required');
    const auth = new OAuth2Client(client.client_id, client.client_secret);
    auth.setCredentials({ refresh_token: token.refresh_token });
    const gmail = new GmailClient(auth, mailbox);
    const profile = await gmail.request<{ emailAddress: string }>('profile');
    if (canonicalEmail(profile.emailAddress) !== canonicalEmail(mailbox)) throw new Error('OAuth account does not match AGENT_EMAIL');
    return gmail;
  }

  async request<T>(path: string, body?: unknown): Promise<T> {
    const { token } = await this.auth.getAccessToken();
    if (!token) throw new Error('Gmail access token unavailable');
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new GmailError(response.status);
    return await response.json() as T;
  }

  async readIncoming(id: string): Promise<IncomingEmail | null> {
    const metadata = await this.request<{ labelIds?: string[]; sizeEstimate: number }>(`messages/${encodeURIComponent(id)}?format=minimal`);
    if (metadata.labelIds?.some(label => ['SENT', 'DRAFT', 'SPAM', 'TRASH'].includes(label))) return null;
    if (metadata.sizeEstimate > 2_000_000) return null;
    const message = await this.request<{ id: string; threadId: string; raw: string }>(`messages/${encodeURIComponent(id)}?format=raw`);
    const parsed = await simpleParser(Buffer.from(message.raw, 'base64url'), { skipHtmlToText: false, skipTextToHtml: true });
    const from = parsed.from?.value;
    if (from?.length !== 1 || !from[0]?.address || canonicalEmail(from[0].address) === canonicalEmail(this.mailbox)) return null;
    if (/[^\x21-\x7e]/.test(from[0].address) || !/^[^<>\s]+@[^<>\s]+\.[^<>\s]+$/.test(from[0].address)) return null;
    if (/^(?:no[._-]?reply|do[._-]?not[._-]?reply|mailer[._-]?daemon|postmaster)(?:[+._-][^@]*)?@/i.test(from[0].address)) return null;
    const autoSubmitted = parsed.headers.get('auto-submitted');
    if ((autoSubmitted && String(autoSubmitted).toLowerCase() !== 'no') || parsed.headers.has('list-id') || parsed.headers.has('x-filing-agent')) return null;
    if (/bulk|list|junk/i.test(String(parsed.headers.get('precedence') ?? ''))) return null;
    return {
      id: message.id, threadId: message.threadId, from: from[0].address,
      subject: (parsed.subject ?? '').slice(0, 500), text: (parsed.text ?? '').slice(0, 20_000),
      messageId: parsed.messageId,
      references: typeof parsed.references === 'string' ? [parsed.references] : (parsed.references ?? []).slice(-15),
    };
  }

  async composeReply(email: IncomingEmail, text: string, messageId: string, attachment?: string) {
    const raw = await new MailComposer({
      from: this.mailbox, to: email.from,
      subject: /^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`,
      text, messageId, inReplyTo: email.messageId,
      references: [...email.references, ...(email.messageId ? [email.messageId] : [])],
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', 'X-Filing-Agent': 'senpilot-takehome' },
      attachments: attachment ? [{ path: attachment, contentType: 'application/zip' }] : [],
    }).compile().build();
    if (raw.length > 34_000_000) throw new Error('Email exceeds attachment budget');
    return raw.toString('base64url');
  }

  async findReply(messageId: string) {
    const result = await this.request<{ messages?: { id: string }[] }>(`messages?q=${encodeURIComponent(`in:sent rfc822msgid:${messageId.replace(/[<>]/g, '')}`)}&maxResults=1`);
    return result.messages?.[0]?.id;
  }

  send(raw: string, threadId: string) {
    // A timed-out send may have succeeded; reconcile Sent mail before any retry.
    return this.request<{ id: string }>('messages/send', { raw, threadId });
  }
}
