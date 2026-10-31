-- Browser messages now live only in the agent's durable store. Historical
-- ai_runs stay for proposal and task traceability, but the legacy message table
-- and its trigger linkage are no longer read or written.
ALTER TABLE ai_runs DROP CONSTRAINT IF EXISTS ai_runs_trigger_source;
ALTER TABLE ai_runs DROP CONSTRAINT IF EXISTS ai_runs_trigger_message_id_fkey;
ALTER TABLE ai_runs DROP COLUMN IF EXISTS trigger_message_id;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_ai_run_fk;
DROP TABLE IF EXISTS messages;
