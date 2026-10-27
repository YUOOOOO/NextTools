# Conversation sync

Self-hosted chat mirror. Save rules match nanomuse_cloud sync: one seq per
account, 16 KB text, attachment metadata only, one main conversation,
tombstones, and the 2,000 / 20,000 caps. See
`docs/spec/03-runtime/23-conversation-sync.md`.

```powershell
$env:SYNC_TOKEN = "dev-token"
$env:SYNC_ACCOUNT = "local"
$env:SYNC_PORT = "8788"
$env:SYNC_DB = "conversation-sync.sqlite"
node --experimental-strip-types src/main.ts
```

`POST /v1/sync/changes` with `Authorization: Bearer dev-token`.
