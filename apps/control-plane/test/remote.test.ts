import assert from "node:assert/strict";
import { test } from "node:test";
import {
  randomUUID,
  randomBytes,
  generateKeyPairSync,
  createHash,
  sign,
  diffieHellman,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  verify,
} from "node:crypto";
import { Pool } from "pg";
import WebSocket from "ws";
import { createServer } from "../src/server.js";
import { createAccount } from "../src/identity.js";
import { digest, signedText, type Envelope } from "../src/envelope.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "real OIDC, paired encrypted sync/control, replay and revocation",
  { skip: !databaseUrl, timeout: 60_000 },
  async () => {
    const schema = `remote_${randomUUID().replaceAll("-", "")}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    });
    const base = "http://127.0.0.1:18787";
    const { app } = await createServer(db, `${base}/oidc`);
    const sockets: WebSocket[] = [];
    try {
      await app.listen({ host: "127.0.0.1", port: 18787 });
      await createAccount(db, "remote@example.test", "test-password-12345");
      async function login() {
        const verifier = randomBytes(32).toString("base64url");
        const nonce = randomUUID();
        const state = randomUUID();
        const query = new URLSearchParams({
          client_id: "nexttools",
          response_type: "code",
          scope: "openid email offline_access",
          redirect_uri: "com.nexttools.client:/callback",
          state,
          nonce,
          prompt: "consent",
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
          code_challenge_method: "S256",
        });
        const cookies = new Map<string, string>();
        async function request(url: string, options: RequestInit = {}) {
          const response = await fetch(url, {
            ...options,
            headers: {
              ...options.headers,
              Cookie: [...cookies.values()].join("; "),
            },
            redirect: "manual",
          });
          for (const cookie of response.headers.getSetCookie())
            cookies.set(cookie.split("=", 1)[0], cookie.split(";", 1)[0]);
          return response;
        }
        let response = await request(`${base}/oidc/auth?${query}`);
        assert.equal(response.status, 303, await response.clone().text());
        const interaction = new URL(response.headers.get("location")!, base)
          .href;
        response = await request(interaction);
        const html = await response.text();
        assert.equal(response.status, 200, html);
        const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
        assert.ok(csrf, html);
        response = await request(interaction, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            email: "remote@example.test",
            password: "test-password-12345",
            csrf,
          }),
        });
        let callback = "";
        for (let i = 0; i < 6; i++) {
          const location = response.headers.get("location");
          assert.ok(location, await response.text());
          if (location.startsWith("com.nexttools.client:")) {
            callback = location;
            break;
          }
          response = await request(new URL(location, base).href);
        }
        const returned = new URL(callback);
        assert.equal(returned.searchParams.get("state"), state);
        assert.ok(returned.searchParams.get("code"), callback);
        const token = await fetch(`${base}/oidc/token`, {
          method: "POST",
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: "nexttools",
            code: returned.searchParams.get("code")!,
            redirect_uri: "com.nexttools.client:/callback",
            code_verifier: verifier,
          }),
        });
        const result = await token.json();
        assert.equal(token.status, 200, JSON.stringify(result));
        assert.ok(result.refresh_token);
        const claims = JSON.parse(
          Buffer.from(result.id_token.split(".")[1], "base64url").toString(),
        );
        assert.equal(claims.nonce, nonce);
        return result;
      }
      const desktopToken = await login();
      const mobileToken = await login();
      const makeDevice = (platform: "windows" | "ios") => {
        const signing = generateKeyPairSync("ed25519");
        const exchange = generateKeyPairSync("x25519");
        return {
          id: randomUUID(),
          name: platform,
          platform,
          signing,
          exchange,
          signingKey: signing.publicKey
            .export({ format: "der", type: "spki" })
            .subarray(-32)
            .toString("base64"),
          exchangeKey: exchange.publicKey
            .export({ format: "der", type: "spki" })
            .subarray(-32)
            .toString("base64"),
        };
      };
      const desktop = makeDevice("windows"),
        mobile = makeDevice("ios");
      type Device = typeof desktop;
      const signature = (d: Device, text: string) =>
        sign(null, Buffer.from(text), d.signing.privateKey).toString("base64");
      async function register(d: Device, token: string) {
        const response = await fetch(`${base}/v1/devices`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            id: d.id,
            name: d.name,
            platform: d.platform,
            signingKey: d.signingKey,
            exchangeKey: d.exchangeKey,
            signature: signature(
              d,
              [
                "device.v1",
                d.id,
                d.name,
                d.platform,
                d.signingKey,
                d.exchangeKey,
              ].join("\n"),
            ),
          }),
        });
        assert.equal(response.status, 200, await response.text());
      }
      await register(desktop, desktopToken.access_token);
      await register(mobile, mobileToken.access_token);
      function headers(
        d: Device,
        token: string,
        method: string,
        path: string,
        body?: unknown,
      ) {
        const stamp = String(Date.now());
        return {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-device-id": d.id,
          "x-device-time": stamp,
          "x-device-signature": signature(
            d,
            [
              "http.v1",
              method,
              path,
              stamp,
              digest(body === undefined ? "" : JSON.stringify(body)),
            ].join("\n"),
          ),
        };
      }
      async function api(
        d: Device,
        token: string,
        method: string,
        path: string,
        body?: unknown,
      ) {
        return fetch(base + path, {
          method,
          headers: headers(d, token, method, path, body),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      }
      const proof = headers(
        desktop,
        desktopToken.access_token,
        "GET",
        "/v1/devices",
      );
      assert.equal(
        (await fetch(`${base}/v1/devices`, { headers: proof })).status,
        200,
      );
      assert.equal(
        (await fetch(`${base}/v1/devices`, { headers: proof })).status,
        403,
      );
      assert.equal(
        (
          await api(
            mobile,
            mobileToken.access_token,
            "POST",
            "/v1/pairings",
            {},
          )
        ).status,
        403,
      );
      const offer = await (
        await api(
          desktop,
          desktopToken.access_token,
          "POST",
          "/v1/pairings",
          {},
        )
      ).json();
      const claim = await api(
        mobile,
        mobileToken.access_token,
        "POST",
        "/v1/pairings/claim",
        { token: offer.token },
      );
      assert.equal(claim.status, 200, await claim.text());
      assert.equal(
        (
          await api(
            mobile,
            mobileToken.access_token,
            "POST",
            "/v1/pairings/claim",
            { token: offer.token },
          )
        ).status,
        403,
      );
      const pairings = await (
        await api(desktop, desktopToken.access_token, "GET", "/v1/pairings")
      ).json();
      assert.equal(typeof pairings[0].expires, "number");
      const grant = {
        approved: true,
        workspaces: ["project"],
        operations: ["session.view", "session.prompt", "session.stop"],
      };
      assert.equal(
        (
          await api(
            mobile,
            mobileToken.access_token,
            "POST",
            `/v1/pairings/${offer.id}/resolve`,
            grant,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await api(
            desktop,
            desktopToken.access_token,
            "POST",
            `/v1/pairings/${offer.id}/resolve`,
            { ...grant, operations: ["approval.respond"] },
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await api(
            desktop,
            desktopToken.access_token,
            "POST",
            `/v1/pairings/${offer.id}/resolve`,
            grant,
          )
        ).status,
        200,
      );
      function key(a: Device, b: Device) {
        return hkdfSync(
          "sha256",
          diffieHellman({
            privateKey: a.exchange.privateKey,
            publicKey: b.exchange.publicKey,
          }),
          Buffer.from("nexttools.e2ee.v1"),
          Buffer.from("pairwise-encryption"),
          32,
        );
      }
      function seal(
        a: Device,
        b: Device,
        channel: Envelope["channel"],
        operation: Envelope["operation"],
        payload: unknown,
        workspace = "project",
        expires = Date.now() + 25_000,
      ): Envelope {
        const nonce = randomBytes(12);
        const e: Envelope = {
          id: randomUUID(),
          source: a.id,
          target: b.id,
          workspace,
          channel,
          operation,
          expires,
          nonce: nonce.toString("base64"),
          ciphertext: "",
          signature: "",
        };
        const cipher = createCipheriv("chacha20-poly1305", key(a, b), nonce, {
          authTagLength: 16,
        });
        cipher.setAAD(Buffer.from(signedText(e).slice(0, -1)), {
          plaintextLength: Buffer.byteLength(JSON.stringify(payload)),
        });
        e.ciphertext = Buffer.concat([
          cipher.update(JSON.stringify(payload)),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString("base64");
        e.signature = signature(a, signedText(e));
        return e;
      }
      function open(e: Envelope, a: Device, b: Device) {
        assert.ok(
          verify(
            null,
            Buffer.from(signedText(e)),
            a.signing.publicKey,
            Buffer.from(e.signature, "base64"),
          ),
        );
        const encrypted = Buffer.from(e.ciphertext, "base64");
        const cipher = createDecipheriv(
          "chacha20-poly1305",
          key(a, b),
          Buffer.from(e.nonce, "base64"),
          { authTagLength: 16 },
        );
        cipher.setAAD(
          Buffer.from(signedText(e).slice(0, -(e.ciphertext.length + 1))),
          { plaintextLength: encrypted.length - 16 },
        );
        cipher.setAuthTag(encrypted.subarray(-16));
        return JSON.parse(
          Buffer.concat([
            cipher.update(encrypted.subarray(0, -16)),
            cipher.final(),
          ]).toString(),
        );
      }
      const snapshot = seal(desktop, mobile, "sync", "snapshot", {
        private: "session index",
      });
      assert.equal(
        (
          await api(
            desktop,
            desktopToken.access_token,
            "POST",
            "/v1/sync",
            snapshot,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await api(
            desktop,
            desktopToken.access_token,
            "POST",
            "/v1/sync",
            snapshot,
          )
        ).status,
        200,
      );
      const sync = await (
        await api(mobile, mobileToken.access_token, "GET", "/v1/sync?cursor=0")
      ).json();
      assert.equal(sync.events.length, 1);
      assert.deepEqual(open(sync.events[0].envelope, desktop, mobile), {
        private: "session index",
      });
      const stored = (await db.query("SELECT envelope FROM sync_events"))
        .rows[0].envelope;
      assert.ok(!JSON.stringify(stored).includes("session index"));
      async function connect(d: Device, token: string) {
        const socket = new WebSocket(
          `${base.replace("http:", "ws:")}/v1/control`,
        );
        sockets.push(socket);
        const inbox: unknown[] = [];
        const waiters: ((v: any) => void)[] = [];
        socket.on("message", (data) => {
          const value = JSON.parse(data.toString());
          const waiter = waiters.shift();
          if (waiter) waiter(value);
          else inbox.push(value);
        });
        const next = () =>
          new Promise<any>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("Socket message timeout")),
              5000,
            );
            const done = (v: unknown) => {
              clearTimeout(timer);
              resolve(v);
            };
            if (inbox.length) done(inbox.shift());
            else waiters.push(done);
          });
        await new Promise<void>((resolve, reject) => {
          socket.once("open", resolve);
          socket.once("error", reject);
        });
        const time = Date.now(),
          nonce = randomUUID();
        socket.send(
          JSON.stringify({
            type: "auth",
            token,
            deviceId: d.id,
            time,
            nonce,
            signature: signature(
              d,
              ["ws.v1", d.id, time, nonce, digest(token)].join("\n"),
            ),
          }),
        );
        assert.equal((await next()).type, "ready");
        return { socket, next };
      }
      const d = await connect(desktop, desktopToken.access_token),
        m = await connect(mobile, mobileToken.access_token);
      const prompt = seal(mobile, desktop, "control", "session.prompt", {
        sessionId: "session",
        text: "private prompt",
      });
      m.socket.send(JSON.stringify(prompt));
      assert.deepEqual(open(await d.next(), mobile, desktop), {
        sessionId: "session",
        text: "private prompt",
      });
      m.socket.send(JSON.stringify(prompt));
      assert.equal((await m.next()).type, "error");
      for (const denied of [
        seal(mobile, desktop, "control", "session.stop", {}, "other-project"),
        seal(mobile, desktop, "control", "approval.respond", {}),
        seal(
          mobile,
          desktop,
          "control",
          "session.prompt",
          {},
          "project",
          Date.now() - 1,
        ),
      ]) {
        m.socket.send(JSON.stringify(denied));
        assert.equal((await m.next()).type, "error");
      }
      const event = seal(desktop, mobile, "event", "agent.event", {
        sessionId: "session",
        event: { type: "text_delta", delta: "private output" },
      });
      d.socket.send(JSON.stringify(event));
      assert.deepEqual(
        open(await m.next(), desktop, mobile).event.delta,
        "private output",
      );
      assert.equal(
        (
          await api(
            desktop,
            desktopToken.access_token,
            "POST",
            `/v1/pairings/${offer.id}/revoke`,
            {},
          )
        ).status,
        200,
      );
      m.socket.send(
        JSON.stringify(seal(mobile, desktop, "control", "session.stop", {})),
      );
      assert.equal((await m.next()).type, "error");
      assert.equal(
        (
          await (
            await api(
              mobile,
              mobileToken.access_token,
              "GET",
              "/v1/sync?cursor=0",
            )
          ).json()
        ).events.length,
        0,
      );
      assert.equal(
        (
          await api(
            desktop,
            desktopToken.access_token,
            "POST",
            `/v1/devices/${mobile.id}/revoke`,
            {},
          )
        ).status,
        200,
      );
      assert.equal(
        (await api(mobile, mobileToken.access_token, "GET", "/v1/devices"))
          .status,
        403,
      );
      const refreshed = await fetch(`${base}/oidc/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "nexttools",
          refresh_token: desktopToken.refresh_token,
        }),
      });
      assert.equal(refreshed.status, 200, await refreshed.text());
    } finally {
      for (const socket of sockets) socket.terminate();
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
