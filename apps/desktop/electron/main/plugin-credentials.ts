import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export type CredentialEncryption = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

/** Encrypted, isolated credentials. A persisted null is also a migration tombstone. */
export function createPluginCredentials({ userData, encryption }: { userData: string; encryption: CredentialEncryption }) {
  const root = join(resolve(userData), "plugin-credentials");
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation);
    queue = next.catch(() => undefined);
    return next;
  };
  const validate = (pluginId: string, key: string) => {
    if (typeof pluginId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(pluginId) ||
        typeof key !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(key)) throw new Error("invalid_credential_key");
    if (!encryption.isEncryptionAvailable()) throw new Error("credential_encryption_unavailable");
    const hash = (value: string) => createHash("sha256").update(value).digest("hex");
    return join(root, `${hash(pluginId)}-${hash(key)}.bin`);
  };
  async function ensureRoot() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe_credential_path");
  }
  async function readEncrypted(path: string): Promise<string | null | undefined> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe_credential_path");
      const parsed: unknown = JSON.parse(encryption.decryptString(await readFile(path)));
      if (!parsed || typeof parsed !== "object" || !("value" in parsed) || !("version" in parsed) || parsed.version !== 1 ||
          (parsed.value !== null && typeof parsed.value !== "string")) throw new Error("invalid_credential_data");
      return parsed.value;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  async function persist(path: string, value: string | null) {
    const bytes = encryption.encryptString(JSON.stringify({ version: 1, value }));
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return {
    get(pluginId: string, key: string): Promise<string | null> {
      return serialize(async () => {
        const path = validate(pluginId, key);
        await ensureRoot();
        const existing = await readEncrypted(path);
        if (existing !== undefined) return existing;
        if (pluginId !== "pi.cloud-sync" || key !== "account") return null;
        // Keep the original encrypted file as a recoverable backup. The atomic
        // destination (including null on removal) makes this a one-time import.
        let legacy: unknown;
        try {
          const source = join(resolve(userData), "conversation-sync.json");
          const stat = await lstat(source);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe_credential_path");
          legacy = JSON.parse(await readFile(source, "utf8"));
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        }
        if (!legacy || typeof legacy !== "object" || !("baseUrl" in legacy) || typeof legacy.baseUrl !== "string" ||
            !("tokenEncrypted" in legacy) || typeof legacy.tokenEncrypted !== "string" ||
            !("account" in legacy) || typeof legacy.account !== "string") throw new Error("invalid_legacy_credentials");
        const value = JSON.stringify({ baseUrl: legacy.baseUrl, account: legacy.account,
          token: encryption.decryptString(Buffer.from(legacy.tokenEncrypted, "base64")),
          pendingDeletes: "pendingDeletes" in legacy && Array.isArray(legacy.pendingDeletes) ? legacy.pendingDeletes : [] });
        await persist(path, value);
        return value;
      });
    },
    set(pluginId: string, key: string, value: string): Promise<void> {
      return serialize(async () => {
        const path = validate(pluginId, key);
        if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 1_048_576) throw new Error("invalid_credential_value");
        await ensureRoot();
        await readEncrypted(path);
        await persist(path, value);
      });
    },
    remove(pluginId: string, key: string): Promise<void> {
      return serialize(async () => {
        const path = validate(pluginId, key);
        await ensureRoot();
        await readEncrypted(path);
        await persist(path, null);
      });
    },
  };
}
