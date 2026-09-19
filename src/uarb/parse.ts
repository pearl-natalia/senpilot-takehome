import { DOCUMENT_TYPES, FilingError, type DocumentType } from '../domain.js';

export function parseCounts(labels: string[]): Record<DocumentType, number> {
  return Object.fromEntries(DOCUMENT_TYPES.map(type => {
    const match = labels.map(label => label.trim()).find(label => label.startsWith(`${type} -`))?.match(/-\s*([\d,]+)\s*$/);
    if (!match) throw new FilingError('PAGE_CHANGED', `Could not read the ${type} count`);
    return [type, Number(match[1]!.replaceAll(',', ''))];
  })) as Record<DocumentType, number>;
}

export function parseDate(value: string): string | null {
  if (!value.trim()) return null;
  const match = value.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) throw new FilingError('PAGE_CHANGED', 'Unexpected date format');
  const date = `${match[3]}-${match[1]}-${match[2]}`;
  if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new FilingError('PAGE_CHANGED', 'Invalid date');
  return date;
}
