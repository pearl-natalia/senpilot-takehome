CREATE TABLE mailbox_cursors (
  mailbox text PRIMARY KEY,
  history_id text NOT NULL,
  watch_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  mailbox text NOT NULL,
  gmail_message_id text NOT NULL,
  gmail_thread_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'extracting', 'retrieving', 'packaging', 'sending',
    'completed', 'failed', 'needs_clarification'
  )),
  request jsonb,
  result jsonb,
  task_name text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner uuid,
  lease_expires_at timestamptz,
  outgoing_message_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox, gmail_message_id)
);

CREATE INDEX jobs_recovery ON jobs (status, updated_at)
  WHERE status NOT IN ('completed', 'failed', 'needs_clarification');

CREATE TABLE cached_documents (
  namespace text NOT NULL,
  matter_number text NOT NULL CHECK (matter_number ~ '^M[0-9]{5}$'),
  document_type text NOT NULL CHECK (document_type IN (
    'Exhibits', 'Key Documents', 'Other Documents', 'Transcripts', 'Recordings'
  )),
  document_id text NOT NULL,
  source_fingerprint text NOT NULL,
  files jsonb NOT NULL CHECK (jsonb_typeof(files) = 'array' AND jsonb_array_length(files) > 0),
  cached_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (namespace, matter_number, document_type, document_id),
  CHECK (expires_at > cached_at)
);

CREATE INDEX cached_documents_expiry ON cached_documents (expires_at);
