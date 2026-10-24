-- Answers keep the records they were based on, resolved when the answer was written.
ALTER TABLE messages ADD COLUMN sources jsonb NOT NULL DEFAULT '[]';

-- Every lookup the model made while answering, so each answer can be traced to its evidence.
CREATE TABLE ai_run_steps (
  id uuid PRIMARY KEY,
  ai_run_id uuid NOT NULL REFERENCES ai_runs(id),
  position integer NOT NULL CHECK (position > 0),
  tool text NOT NULL CHECK (length(tool) BETWEEN 1 AND 50),
  input jsonb NOT NULL,
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
  refs jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ai_run_id, position)
);
CREATE TRIGGER ai_run_steps_immutable BEFORE UPDATE OR DELETE ON ai_run_steps
FOR EACH ROW EXECUTE FUNCTION prevent_history_change();
