import { Pool } from 'pg';

export function createPool(connectionString: string) {
  const url = new URL(connectionString);
  if (['prefer', 'require', 'verify-ca'].includes(url.searchParams.get('sslmode') ?? '')) {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return new Pool({
    connectionString: url.toString(),
    max: 4,
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: 'senpilot-takehome',
  });
}
