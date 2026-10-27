-- Tasks and documents are addressed as DEV-n and DOC-n, numbered across the
-- whole workspace so a key alone identifies one object.
ALTER TABLE workspaces
  ADD COLUMN task_counter integer NOT NULL DEFAULT 0,
  ADD COLUMN document_counter integer NOT NULL DEFAULT 0;

-- Task history keeps the old per-project number in its snapshots; readers
-- take the current number from tasks. Rows missing their first history entry
-- still get a number, after the rest. WV-n typed into existing text is not rewritten.
ALTER TABLE tasks DROP CONSTRAINT tasks_project_id_number_key;
UPDATE tasks t SET number = ordered.number
FROM (
  SELECT t.id, row_number() OVER (
    PARTITION BY t.workspace_id ORDER BY e.created_at NULLS LAST, t.project_id, t.number
  ) AS number
  FROM tasks t LEFT JOIN task_events e ON e.task_id = t.id AND e.version = 1
) AS ordered
WHERE t.id = ordered.id;
ALTER TABLE tasks ADD CONSTRAINT tasks_workspace_number_key UNIQUE (workspace_id, number);
ALTER TABLE projects DROP COLUMN task_counter;

ALTER TABLE documents ADD COLUMN number integer;
UPDATE documents d SET number = ordered.number
FROM (
  SELECT d.id, row_number() OVER (
    PARTITION BY d.workspace_id ORDER BY r.created_at NULLS LAST, d.id
  ) AS number
  FROM documents d LEFT JOIN document_revisions r ON r.document_id = d.id AND r.version = 1
) AS ordered
WHERE d.id = ordered.id;
ALTER TABLE documents
  ALTER COLUMN number SET NOT NULL,
  ADD CONSTRAINT documents_number_positive CHECK (number > 0),
  ADD CONSTRAINT documents_workspace_number_key UNIQUE (workspace_id, number);

UPDATE workspaces w SET
  task_counter = (SELECT COALESCE(max(number), 0) FROM tasks WHERE workspace_id = w.id),
  document_counter = (SELECT COALESCE(max(number), 0) FROM documents WHERE workspace_id = w.id);
