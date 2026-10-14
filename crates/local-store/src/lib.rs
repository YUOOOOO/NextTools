use nexttools_protocol::{Preferences, ShortcutBinding, Workspace};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use thiserror::Error;
#[derive(Debug, Error)]
pub enum StoreError {
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("数据库版本比当前客户端更新")]
    NewerSchema,
}
pub struct Store {
    conn: Connection,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self, StoreError> {
        let mut conn = Connection::open(path)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
        let version: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version > 1 {
            return Err(StoreError::NewerSchema);
        }
        if version == 0 {
            let tx = conn.transaction()?;
            tx.execute_batch(include_str!("../migrations/001_initial.sql"))?;
            tx.commit()?;
        }
        Ok(Self { conn })
    }
    pub fn workspaces(&self) -> Result<Vec<Workspace>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, name, root FROM workspaces ORDER BY name")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Workspace {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    root: r.get(2)?,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }
    pub fn add_workspace(&mut self, workspace: Workspace) -> Result<Workspace, StoreError> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO workspaces (id,name,root) VALUES (?1,?2,?3)",
            params![workspace.id, workspace.name, workspace.root],
        )?;
        let value = tx.query_row(
            "SELECT id,name,root FROM workspaces WHERE root = ?1",
            [workspace.root],
            |r| {
                Ok(Workspace {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    root: r.get(2)?,
                })
            },
        )?;
        tx.commit()?;
        Ok(value)
    }
    pub fn preferences(&self) -> Result<Preferences, StoreError> {
        let value: Option<String> = self
            .conn
            .query_row("SELECT value FROM device_preferences WHERE id=1", [], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(value
            .map(|v| serde_json::from_str(&v))
            .transpose()?
            .unwrap_or_default())
    }
    pub fn set_preferences(&self, preferences: &Preferences) -> Result<(), StoreError> {
        self.conn.execute("INSERT INTO device_preferences (id,value) VALUES (1,?1) ON CONFLICT(id) DO UPDATE SET value=excluded.value", [serde_json::to_string(preferences)?])?;
        Ok(())
    }
    pub fn plugin_enabled(&self, id: &str) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .query_row(
                "SELECT enabled FROM plugin_installs WHERE plugin_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or(true))
    }
    pub fn set_plugin_enabled(&self, id: &str, enabled: bool) -> Result<(), StoreError> {
        self.conn.execute("INSERT INTO plugin_installs (plugin_id,enabled) VALUES (?1,?2) ON CONFLICT(plugin_id) DO UPDATE SET enabled=excluded.enabled", params![id,enabled])?;
        Ok(())
    }
    pub fn shortcuts(&self) -> Result<Vec<ShortcutBinding>, StoreError> {
        let mut stmt = self.conn.prepare("SELECT plugin_id,command_id,accelerator,enabled FROM shortcut_bindings ORDER BY plugin_id,command_id")?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ShortcutBinding {
                    plugin_id: r.get(0)?,
                    command_id: r.get(1)?,
                    accelerator: r.get(2)?,
                    enabled: r.get(3)?,
                    status: "pending".into(),
                    error: None,
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(rows)
    }
    pub fn set_shortcut(&self, binding: &ShortcutBinding) -> Result<(), StoreError> {
        self.conn.execute("INSERT INTO shortcut_bindings(plugin_id,command_id,accelerator,enabled) VALUES (?1,?2,?3,?4) ON CONFLICT(plugin_id,command_id) DO UPDATE SET accelerator=excluded.accelerator,enabled=excluded.enabled", params![binding.plugin_id,binding.command_id,binding.accelerator,binding.enabled])?;
        Ok(())
    }
    pub fn remove_shortcut(&self, plugin: &str, command: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM shortcut_bindings WHERE plugin_id=?1 AND command_id=?2",
            params![plugin, command],
        )?;
        Ok(())
    }
    pub fn audit(
        &self,
        workspace: Option<&str>,
        plugin: &str,
        action: &str,
        decision: &str,
    ) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO audit_events(workspace_id,plugin_id,action,decision) VALUES (?1,?2,?3,?4)",
            params![workspace, plugin, action, decision],
        )?;
        Ok(())
    }
}
