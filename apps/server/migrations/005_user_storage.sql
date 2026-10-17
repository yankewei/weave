CREATE TABLE user_storage (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  endpoint text NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 300),
  region text NOT NULL CHECK (length(region) BETWEEN 1 AND 64),
  bucket text NOT NULL CHECK (length(bucket) BETWEEN 3 AND 63),
  prefix text NOT NULL DEFAULT '' CHECK (length(prefix) <= 200),
  access_key_id text NOT NULL CHECK (length(access_key_id) BETWEEN 1 AND 128),
  secret_access_key text NOT NULL CHECK (length(secret_access_key) BETWEEN 1 AND 256),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE workspace_storage
  ADD COLUMN source_user_id uuid REFERENCES users(id),
  ALTER COLUMN endpoint DROP NOT NULL,
  ALTER COLUMN region DROP NOT NULL,
  ALTER COLUMN bucket DROP NOT NULL,
  ALTER COLUMN access_key_id DROP NOT NULL,
  ALTER COLUMN secret_access_key DROP NOT NULL;

-- A shortcut stores only the admin, and reads that admin's current personal storage.
ALTER TABLE workspace_storage
  ADD CONSTRAINT workspace_storage_mode CHECK (
    (
      source_user_id IS NULL
      AND endpoint IS NOT NULL
      AND region IS NOT NULL
      AND bucket IS NOT NULL
      AND access_key_id IS NOT NULL
      AND secret_access_key IS NOT NULL
    )
    OR (
      source_user_id IS NOT NULL
      AND endpoint IS NULL
      AND region IS NULL
      AND bucket IS NULL
      AND prefix = ''
      AND access_key_id IS NULL
      AND secret_access_key IS NULL
    )
  );
