import { DOCUMENT_TYPES, type FetchResult } from '../domain.js';

export interface ReplyContent { text: string; html: string }

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function list(items: string[]) {
  return `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function date(value: string | null) {
  if (!value) return 'Not listed';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(parsed);
}

export function clarification(issues: string[]): ReplyContent {
  const missingOnly = issues.length > 0 && issues.every(issue => issue.startsWith('Missing'));
  const intro = `I need a little more information before I can retrieve your documents. ${missingOnly ? 'The following is missing:' : 'Please check the following:'}`;
  const details = issues.map(issue => {
    if (issue.startsWith('Missing matter number.')) return 'Matter number (e.g., M12205).';
    if (issue.startsWith('Missing or unsupported document type.')) return `Valid document type: ${DOCUMENT_TYPES.slice(0, -1).join(', ')}, or ${DOCUMENT_TYPES.at(-1)}.`;
    return issue;
  });
  const example = 'Example request: “Please send the Other Documents for M12205.”';
  const closing = 'Please reply with your complete request.';
  return {
    text: [intro, '', ...details.map(item => `- ${item}`), '', example, '', closing].join('\n'),
    html: `<p>${escapeHtml(intro)}</p>${list(details)}<p>${escapeHtml(example)}</p><p>${closing}</p>`,
  };
}

export function formatReply(result: FetchResult): ReplyContent {
  const { matter, request, files } = result;
  const title = `${matter.number}: ${[...new Set(matter.title.split(/\r?\n/).map(line => line.trim()).filter(Boolean))].join(' ')}`;
  const details = [
    `Status: ${matter.status ?? 'Not listed'}`,
    `Category: ${matter.category ?? 'Not listed'}`,
    `Type: ${matter.type ?? 'Not listed'}`,
    `Received: ${date(matter.receivedDate)}`,
    `Final submission: ${date(matter.finalSubmissionDate)}`,
  ];
  const documents = [
    ...DOCUMENT_TYPES.map(type => `${type}: ${matter.counts[type]}`),
    `Total documents: ${matter.totalDocuments}`,
  ];
  const attached = `${files.length} ${request.documentType} ${files.length === 1 ? 'file' : 'files'}`;
  const attachment = files.length ? `Attached is a ZIP containing ${attached}.` : 'No ZIP is attached because no eligible files were downloaded.';
  const notes = [
    ...result.skipped.slice(0, 20).map(file => `Skipped ${file.filename ?? file.documentTitle ?? request.documentType}: ${file.reason}`),
    ...result.warnings,
  ];
  const footer = [
    `Information checked: ${date(matter.retrievedAt)}`,
    ...(files.some(file => file.cacheHit) ? ['Cached files: Less than 24 hours old'] : []),
  ];
  const source = new URL(matter.sourceUrl);
  if (source.protocol !== 'https:' && source.protocol !== 'http:') throw new Error('Invalid matter source URL');
  return {
    text: ['Hi,', '', 'Here are the documents and matter details you requested.', '', title, '',
      'Matter details', ...details.map(item => `- ${item}`), '',
      'Documents', ...documents.map(item => `- ${item}`), '', attachment,
      ...(notes.length ? ['', 'Notes', ...notes.map(item => `- ${item}`)] : []),
      '', 'Best,', 'Senpilot Filing Agent', '', '---', '', ...footer, `Source: ${source.href}`,
    ].join('\n'),
    html: `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#222">` +
      `<p>Hi,</p><p>Here are the documents and matter details you requested.</p>` +
      `<p><strong>${escapeHtml(title)}</strong></p>` +
      `<p><strong>Matter details</strong></p>${list(details)}` +
      `<p><strong>Documents</strong></p>${list(documents)}` +
      (files.length ? `<p>Attached is a ZIP containing <strong>${escapeHtml(attached)}</strong>.</p>` : `<p>${attachment}</p>`) +
      (notes.length ? `<p><strong>Notes</strong></p>${list(notes)}` : '') +
      `<p>Best,<br>Senpilot Filing Agent</p><hr>` +
      `<p>${footer.map(escapeHtml).join('<br>')}<br>Source: <a href="${escapeHtml(source.href)}">UARB</a></p></div>`,
  };
}
