# Conversation sync

Self-hosted chat mirror. Save rules match nanomuse_cloud sync: one seq per
account, 16 KB text, attachment metadata only, one main conversation,
tombstones, and the 2,000 / 20,000 caps. See
`docs/spec/03-runtime/23-conversation-sync.md`.

```powershell
pnpm build
pnpm start
```

Register with `POST /v1/auth/register` and `{account, password}`. Sign in with
`POST /v1/auth/login`. An account may also be an e-mail or a mainland phone.
`POST /v1/auth/code` logs a six-digit code; it does not send SMS.
Passwords are stored as scrypt hashes. `POST /v1/chat/completions` answers
503 until `CONVERSATION_SYNC_UPSTREAM_KEY` is set.

`/v1/hub` forwards calls. The desktop asks before `shell`, `files`,
`file.get`, `file.put`, `open`, or `screen`. Computers stay listed after they
disconnect.

Run Docker on the server, then point the desktop at it. In this directory:

```powershell
docker compose up -d --build
```

The service listens on port 8788. In the desktop, open Settings, then Cloud sync,
then Conversation sync. Set the server to `http://<server>:8788` and register or
sign in. Open that same URL (or `/app/`) in a browser to select a device and
send tasks using the reused nanoMuse console. Each device supports multiple
Web conversations with New conversation, independent task context and persisted
message history; existing single-conversation history is preserved. Account settings include sign-in
sessions, password changes, sign-out everywhere and sync controls. Signed-in
desktops automatically backfill and upload enabled accounts every 15 seconds,
and request an upload after a Web task finishes. The web sidebar's Synced
conversations reads cloud text and refreshes when other devices upload; it
survives page reloads and cleared browser task history. The previous
sync inspection page remains available at `/sync-view`.

The build includes the complete console asset directory and GPLv3 notices, not
just one HTML file. Rebuild the Docker image after updating. See
[console compatibility](CONSOLE-COMPATIBILITY.md) for reused code, supported
contracts, test commands and the explicitly unsupported operator features.
