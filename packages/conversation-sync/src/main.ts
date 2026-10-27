import { DatabaseSync } from "node:sqlite";
import { createSyncServer } from "./http.js";

const port = Number(process.env.SYNC_PORT ?? 8788);
const token = process.env.SYNC_TOKEN ?? "dev-token";
const accountId = process.env.SYNC_ACCOUNT ?? "local";
const dbPath = process.env.SYNC_DB ?? "conversation-sync.sqlite";
const db = new DatabaseSync(dbPath);
const server = createSyncServer({ db, accounts: new Map([[token, accountId]]) });
server.listen(port, "127.0.0.1", () => {
  console.log(`conversation sync listening on http://127.0.0.1:${port} account=${accountId}`);
});
