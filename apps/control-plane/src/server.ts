import Fastify from "fastify";
import formbody from "@fastify/formbody";
import websocket from "@fastify/websocket";
import rateLimit from "@fastify/rate-limit";
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { WebSocket } from "ws";
import { z } from "zod";
import { identityProvider, checkPassword, escapeHtml } from "./identity.js";
import {
  envelopeSchema,
  digest,
  signedText,
  validSignature,
} from "./envelope.js";
import { migrate } from "./database.js";

const scopes = z
  .array(
    z.enum([
      "session.view",
      "session.prompt",
      "session.stop",
      "approval.respond",
    ]),
  )
  .min(1);
const deviceSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(80),
    platform: z.enum(["windows", "macos", "linux", "ios", "android"]),
    signingKey: z.string().length(44),
    exchangeKey: z.string().length(44),
    signature: z.string(),
  })
  .strict();
type Device = {
  id: string;
  account_id: string;
  name: string;
  platform: string;
  signing_key: string;
  exchange_key: string;
  revoked: boolean;
};
const publicDevice = (d: Device) => ({
  id: d.id,
  name: d.name,
  platform: d.platform,
  signingKey: d.signing_key,
  exchangeKey: d.exchange_key,
  revoked: d.revoked,
});

export async function createServer(db: Pool, issuer: string) {
  await migrate(db);
  const provider = await identityProvider(db, issuer);
  const app = Fastify({ logger: false, bodyLimit: 5_000_000 });
  await app.register(formbody);
  await app.register(websocket, { options: { maxPayload: 5_000_000 } });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  const peers = new Map<
    string,
    { socket: WebSocket; account: string; expires: number }
  >();
  const audit = (
    account: string | null,
    device: string | null,
    action: string,
    decision: string,
  ) =>
    db.query(
      "INSERT INTO security_audit(account_id,device_id,action,decision) VALUES($1,$2,$3,$4)",
      [account, device, action, decision],
    );
  const fail = (message: string, statusCode = 403): never => {
    throw Object.assign(new Error(message), { statusCode });
  };
  async function account(token: string) {
    const access = await provider.AccessToken.find(token);
    if (
      !access ||
      access.isExpired ||
      !access.accountId ||
      access.clientId !== "nexttools"
    )
      return fail("Authentication required", 401);
    return { id: access.accountId, expires: access.exp! * 1000 };
  }
  async function device(accountId: string, id: string) {
    if (!z.uuid().safeParse(id).success) return fail("Invalid device");
    const row = (
      await db.query(
        "SELECT * FROM devices WHERE id=$1 AND account_id=$2 AND revoked=false",
        [id, accountId],
      )
    ).rows[0] as Device | undefined;
    return row ?? fail("Device revoked or unavailable");
  }
  async function auth(req: {
    headers: Record<string, unknown>;
    method: string;
    url: string;
    body?: unknown;
  }) {
    const bearer = String(req.headers.authorization ?? "");
    const user = await account(
      bearer.startsWith("Bearer ") ? bearer.slice(7) : "",
    );
    const d = await device(user.id, String(req.headers["x-device-id"] ?? ""));
    const stamp = String(req.headers["x-device-time"] ?? "");
    const signature = String(req.headers["x-device-signature"] ?? "");
    const text = [
      "http.v1",
      req.method,
      req.url,
      stamp,
      digest(req.body === undefined ? "" : JSON.stringify(req.body)),
    ].join("\n");
    if (
      !/^\d{13}$/.test(stamp) ||
      Math.abs(Date.now() - Number(stamp)) > 30_000 ||
      !validSignature(d.signing_key, text, signature)
    )
      return fail("Invalid device proof");
    await db.query("DELETE FROM http_proofs WHERE expires_at<now()");
    const proof = await db.query(
      "INSERT INTO http_proofs(proof,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING proof",
      [digest(`${d.id}:${signature}`), new Date(Number(stamp) + 30_000)],
    );
    if (!proof.rowCount) return fail("Device proof replayed");
    return { user, d };
  }
  async function grant(
    user: string,
    source: string,
    target: string,
    workspace: string,
    operation: string,
  ) {
    const row = (
      await db.query(
        `SELECT * FROM pairings WHERE account_id=$1 AND status='approved'
      AND ((source=$2 AND target=$3) OR (source=$3 AND target=$2)) AND workspaces ? $4`,
        [user, source, target, workspace],
      )
    ).rows[0];
    if (
      !row ||
      (operation !== "snapshot" &&
        operation !== "result" &&
        operation !== "agent.event" &&
        !row.operations.includes(operation))
    )
      return fail("Pairing or scope denied");
    return row;
  }
  async function validateEnvelope(
    user: string,
    sender: Device,
    input: unknown,
    channel: string,
  ) {
    const e = envelopeSchema.parse(input);
    if (
      e.source !== sender.id ||
      e.channel !== channel ||
      e.target === e.source
    )
      return fail("Invalid envelope route");
    await device(user, e.target);
    const pairing = await grant(
      user,
      e.source,
      e.target,
      e.workspace,
      e.operation,
    );
    if (
      channel === "control" &&
      (pairing.source !== e.source ||
        ![
          "session.view",
          "session.prompt",
          "session.stop",
          "approval.respond",
        ].includes(e.operation))
    )
      return fail("Control direction denied");
    if (
      (channel === "event" || channel === "sync") &&
      pairing.target !== e.source
    )
      return fail("Desktop source required");
    if (channel === "sync" && e.operation !== "snapshot")
      return fail("Invalid sync operation");
    if (
      (channel === "sync" ||
        (channel === "event" && e.operation === "agent.event")) &&
      !pairing.operations.includes("session.view")
    )
      return fail("Session view scope required");
    if (channel === "event" && !["result", "agent.event"].includes(e.operation))
      return fail("Invalid event operation");
    if (!validSignature(sender.signing_key, signedText(e), e.signature))
      return fail("Invalid envelope signature");
    if (
      channel !== "sync" &&
      (e.expires <= Date.now() || e.expires > Date.now() + 30_000)
    )
      return fail("Expired control envelope");
    return e;
  }
  app.setErrorHandler((error, _req, reply) => {
    const e = error as Error & { statusCode?: number };
    reply
      .code(e.statusCode ?? (error instanceof z.ZodError ? 400 : 500))
      .send({
        error:
          e.statusCode || error instanceof z.ZodError
            ? e.message
            : "Internal server error",
      });
  });
  app.get("/health", async () => ({ ok: true }));
  app.get("/interaction/:uid", async (req, reply) => {
    const details = await provider.interactionDetails(req.raw, reply.raw);
    const uid = escapeHtml(details.uid);
    const csrf = digest(`${details.uid}:${details.jti}`);
    return reply
      .header("Cache-Control", "no-store")
      .header(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      )
      .type("text/html")
      .send(
        `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>登录 NextTools</title><style>body{font:16px system-ui;max-width:380px;margin:12vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin:10px 0}button{cursor:pointer}</style><h1>登录 NextTools</h1><p>此登录不会自动授权其他设备控制电脑。</p><form method="post" action="/interaction/${uid}"><input type="hidden" name="csrf" value="${csrf}"><label>邮箱<input name="email" type="email" autocomplete="username" required></label><label>密码<input name="password" type="password" autocomplete="current-password" maxlength="256" required></label><button>登录并继续</button></form></html>`,
      );
  });
  app.post(
    "/interaction/:uid",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const details = await provider.interactionDetails(req.raw, reply.raw);
      const body = z
        .object({
          email: z.email(),
          password: z.string().max(256),
          csrf: z.string(),
        })
        .parse(req.body);
      if (body.csrf !== digest(`${details.uid}:${details.jti}`))
        return fail("Invalid login state");
      const row = (
        await db.query("SELECT * FROM accounts WHERE email=$1", [
          body.email.toLowerCase(),
        ])
      ).rows[0];
      const valid = checkPassword(
        body.password,
        row?.password_hash ??
          "00000000000000000000000000000000:" + "00".repeat(64),
      );
      if (!row || !valid) return fail("账号或密码错误", 401);
      const g = new provider.Grant({
        accountId: row.id,
        clientId: "nexttools",
      });
      g.addOIDCScope("openid email offline_access");
      const grantId = await g.save();
      reply.hijack();
      await provider.interactionFinished(
        req.raw,
        reply.raw,
        { login: { accountId: row.id }, consent: { grantId } },
        { mergeWithLastSubmission: false },
      );
    },
  );
  // Hand the raw request to the standards implementation, preserving its form parser and cookies.
  app.addHook("onRequest", async (req, reply) => {
    if (req.url.startsWith("/oidc/")) {
      (req.raw as typeof req.raw & { originalUrl: string }).originalUrl =
        req.url;
      req.raw.url = req.url.slice(5);
      reply.hijack();
      await provider.callback()(req.raw, reply.raw);
    }
  });
  app.get("/v1/me", async (req) => {
    const token = String(req.headers.authorization ?? "").replace(
      /^Bearer /,
      "",
    );
    const user = await account(token);
    return (
      await db.query("SELECT id,email FROM accounts WHERE id=$1", [user.id])
    ).rows[0];
  });
  app.post("/v1/devices", async (req) => {
    const user = await account(
      String(req.headers.authorization ?? "").replace(/^Bearer /, ""),
    );
    const d = deviceSchema.parse(req.body);
    if (
      Buffer.from(d.exchangeKey, "base64").length !== 32 ||
      !validSignature(
        d.signingKey,
        [
          "device.v1",
          d.id,
          d.name,
          d.platform,
          d.signingKey,
          d.exchangeKey,
        ].join("\n"),
        d.signature,
      )
    )
      return fail("Invalid device registration");
    await db.query(
      `INSERT INTO devices(id,account_id,name,platform,signing_key,exchange_key) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO NOTHING`,
      [d.id, user.id, d.name, d.platform, d.signingKey, d.exchangeKey],
    );
    const existing = await device(user.id, d.id);
    if (
      existing.signing_key !== d.signingKey ||
      existing.exchange_key !== d.exchangeKey
    )
      return fail("Device key mismatch");
    await audit(user.id, d.id, "device.register", "allowed");
    return publicDevice(existing);
  });
  app.get("/v1/devices", async (req) => {
    const { user } = await auth(req);
    return (
      await db.query(
        "SELECT * FROM devices WHERE account_id=$1 ORDER BY name",
        [user.id],
      )
    ).rows.map(publicDevice);
  });
  app.post("/v1/devices/:id/revoke", async (req) => {
    const { user, d } = await auth(req);
    const id = z.uuid().parse((req.params as { id: string }).id);
    await device(user.id, id);
    await db.query(
      "UPDATE devices SET revoked=true WHERE id=$1 AND account_id=$2",
      [id, user.id],
    );
    await db.query(
      "UPDATE pairings SET status='revoked' WHERE source=$1 OR target=$1",
      [id],
    );
    await db.query("DELETE FROM sync_events WHERE source=$1 OR target=$1", [
      id,
    ]);
    peers.get(id)?.socket.close(1008, "Device revoked");
    peers.delete(id);
    await audit(user.id, d.id, "device.revoke", "allowed");
    return { ok: true };
  });
  app.post("/v1/pairings", async (req) => {
    const { user, d } = await auth(req);
    if (["ios", "android"].includes(d.platform))
      return fail("Pairing must originate on desktop");
    const token = randomBytes(24).toString("base64url");
    const id = randomUUID();
    const expires = Date.now() + 300_000;
    await db.query(
      "INSERT INTO pairings(id,account_id,target,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)",
      [id, user.id, d.id, digest(token), new Date(expires)],
    );
    return { id, token, expires };
  });
  app.post("/v1/pairings/claim", async (req) => {
    const { user, d } = await auth(req);
    const { token } = z
      .object({ token: z.string().min(20).max(100) })
      .parse(req.body);
    const row = (
      await db.query(
        "UPDATE pairings SET source=$1,status='pending' WHERE token_hash=$2 AND account_id=$3 AND status='offered' AND expires_at>now() AND target<>$1 RETURNING id,target",
        [d.id, digest(token), user.id],
      )
    ).rows[0];
    if (!row) return fail("Pairing expired or already used");
    return row;
  });
  app.get("/v1/pairings", async (req) => {
    const { user, d } = await auth(req);
    return (
      await db.query(
        `SELECT id,target,source,status,workspaces,operations,(extract(epoch from expires_at)*1000)::double precision AS expires
      FROM pairings WHERE account_id=$1 AND (source=$2 OR target=$2) AND (status='approved' OR (status='pending' AND expires_at>now()))`,
        [user.id, d.id],
      )
    ).rows;
  });
  app.post("/v1/pairings/:id/resolve", async (req) => {
    const { user, d } = await auth(req);
    const id = z.uuid().parse((req.params as { id: string }).id);
    const body = z
      .object({
        approved: z.boolean(),
        workspaces: z.array(z.string().regex(/^[\w.-]+$/)).min(1),
        operations: scopes,
      })
      .strict()
      .parse(req.body);
    if (body.operations.includes("approval.respond"))
      return fail("Remote high-risk approval disabled");
    const row = (
      await db.query(
        "UPDATE pairings SET status=$1,workspaces=$2,operations=$3 WHERE id=$4 AND target=$5 AND account_id=$6 AND status='pending' AND expires_at>now() RETURNING id",
        [
          body.approved ? "approved" : "denied",
          JSON.stringify(body.workspaces),
          JSON.stringify(body.operations),
          id,
          d.id,
          user.id,
        ],
      )
    ).rows[0];
    if (!row) return fail("Pairing confirmation expired");
    await audit(
      user.id,
      d.id,
      "pairing.resolve",
      body.approved ? "allowed" : "denied",
    );
    return { ok: true };
  });
  app.post("/v1/pairings/:id/revoke", async (req) => {
    const { user, d } = await auth(req);
    const id = z.uuid().parse((req.params as { id: string }).id);
    await db.query(
      "UPDATE pairings SET status='revoked' WHERE id=$1 AND account_id=$2 AND (source=$3 OR target=$3)",
      [id, user.id, d.id],
    );
    await db.query(
      "DELETE FROM sync_events WHERE account_id=$1 AND NOT EXISTS (SELECT 1 FROM pairings p WHERE p.status='approved' AND p.source=sync_events.target AND p.target=sync_events.source AND p.workspaces ? sync_events.workspace_id)",
      [user.id],
    );
    await audit(user.id, d.id, "pairing.revoke", "allowed");
    return { ok: true };
  });
  app.post("/v1/sync", async (req) => {
    const { user, d } = await auth(req);
    const e = await validateEnvelope(user.id, d, req.body, "sync");
    const inserted = await db.query(
      "INSERT INTO sync_events(account_id,id,source,target,workspace_id,envelope) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING sequence",
      [user.id, e.id, e.source, e.target, e.workspace, e],
    );
    if (!inserted.rowCount) {
      const old = (
        await db.query(
          "SELECT envelope FROM sync_events WHERE id=$1 AND account_id=$2",
          [e.id, user.id],
        )
      ).rows[0];
      if (!old || signedText(old.envelope) !== signedText(e))
        return fail("Conflicting sync ID");
    }
    return { ok: true };
  });
  app.get("/v1/sync", async (req) => {
    const { user, d } = await auth(req);
    const cursor = z.coerce
      .number()
      .int()
      .nonnegative()
      .parse((req.query as { cursor?: string }).cursor ?? 0);
    const rows = (
      await db.query(
        `SELECT sequence,envelope FROM sync_events s WHERE account_id=$1 AND target=$2 AND sequence>$3
      AND EXISTS(SELECT 1 FROM pairings p WHERE p.status='approved' AND p.target=s.source AND p.source=s.target AND p.workspaces ? s.workspace_id)
      AND EXISTS(SELECT 1 FROM devices d WHERE d.id=s.source AND d.revoked=false) ORDER BY sequence LIMIT 100`,
        [user.id, d.id, cursor],
      )
    ).rows;
    return { events: rows, cursor: rows.at(-1)?.sequence ?? String(cursor) };
  });
  app.get("/v1/control", { websocket: true }, (socket) => {
    let identity: { user: string; device: Device; expires: number } | undefined;
    let busy = Promise.resolve();
    const timer = setTimeout(
      () => socket.close(1008, "Authentication required"),
      5000,
    );
    socket.on("close", () => {
      clearTimeout(timer);
      if (identity && peers.get(identity.device.id)?.socket === socket)
        peers.delete(identity.device.id);
    });
    socket.on("message", (data) => {
      busy = busy
        .then(async () => {
          const message = JSON.parse(data.toString());
          if (!identity) {
            const a = z
              .object({
                type: z.literal("auth"),
                token: z.string(),
                deviceId: z.uuid(),
                time: z.number().int(),
                nonce: z.uuid(),
                signature: z.string(),
              })
              .parse(message);
            const user = await account(a.token);
            const d = await device(user.id, a.deviceId);
            if (
              Math.abs(Date.now() - a.time) > 30_000 ||
              !validSignature(
                d.signing_key,
                ["ws.v1", d.id, a.time, a.nonce, digest(a.token)].join("\n"),
                a.signature,
              )
            )
              return fail("Invalid socket proof");
            await db.query(
              "INSERT INTO control_nonces(id,expires_at) VALUES($1,$2)",
              [a.nonce, new Date(Date.now() + 60_000)],
            );
            peers.get(d.id)?.socket.close(1000, "Reconnected");
            identity = { user: user.id, device: d, expires: user.expires };
            peers.set(d.id, {
              socket,
              account: user.id,
              expires: user.expires,
            });
            clearTimeout(timer);
            socket.send(JSON.stringify({ type: "ready" }));
            return;
          }
          if (identity.expires <= Date.now()) return fail("Token expired", 401);
          const sender = await device(identity.user, identity.device.id);
          const e = await validateEnvelope(
            identity.user,
            sender,
            message,
            message.channel === "event" ? "event" : "control",
          );
          const target = peers.get(e.target);
          if (
            !target ||
            target.account !== identity.user ||
            target.expires <= Date.now()
          )
            return fail("Target offline", 409);
          await db.query("DELETE FROM control_nonces WHERE expires_at<now()");
          await db.query(
            "INSERT INTO control_nonces(id,expires_at) VALUES($1,$2)",
            [e.id, new Date(e.expires)],
          );
          target.socket.send(JSON.stringify(e));
          await audit(identity.user, sender.id, "control.route", "allowed");
        })
        .catch(async () => {
          if (identity)
            await audit(
              identity.user,
              identity.device.id,
              "control.route",
              "denied",
            ).catch(() => {});
          if (socket.readyState === 1)
            socket.send(
              JSON.stringify({
                type: "error",
                error:
                  "Control rejected: authentication, pairing, expiry, replay or offline target",
              }),
            );
        });
    });
  });
  app.addHook("onClose", async () => {
    for (const peer of peers.values()) peer.socket.close(1001);
  });
  return { app, provider };
}
