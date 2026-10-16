import { database, migrate } from "../src/database.js";
import { createAccount } from "../src/identity.js";
const [email] = process.argv.slice(2);
if (
  !process.env.DATABASE_URL ||
  !email ||
  !process.env.NEXTTOOLS_ACCOUNT_PASSWORD
)
  throw new Error(
    "Set DATABASE_URL, NEXTTOOLS_ACCOUNT_PASSWORD; pass email as argument",
  );
const db = database(process.env.DATABASE_URL);
try {
  await migrate(db);
  await createAccount(db, email, process.env.NEXTTOOLS_ACCOUNT_PASSWORD);
  console.log("Account created");
} finally {
  await db.end();
}
