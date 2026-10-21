-- Images upload to Vercel Blob by default; a workspace may keep its own
-- S3-compatible storage instead. Personal storage and the admin shortcut are gone.
DROP TABLE IF EXISTS user_storage;

DELETE FROM workspace_storage WHERE source_user_id IS NOT NULL;
ALTER TABLE workspace_storage
  DROP CONSTRAINT workspace_storage_mode,
  DROP COLUMN source_user_id,
  ALTER COLUMN endpoint SET NOT NULL,
  ALTER COLUMN region SET NOT NULL,
  ALTER COLUMN bucket SET NOT NULL,
  ALTER COLUMN access_key_id SET NOT NULL,
  ALTER COLUMN secret_access_key SET NOT NULL;

-- An S3 object is read with the workspace's current storage, so changing the
-- bucket leaves earlier images behind.
CREATE TABLE uploads (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  project_id uuid NOT NULL REFERENCES projects(id),
  backend text NOT NULL CHECK (backend IN ('blob', 's3')),
  object_key text NOT NULL CHECK (length(object_key) BETWEEN 1 AND 300),
  content_type text NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
  size integer NOT NULL CHECK (size BETWEEN 1 AND 4194304),
  file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 200),
  uploaded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX uploads_workspace_id_idx ON uploads(workspace_id);
