import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';

const settingsSchema = z.object({
  DATABASE_URL: z.string().url().optional(),
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GCS_CACHE_BUCKET: z.string().optional(),
  CACHE_BACKEND: z.enum(['local', 'gcs', 'off']).default('local'),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(86400),
  CACHE_DIRECTORY: z.string().default('.cache/documents'),
  MAX_FILE_BYTES: z.coerce.number().int().positive().max(100_000_000).default(20_000_000),
  MAX_TOTAL_BYTES: z.coerce.number().int().positive().max(100_000_000).default(20_000_000),
  STEP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().max(900_000).default(600_000),
  DOWNLOAD_ATTEMPTS: z.coerce.number().int().min(1).max(3).default(2),
}).superRefine((settings, ctx) => {
  if (settings.CACHE_BACKEND === 'gcs' && !settings.GCS_CACHE_BUCKET) {
    ctx.addIssue({ code: 'custom', path: ['GCS_CACHE_BUCKET'], message: 'Required for the gcs cache backend' });
  }
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const input = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = settingsSchema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid configuration: ${result.error.issues.map(issue => issue.path.join('.')).join(', ')}`);
  }
  return { ...result.data, CACHE_DIRECTORY: resolve(result.data.CACHE_DIRECTORY) };
}

export type Config = ReturnType<typeof readConfig>;
