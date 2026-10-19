-- Encrypted secrets include a version prefix, nonce, tag, and base64url ciphertext.
ALTER TABLE workspace_storage
  DROP CONSTRAINT IF EXISTS workspace_storage_secret_access_key_check;
ALTER TABLE workspace_storage
  ADD CONSTRAINT workspace_storage_secret_access_key_check
  CHECK (length(secret_access_key) BETWEEN 1 AND 1024);

ALTER TABLE user_storage
  DROP CONSTRAINT IF EXISTS user_storage_secret_access_key_check;
ALTER TABLE user_storage
  ADD CONSTRAINT user_storage_secret_access_key_check
  CHECK (length(secret_access_key) BETWEEN 1 AND 1024);
