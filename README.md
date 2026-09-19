# UARB email agent

Retrieves public regulatory documents by matter number using TypeScript and Playwright. Currently runs from the command line; email processing and hosting are still being implemented.

## Setup

Requires Node.js 22 or newer.

```sh
npm ci
npm run browser:install
```

Create a local `.env` with these settings. Keep an existing `.env` when repeating setup.

```dotenv
DATABASE_URL=
OPENAI_API_KEY=
GOOGLE_CLOUD_PROJECT=
AGENT_EMAIL=
GCS_CACHE_BUCKET=
```

Set `DATABASE_URL` to your Postgres connection string, then run:

```sh
npm run db:migrate
npm run fetch -- M12205 "Other Documents"
```

Without `DATABASE_URL`, retrieval uses a local cache index and needs no migration. Downloads do not require an OpenAI key or Gmail authorization.

For Gmail authorization, save the OAuth client JSON as `secrets/google-oauth.json`, register `http://localhost:3000/oauth2callback`, and run `npm run gmail:authorize`. The helper checks the agent mailbox, read/send permissions, and token refresh before saving `secrets/google-token.json`.

## Usage

```sh
npm run fetch -- M12205 "Key Documents" --limit 3 --headed
npm run check
npm run build
```

Supported categories: Exhibits, Key Documents, Other Documents, Transcripts, and Recordings. Each request accepts one matter, one category, and up to ten files. Results appear in a generated `outputs/` directory with a ZIP and metadata report.

`src/uarb/client.ts` handles browser navigation and downloads. `src/fetch.ts` coordinates validation, retries, and caching. PDFs must parse; other supported formats receive signature checks. Failed or oversized files are skipped and reported. The default limit is 20 MB per file and per ZIP. An empty category produces a report without a ZIP.

Cache entries last up to 24 hours; each request refreshes the matter metadata and document list. File bytes stay outside Postgres. The default cache is local; cloud caching requires `CACHE_BACKEND=gcs`, a private `GCS_CACHE_BUCKET`, and Google Application Default Credentials. Replacements with unchanged document attributes may remain cached until expiry. Cache cleanup is still pending.

Some UARB transcripts have malformed download headers. For that specific Chrome error, the downloader uses the same UARB URL and session over HTTP, with redirects blocked and the same validation limits.

Verified live: ten PDFs, ten cache hits on repeat, Key Documents, an Exhibit after skipping an oversized file, a Transcript, and an empty category. Full audio downloads, GCS access, email processing, and Cloud Run deployment still need end-to-end verification.

Credentials, local tests, downloads, and generated files are ignored by Git. Keep `.env` and `secrets/` local; deployment will use Secret Manager.
