CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS device_preferences (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_installs (plugin_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
CREATE TABLE IF NOT EXISTS shortcut_bindings (plugin_id TEXT NOT NULL, command_id TEXT NOT NULL, accelerator TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL, PRIMARY KEY(plugin_id, command_id));
CREATE TABLE IF NOT EXISTS audit_events (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT, plugin_id TEXT NOT NULL, action TEXT NOT NULL, decision TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
PRAGMA user_version = 1;
