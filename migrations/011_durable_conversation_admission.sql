-- Additive while legacy still owns browser conversation traffic. The project
-- uniqueness constraint is deliberately retained until the private-data cutover.
ALTER TABLE conversations
  ADD COLUMN agent_conversation_id bigint UNIQUE CHECK (agent_conversation_id > 0),
  ADD COLUMN import_status text NOT NULL DEFAULT 'pending'
    CHECK (import_status IN ('pending', 'importing', 'complete'));

CREATE TABLE conversation_inputs (
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  request_id uuid NOT NULL,
  run_id uuid NOT NULL UNIQUE REFERENCES ai_runs(id) DEFERRABLE INITIALLY DEFERRED,
  initiator_id uuid NOT NULL REFERENCES users(id),
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  admission_id uuid NOT NULL UNIQUE,
  agent_submission_id bigint CHECK (agent_submission_id > 0),
  status text NOT NULL DEFAULT 'accepting' CHECK (status IN ('accepting', 'accepted', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, request_id),
  UNIQUE (conversation_id, request_id, run_id, initiator_id),
  CHECK ((status = 'accepted') = (agent_submission_id IS NOT NULL))
);
CREATE UNIQUE INDEX conversation_inputs_one_open_idx ON conversation_inputs(conversation_id)
  WHERE status = 'accepting';

ALTER TABLE ai_runs
  ALTER COLUMN trigger_message_id DROP NOT NULL,
  ADD COLUMN input_request_id uuid,
  ADD CONSTRAINT ai_runs_trigger_source CHECK ((trigger_message_id IS NULL) <> (input_request_id IS NULL)),
  ADD CONSTRAINT ai_runs_input_fk FOREIGN KEY (conversation_id, input_request_id, id, initiator_id)
    REFERENCES conversation_inputs(conversation_id, request_id, run_id, initiator_id);

ALTER TABLE change_proposals ADD COLUMN content_hash text
  CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');
