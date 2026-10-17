CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id)
);
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  workspace_id uuid NOT NULL,
  author_type text NOT NULL CHECK (author_type IN ('user', 'assistant')),
  author_id uuid REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  ai_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((author_type = 'user') = (author_id IS NOT NULL))
);
CREATE INDEX messages_conversation_idx ON messages(conversation_id, created_at);
CREATE TABLE ai_runs (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  trigger_message_id uuid NOT NULL REFERENCES messages(id),
  initiator_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 100),
  error text CHECK (error IS NULL OR length(error) BETWEEN 1 AND 500),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (
    (status = 'running' AND finished_at IS NULL AND error IS NULL)
    OR (status = 'succeeded' AND finished_at IS NOT NULL AND error IS NULL)
    OR (status = 'failed' AND finished_at IS NOT NULL AND error IS NOT NULL)
  )
);
ALTER TABLE messages
  ADD CONSTRAINT messages_ai_run_fk FOREIGN KEY (ai_run_id) REFERENCES ai_runs(id);
CREATE TABLE change_proposals (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  ai_run_id uuid NOT NULL UNIQUE REFERENCES ai_runs(id),
  initiator_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('pending', 'applied', 'rejected')),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  CHECK ((status = 'pending') = (resolved_at IS NULL))
);
CREATE INDEX change_proposals_conversation_idx ON change_proposals(conversation_id, created_at DESC);
CREATE TABLE proposal_items (
  id uuid PRIMARY KEY,
  proposal_id uuid NOT NULL REFERENCES change_proposals(id),
  position integer NOT NULL CHECK (position > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(description) <= 20000),
  acceptance_criteria text NOT NULL CHECK (length(acceptance_criteria) <= 20000),
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
  task_id uuid UNIQUE REFERENCES tasks(id),
  UNIQUE (proposal_id, position)
);
ALTER TABLE task_events
  ADD COLUMN proposal_id uuid REFERENCES change_proposals(id),
  ADD COLUMN proposal_item_id uuid REFERENCES proposal_items(id);
