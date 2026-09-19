# UARB email agent

Email `pearl.senpilot.agent@gmail.com` with a request such as:

> Please send the Other Documents for M12205.

The agent replies in the same thread with matter information, counts for all five document categories, and a ZIP containing up to ten valid files. Missing or invalid fields receive a clarification explaining what needs to be supplied.

## How it works

Gmail notifications go through Pub/Sub to a private Cloud Run service. The service records messages in Neon Postgres and creates Cloud Tasks jobs. A worker extracts the request using OpenAI structured output and Zod, navigates UARB with Playwright, validates downloads, creates a ZIP, and replies through Gmail.

Postgres stores job state, the Gmail history cursor, and cache metadata. File bytes live in a private Cloud Storage bucket. One browser job runs at a time; the task queue can be adjusted to allow more workers. A scheduled recovery check runs every thirty minutes and renews the Gmail watch before expiry. Normal requests are triggered by Gmail push notifications; the recovery interval allows Neon to sleep between requests.

This uses a plain TypeScript workflow: the steps are known in advance, so an agent framework was unnecessary. The LLM only extracts request fields; it cannot choose recipients, run tools, or write the reply metadata.

## Local setup

Requires Node.js 22 or newer.

```sh
npm ci
npm run browser:install
```

Create a local `.env`:

```dotenv
DATABASE_URL=
OPENAI_API_KEY=
GOOGLE_CLOUD_PROJECT=
AGENT_EMAIL=
GCS_CACHE_BUCKET=
```

```sh
npm run db:migrate
npm run fetch -- M12205 "Other Documents"
npm run fetch -- M12205 "Key Documents" --limit 3 --headed
npm run check
npm run build
```

The retrieval CLI works without Gmail or OpenAI. Without `DATABASE_URL`, it uses a local cache index. Generated ZIPs and reports appear in `outputs/`.

For Gmail, enable the Gmail API and create a web OAuth client with `http://localhost:3000/oauth2callback` as a redirect URI. Save its JSON as `secrets/google-oauth.json`, set `AGENT_EMAIL`, and run `npm run gmail:authorize`. Approve Gmail read and send access for the dedicated agent mailbox. The helper checks the account, scopes, and token refresh before saving `secrets/google-token.json`.

Set the OAuth app to **In production** before generating the token used for hosting; tokens issued in Testing expire after seven days. The `docs/` homepage and privacy policy can be published through GitHub Pages for the OAuth Branding settings. Requesters do not need OAuth access.

## Deployment

With Google Cloud billing enabled and the Google Cloud CLI installed:

```sh
gcloud auth login
export GOOGLE_CLOUD_PROJECT=your-project-id
export AGENT_EMAIL=your-agent@gmail.com
node scripts/secrets.mjs
bash scripts/setup-cloud.sh
npm run db:migrate
bash scripts/deploy.sh
```

The scripts upload credentials to Secret Manager, create scoped service accounts, configure private storage and authenticated triggers, build the container, and deploy Cloud Run in `us-east1`. Cloud Run scales to zero with at most two instances; Cloud Tasks permits one browser job at a time. Keep the exported project ID consistent with `.env` and the Gmail OAuth client’s project. For later code changes, commit them and rerun `scripts/deploy.sh`.

`src/uarb/client.ts` contains the Playwright navigation. `src/fetch.ts` handles download retries and validation, `src/gmail/` handles mail and extraction, and `src/jobs.ts` coordinates durable processing. Credentials, local checks, downloads, and generated files are excluded from Git and cloud builds.

## Limits and tradeoffs

- One matter and one category per email: Exhibits, Key Documents, Other Documents, Transcripts, or Recordings. Up to ten files, selected in displayed order. A document entry can contain multiple attachments.
- A 20 MB file/ZIP budget keeps replies manageable. Invalid, non-public, and oversized files are skipped and reported. PDFs must parse; other supported files receive signature checks, not full media decoding.
- Matter metadata and document listings are refreshed each time. Cached files can be reused for up to 24 hours; replacements with unchanged document attributes can remain stale until expiry. Storage lifecycle rules remove objects after two days; completed job records are removed after 30 days.
- Duplicate Gmail notifications share one database job. Transient work is retried. If Gmail’s send result is uncertain, the worker checks sent messages in the original thread using a unique job header, since Gmail can replace Message-ID. Unresolved delivery is left for review instead of blindly resending. This is not a guarantee of exactly-once email delivery.
- UARB is a stateful FileMaker website, so layout changes can break navigation. Some transcript downloads have malformed headers; that specific Chrome failure falls back to the same UARB download URL and session, with redirects blocked and the same validation limits.

This is an independent technical-assignment demo, not an official Senpilot or UARB service.
