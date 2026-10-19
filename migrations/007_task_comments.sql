CREATE TABLE task_comments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  parent_id uuid,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id, task_id)
    REFERENCES tasks(workspace_id, project_id, id) ON DELETE CASCADE,
  UNIQUE (task_id, id),
  FOREIGN KEY (task_id, parent_id)
    REFERENCES task_comments(task_id, id) ON DELETE CASCADE
);

CREATE INDEX task_comments_task_idx ON task_comments(task_id, created_at, id);
CREATE INDEX task_comments_parent_idx ON task_comments(parent_id);
