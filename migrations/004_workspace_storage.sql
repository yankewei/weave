CREATE TABLE workspace_storage (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id),
  endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 300),
  region text NOT NULL CHECK (length(region) BETWEEN 1 AND 64),
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 3 AND 63),
  prefix text NOT NULL DEFAULT '' CHECK (length(prefix) <= 200),
  access_key_id text NOT NULL CHECK (length(access_key_id) BETWEEN 1 AND 128),
  secret_access_key text NOT NULL CHECK (length(secret_access_key) BETWEEN 1 AND 256),
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
