ALTER TABLE projects ADD COLUMN task_counter integer NOT NULL DEFAULT 0;
CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  number integer NOT NULL CHECK (number > 0),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description text NOT NULL CHECK (length(description) <= 20000),
  acceptance_criteria text NOT NULL CHECK (length(acceptance_criteria) <= 20000),
  status text NOT NULL CHECK (status IN ('todo', 'in_progress', 'done')),
  priority text NOT NULL CHECK (priority IN ('low', 'normal', 'high')),
  assignee_id uuid,
  position numeric NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  FOREIGN KEY (workspace_id, assignee_id) REFERENCES workspace_members(workspace_id, user_id),
  UNIQUE (project_id, number),
  UNIQUE (workspace_id, project_id, id)
);
CREATE INDEX tasks_board_idx ON tasks(project_id, status, position, number);
CREATE TABLE task_events (
  operation_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  version integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create', 'edit', 'move')),
  initiator_id uuid NOT NULL REFERENCES users(id),
  confirmer_id uuid NOT NULL REFERENCES users(id),
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id, task_id) REFERENCES tasks(workspace_id, project_id, id),
  UNIQUE (task_id, version),
  CHECK ((kind = 'create') = (before_state IS NULL))
);
CREATE TRIGGER task_events_immutable BEFORE UPDATE OR DELETE ON task_events
FOR EACH ROW EXECUTE FUNCTION prevent_history_change();
