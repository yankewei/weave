-- Direct cutover: there is no shared conversation history to import.
ALTER TABLE conversations DROP CONSTRAINT conversations_project_id_key;
ALTER TABLE conversations ADD CONSTRAINT conversations_project_owner_key UNIQUE (project_id, created_by);
ALTER TABLE conversations DROP COLUMN import_status;
