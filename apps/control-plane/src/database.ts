import { Pool } from "pg";

export function database(url: string) {
  return new Pool({ connectionString: url, max: 10 });
}
export async function migrate(db: Pool) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text NOT NULL);
    CREATE TABLE IF NOT EXISTS oidc_records (
      model text NOT NULL, id text NOT NULL, payload jsonb NOT NULL,
      expires_at timestamptz, PRIMARY KEY(model,id));
    CREATE INDEX IF NOT EXISTS oidc_grant ON oidc_records ((payload->>'grantId'));
    CREATE TABLE IF NOT EXISTS server_secrets (id text PRIMARY KEY, value jsonb NOT NULL);
    CREATE TABLE IF NOT EXISTS devices (
      id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id),
      name text NOT NULL, platform text NOT NULL, signing_key text NOT NULL,
      exchange_key text NOT NULL, revoked boolean NOT NULL DEFAULT false);
    CREATE TABLE IF NOT EXISTS pairings (
      id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id),
      target uuid NOT NULL REFERENCES devices(id), source uuid REFERENCES devices(id),
      token_hash text UNIQUE NOT NULL, expires_at timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'offered', workspaces jsonb NOT NULL DEFAULT '[]',
      operations jsonb NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS sync_events (
      sequence bigserial PRIMARY KEY, account_id uuid NOT NULL REFERENCES accounts(id),
      id uuid NOT NULL UNIQUE, source uuid NOT NULL REFERENCES devices(id),
      target uuid NOT NULL REFERENCES devices(id), workspace_id text NOT NULL,
      envelope jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS control_nonces (
      id uuid PRIMARY KEY, expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS http_proofs (
      proof text PRIMARY KEY, expires_at timestamptz NOT NULL);
    CREATE TABLE IF NOT EXISTS security_audit (
      id bigserial PRIMARY KEY, account_id uuid, device_id uuid,
      action text NOT NULL, decision text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
  `);
}
