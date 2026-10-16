ALTER TABLE audit_events ADD COLUMN request_id TEXT;
ALTER TABLE audit_events ADD COLUMN parameter_digest TEXT;
PRAGMA user_version = 2;
