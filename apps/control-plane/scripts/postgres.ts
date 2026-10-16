import EmbeddedPostgres from "embedded-postgres";
const postgres = new EmbeddedPostgres({
  databaseDir: ".postgres-data",
  user: "postgres",
  password: process.env.POSTGRES_PASSWORD ?? "nexttools-local-only",
  port: Number(process.env.PGPORT ?? 55432),
  persistent: true,
});
await postgres.initialise();
await postgres.start();
console.log("PostgreSQL ready on 127.0.0.1:55432");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    await postgres.stop();
    process.exit(0);
  });
