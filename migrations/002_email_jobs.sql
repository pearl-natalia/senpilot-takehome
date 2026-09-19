ALTER TABLE jobs ADD COLUMN incoming jsonb;
ALTER TABLE jobs ADD COLUMN reply_message_id text;
ALTER TABLE jobs ADD COLUMN reply_status text CHECK (reply_status IN ('completed', 'failed', 'needs_clarification'));
ALTER TABLE jobs ADD COLUMN send_started_at timestamptz;
ALTER TABLE jobs ADD COLUMN dispatch_version integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN queued_at timestamptz;
CREATE UNIQUE INDEX jobs_reply_message_id ON jobs (reply_message_id) WHERE reply_message_id IS NOT NULL;
