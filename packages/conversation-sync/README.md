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
`POST /v1/auth/login`. Passwords are stored as scrypt hashes.

Run Docker on the server, then point the desktop at it. In this directory:

```powershell
docker compose up -d --build
```

The service listens on port 8788. In the desktop, open Settings, then Cloud sync,
then Conversation sync. Set the server to `http://<server>:8788` and register or
sign in. Open that same URL in a browser to read the synced chats.
