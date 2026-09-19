import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const project = process.env.GOOGLE_CLOUD_PROJECT;
if (!project) throw new Error('GOOGLE_CLOUD_PROJECT is required');
const executable = process.env.GCLOUD ?? 'gcloud';
const values = {
  'senpilot-database-url': process.env.DATABASE_URL,
  'senpilot-openai-key': process.env.OPENAI_API_KEY,
  'senpilot-google-oauth': await readFile(process.env.GOOGLE_OAUTH_CREDENTIALS_PATH ?? 'secrets/google-oauth.json'),
  'senpilot-google-token': await readFile(process.env.GOOGLE_OAUTH_TOKEN_PATH ?? 'secrets/google-token.json'),
};
if (Object.values(values).some(value => !value?.length)) throw new Error('Required secrets are missing');
for (const [name, value] of Object.entries(values)) {
  const base = ['--project', project, '--quiet'];
  if (spawnSync(executable, ['secrets', 'describe', name, ...base], { stdio: 'ignore' }).status !== 0) {
    const created = spawnSync(executable, ['secrets', 'create', name, '--replication-policy=automatic', ...base], { stdio: ['ignore', 'ignore', 'inherit'] });
    if (created.status !== 0) throw new Error(`Could not create ${name}`);
  }
  const added = spawnSync(executable, ['secrets', 'versions', 'add', name, '--data-file=-', ...base], { input: value, stdio: ['pipe', 'ignore', 'inherit'] });
  if (added.status !== 0) throw new Error(`Could not save ${name}`);
  console.log(`Saved ${name}`);
}
