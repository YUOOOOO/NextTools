import { DatabaseSync } from "node:sqlite";
import { createSyncServer } from "./http.js";

const port = Number(process.env.SYNC_PORT ?? 8788);
const host = process.env.SYNC_HOST ?? "127.0.0.1";
const dbPath = process.env.SYNC_DB ?? "conversation-sync.sqlite";
const db = new DatabaseSync(dbPath);
const server = createSyncServer({ db, accounts: new Map() });
server.listen(port, host, () => {
  console.log(`conversation sync listening on http://${host}:${port}`);
});
