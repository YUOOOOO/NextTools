import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  randomUUID,
  generateKeyPairSync,
} from "node:crypto";
import type { Pool } from "pg";
import {
  Provider,
  type AdapterPayload,
  type Configuration,
} from "oidc-provider";

export function hashPassword(password: string) {
  if (password.length < 12 || password.length > 256)
    throw new Error("Password must contain 12–256 characters");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function checkPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export async function createAccount(db: Pool, email: string, password: string) {
  await db.query(
    "INSERT INTO accounts(id,email,password_hash) VALUES($1,$2,$3)",
    [randomUUID(), email.trim().toLowerCase(), hashPassword(password)],
  );
}
export async function identityProvider(db: Pool, issuer: string) {
  class PostgresAdapter {
    constructor(private model: string) {}
    async upsert(id: string, payload: AdapterPayload, expiresIn?: number) {
      await db.query(
        `INSERT INTO oidc_records(model,id,payload,expires_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(model,id) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at`,
        [
          this.model,
          id,
          payload,
          expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
        ],
      );
    }
    async lookup(field: string, value: string) {
      const column = field === "id" ? "id" : `payload->>'${field}'`;
      const result = await db.query(
        `SELECT payload FROM oidc_records WHERE model=$1 AND ${column}=$2 AND (expires_at IS NULL OR expires_at>now())`,
        [this.model, value],
      );
      return result.rows[0]?.payload as AdapterPayload | undefined;
    }
    find(id: string) {
      return this.lookup("id", id);
    }
    findByUid(id: string) {
      return this.lookup("uid", id);
    }
    findByUserCode(id: string) {
      return this.lookup("userCode", id);
    }
    async consume(id: string) {
      await db.query(
        "UPDATE oidc_records SET payload=jsonb_set(payload,'{consumed}',to_jsonb(extract(epoch from now())::bigint)) WHERE model=$1 AND id=$2",
        [this.model, id],
      );
    }
    async destroy(id: string) {
      await db.query("DELETE FROM oidc_records WHERE model=$1 AND id=$2", [
        this.model,
        id,
      ]);
    }
    async revokeByGrantId(id: string) {
      await db.query("DELETE FROM oidc_records WHERE payload->>'grantId'=$1", [
        id,
      ]);
    }
  }
  let result = await db.query(
    "SELECT value FROM server_secrets WHERE id='oidc'",
  );
  if (!result.rowCount) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const key = {
      ...privateKey.export({ format: "jwk" }),
      kid: randomUUID(),
      use: "sig",
      alg: "RS256",
    };
    await db.query(
      "INSERT INTO server_secrets(id,value) VALUES('oidc',$1) ON CONFLICT DO NOTHING",
      [{ jwks: { keys: [key] }, cookies: [randomBytes(32).toString("hex")] }],
    );
    result = await db.query("SELECT value FROM server_secrets WHERE id='oidc'");
  }
  const secrets = result.rows[0].value;
  const config: Configuration = {
    adapter: PostgresAdapter,
    clients: [
      {
        client_id: "nexttools",
        application_type: "native",
        token_endpoint_auth_method: "none",
        redirect_uris: [
          "com.nexttools.client:/callback",
          "com.nexttools.mobile:/callback",
        ],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
    ],
    jwks: secrets.jwks,
    cookies: { keys: secrets.cookies },
    claims: { openid: ["sub"], email: ["email"] },
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
    },
    ttl: {
      AccessToken: 300,
      AuthorizationCode: 60,
      RefreshToken: 30 * 86400,
      Interaction: 600,
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    findAccount: async (_ctx, id) => {
      const account = (
        await db.query("SELECT id,email FROM accounts WHERE id=$1", [id])
      ).rows[0];
      return account
        ? {
            accountId: account.id,
            claims: async () => ({ sub: account.id, email: account.email }),
          }
        : undefined;
    },
  };
  return new Provider(issuer, config);
}
export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
