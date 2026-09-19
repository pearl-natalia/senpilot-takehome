import { z } from 'zod';

export const DOCUMENT_TYPES = [
  'Exhibits', 'Key Documents', 'Other Documents', 'Transcripts', 'Recordings',
] as const;

export const requestSchema = z.object({
  matterNumber: z.string().trim().toUpperCase().regex(/^M\d{5}$/, 'Use a matter number such as M12205'),
  documentType: z.enum(DOCUMENT_TYPES),
  limit: z.number().int().min(1).max(10).default(10),
});

export type DocumentType = typeof DOCUMENT_TYPES[number];
export type FilingRequest = z.infer<typeof requestSchema>;

export interface Matter {
  number: string;
  title: string;
  status: string | null;
  type: string | null;
  category: string | null;
  receivedDate: string | null;
  finalSubmissionDate: string | null;
  decisionDate?: string | null;
  outcome: string | null;
  counts: Record<DocumentType, number>;
  totalDocuments: number;
  retrievedAt: string;
  sourceUrl: string;
}

export interface DocumentReference {
  id: string;
  rowKey?: string;
  title: string;
  date: string;
  extension: string;
  security: string;
}

export interface ValidatedFile {
  path: string;
  filename: string;
  size: number;
  sha256: string;
  mimeType: string;
  validation: 'pdf-parsed' | 'signature' | 'text' | 'office-container';
}

export interface FilingFile extends ValidatedFile {
  documentId: string;
  documentTitle: string;
  originalFilename: string;
  downloadedAt: string;
  cacheHit: boolean;
}

export interface SkippedFile {
  documentId: string;
  filename?: string;
  reason: string;
}

export interface FetchResult {
  request: FilingRequest;
  matter: Matter;
  files: FilingFile[];
  skipped: SkippedFile[];
  warnings: string[];
  listingExhausted: boolean;
}

export class FilingError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'FilingError';
  }
}
