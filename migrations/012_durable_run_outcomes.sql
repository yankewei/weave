ALTER TABLE ai_runs ADD COLUMN synced_at timestamptz;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_sync_is_terminal CHECK (synced_at IS NULL OR status <> 'running');
