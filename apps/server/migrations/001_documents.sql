CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id)
);
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE auth_attempts (
  key text PRIMARY KEY,
  attempts integer NOT NULL,
  resets_at timestamptz NOT NULL
);
CREATE TABLE projects (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id)
);
CREATE TABLE documents (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (length(body) <= 200000),
  version integer NOT NULL CHECK (version > 0),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id),
  UNIQUE (workspace_id, project_id, id)
);
CREATE INDEX documents_project_idx ON documents(project_id);
CREATE TABLE document_revisions (
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  document_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  body text NOT NULL,
  actor_id uuid NOT NULL REFERENCES users(id),
  operation_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('create', 'edit', 'restore')),
  restored_from_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, version),
  FOREIGN KEY (workspace_id, project_id, document_id) REFERENCES documents(workspace_id, project_id, id),
  FOREIGN KEY (document_id, restored_from_version) REFERENCES document_revisions(document_id, version),
  CHECK ((kind = 'restore') = (restored_from_version IS NOT NULL))
);
CREATE TABLE audit_events (
  operation_id uuid PRIMARY KEY REFERENCES document_revisions(operation_id),
  workspace_id uuid NOT NULL,
  project_id uuid NOT NULL,
  document_id uuid NOT NULL,
  before_version integer,
  after_version integer NOT NULL,
  initiator_id uuid NOT NULL REFERENCES users(id),
  confirmer_id uuid NOT NULL REFERENCES users(id),
  method text NOT NULL CHECK (method IN ('manual', 'restore')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, project_id, document_id) REFERENCES documents(workspace_id, project_id, id),
  FOREIGN KEY (document_id, before_version) REFERENCES document_revisions(document_id, version),
  FOREIGN KEY (document_id, after_version) REFERENCES document_revisions(document_id, version)
);
CREATE INDEX audit_events_document_idx ON audit_events(document_id, after_version);
CREATE FUNCTION prevent_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'History is immutable';
END;
$$;
CREATE TRIGGER revisions_immutable BEFORE UPDATE OR DELETE ON document_revisions
FOR EACH ROW EXECUTE FUNCTION prevent_history_change();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_history_change();
