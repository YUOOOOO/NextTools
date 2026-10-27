import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createSyncServer } from "./http.js";
import { AccountBook } from "./accounts.js";

const fixtures: Array<{ server: ReturnType<typeof createSyncServer>; db: DatabaseSync }> = [];
afterEach(async () => {
  for (const { server, db } of fixtures.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
});
async function fixture() {
  const db = new DatabaseSync(":memory:");
  const server = createSyncServer({ db, accounts: new Map() });
  fixtures.push({ server, db });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (path: string, method = "GET", body?: unknown, token?: string) => fetch(base + path, {
    method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
it("serves the reused console and every bundled asset at root and /app/", async () => {
  const api = await fixture();
  const root = await api("/");
  expect(await root.text()).toContain('id="app"');
  const redirect = await api("/app");
  expect(redirect.url.endsWith("/app/")).toBe(true);
  for (const prefix of ["", "/app"]) {
    const index = await api(`${prefix}/`);
    expect(await index.text()).toContain('src="app.js"');
    for (const asset of ["app.js", "app.css", "icon.svg", "mark.svg", "LICENSE"]) {
      const response = await api(`${prefix}/${asset}`);
      expect(response.status, asset).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
    }
  }
  const script = await api("/app/app.js");
  expect(await script.text()).toContain('call(d.id, "task"');
  const config = await api("/v1/config");
  expect(await config.json()).toMatchObject({ password_min_len: 6 });
});
it("loads the original account sheet, changes password, revokes another session, then signs out everywhere", async () => {
  const api = await fixture();
  const register = await api("/v1/auth/register", "POST", { identifier: "ada", password: "secret1", device: "Web test" });
  const first = await register.json() as { token: string };
  const login = await api("/v1/auth/login", "POST", { identifier: "ada", password: "secret1", device: "Desktop test" });
  const second = await login.json() as { token: string };
  const me = await api("/v1/me", "GET", undefined, first.token);
  expect(await me.json()).toMatchObject({ account: { hint: "ada", has_password: true, sessions: 2 }, capabilities: { billing: false, contribution: false } });
  const listed = await api("/v1/me/sessions", "GET", undefined, first.token);
  const { sessions } = await listed.json() as { sessions: Array<{ prefix: string; current: boolean; device: string }> };
  expect(sessions).toHaveLength(2);
  expect(sessions.find((s) => s.current)?.device).toBe("Web test");
  expect(JSON.stringify(sessions)).not.toContain(first.token);
  expect(JSON.stringify(sessions)).not.toContain(second.token);
  const eventList = await api("/v1/me/events?limit=12", "GET", undefined, first.token);
  expect(await eventList.json()).toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ kind: "sign_in.password" })]) });
  const change = await api("/v1/auth/password", "POST", { current: "secret1", password: "secret2" }, first.token);
  expect(change.status).toBe(204);
  expect((await api("/v1/auth/login", "POST", { identifier: "ada", password: "secret1" })).status).toBe(401);
  const other = sessions.find((s) => !s.current)!;
  expect((await api(`/v1/me/sessions/${other.prefix}`, "DELETE", undefined, first.token)).status).toBe(204);
  expect((await api("/v1/me", "GET", undefined, second.token)).status).toBe(401);
  expect((await api("/v1/auth/sign-out-all", "POST", {}, first.token)).status).toBe(204);
  expect((await api("/v1/me", "GET", undefined, first.token)).status).toBe(401);
});
it("does not let another account revoke a session", async () => {
  const api = await fixture();
  const a = await (await api("/v1/auth/register", "POST", { identifier: "alpha", password: "secret1" })).json() as { token: string };
  const b = await (await api("/v1/auth/register", "POST", { identifier: "bravo", password: "secret1" })).json() as { token: string };
  const list = await (await api("/v1/me/sessions", "GET", undefined, a.token)).json() as { sessions: Array<{ prefix: string }> };
  expect((await api(`/v1/me/sessions/${list.sessions[0].prefix}`, "DELETE", undefined, b.token)).status).toBe(404);
  expect((await api("/v1/me", "GET", undefined, a.token)).status).toBe(200);
});

it("adds portal tables without losing a pre-portal password or session", () => {
  const db = new DatabaseSync(":memory:");
  const accounts = new AccountBook(db);
  const old = accounts.register("existing-user", "secret1");
  const server = createSyncServer({ db, accounts: new Map() });
  expect(accounts.accountForToken(old.token)).toBe("existing-user");
  expect(accounts.login("existing-user", "secret1").account).toBe("existing-user");
  expect(db.prepare("SELECT version FROM cloud_portal_schema").get()).toMatchObject({ version: 1 });
  server.close(); db.close();
});
