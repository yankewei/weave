-- Images without a workspace S3 now go to the deployment's default S3 store
-- (ADR 0003). Vercel Blob held no real data, so its rows are dropped.
DELETE FROM uploads WHERE backend = 'blob';
ALTER TABLE uploads
  DROP CONSTRAINT uploads_backend_check,
  ADD CONSTRAINT uploads_backend_check CHECK (backend IN ('default', 's3'));
