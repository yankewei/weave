-- A read may fence an abandoned preparation only after the receiving request's
-- window elapsed. Retrying a closed request starts a fresh window.
ALTER TABLE conversation_inputs ADD COLUMN admission_started_at timestamptz NOT NULL DEFAULT now();
