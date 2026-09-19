import { DOCUMENT_TYPES, type FetchResult } from '../domain.js';

export function clarification(issues: string[]) {
  return ['I need a little more information before I can retrieve your documents:', '',
    ...issues.map(issue => `- ${issue}`), '',
    'For example: Please send the Other Documents for M12205.', '',
    'Reply with your complete request. I can return up to 10 files per request.',
  ].join('\n');
}

export function formatReply(result: FetchResult) {
  const { matter, request, files } = result;
  const lines = [
    `${matter.number}: ${matter.title}`, '',
    `Status: ${matter.status ?? 'Not listed'}`,
    `Category: ${matter.category ?? 'Not listed'}`,
    `Type: ${matter.type ?? 'Not listed'}`,
    `Received: ${matter.receivedDate ?? 'Not listed'}`,
    `Final submission: ${matter.finalSubmissionDate ?? 'Not listed'}`,
    `Outcome: ${matter.outcome ?? 'Not listed'}`,
    ...(matter.decisionDate ? [`Decision date: ${matter.decisionDate}`] : []), '',
    ...DOCUMENT_TYPES.map(type => `${type}: ${matter.counts[type]}`),
    `Total documents: ${matter.totalDocuments}`, '',
    `Downloaded ${files.length} file(s) from ${matter.counts[request.documentType]} ${request.documentType} document entries (requested maximum: ${request.limit}).`,
    files.length ? 'The ZIP is attached.' : 'No ZIP is attached because no eligible files were downloaded.',
    'One document entry can contain multiple files. Files are selected in the website’s displayed order.',
  ];
  if (result.skipped.length) lines.push('', 'Skipped:', ...result.skipped.slice(0, 20).map(file => `- ${file.documentId}: ${file.reason}`));
  if (result.warnings.length) lines.push('', 'Notes:', ...result.warnings.map(warning => `- ${warning}`));
  lines.push('', `Matter information and document counts checked: ${matter.retrievedAt}`, `Source: ${matter.sourceUrl}`);
  if (files.some(file => file.cacheHit)) {
    const oldest = files.filter(file => file.cacheHit).map(file => file.downloadedAt).sort()[0];
    lines.push(`Some files came from a cache valid for up to 24 hours. Oldest cached download used: ${oldest}.`);
  }
  lines.push('Attachments are limited to a 20 MB ZIP. Large or invalid files may be skipped.');
  return lines.join('\n');
}
