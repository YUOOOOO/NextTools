import { database } from "./database.js";
import { createServer } from "./server.js";
const url = process.env.DATABASE_URL;
const issuer = process.env.OIDC_ISSUER;
if (!url || !issuer)
  throw new Error("DATABASE_URL and OIDC_ISSUER are required");
const db = database(url);
const { app } = await createServer(db, issuer);
await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
});
console.log(`NextTools control plane listening at ${issuer}`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
