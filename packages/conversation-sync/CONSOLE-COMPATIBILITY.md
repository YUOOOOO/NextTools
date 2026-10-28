# nanoMuse console compatibility

Reference inspected: Pilot checkout `bec42d8c3a999c681aecd79c7f6bbbbc6d7f10c4`.
The Docker entry point is `cloud/Dockerfile` -> `nanomuse-cloud` ->
`nanomuse_cloud/api.py`. `harness/dsh-nanomuse/src/cloud.ts`, `relay.ts`,
`hub.ts` and `actions.ts` are its desktop clients, not the Docker server.
The end-user console is `cloud/nanomuse_cloud/console`; the separate React
operator console is `cloud/console`. This change reuses the end-user console,
not the operator console and not the desktop's client rendering tree.

## Reused assets and logic

`src/console` contains the original HTML, stylesheet, icons and adapted
JavaScript. Its device picker, task/event/result chat, reconnect behavior,
account sheet, password form, session list and sync controls are retained.
See `src/console/NOTICE.md` for source hashes and the GPLv3 license boundary.
There is no new front-end dependency, CDN, or build toolchain.

## Contract mapping

| Console call | Implementation |
| --- | --- |
| `/`, `/app/`, `/app` | Shared console; `/app` redirects to the trailing-slash URL |
| `/v1/config`, `/healthz` | Public password/code timing config and health |
| auth register/login | Existing scrypt accounts; username, phone or email; `api_key` |
| `/v1/me` | Actual password status, account creation time, session count and capabilities |
| `/v1/me/sessions`, session DELETE | Account-scoped sessions; opaque public ids, never bearer tokens |
| `/v1/me/events` | Real account/sign-in/password/sign-out events, no chat payloads |
| auth password/sign-out/sign-out-all | Existing verification; token revocation closes live Hub connections |
| Hub hello/welcome/devices | Account-scoped presence and persistent offline computer/phone list |
| Hub forget | Forget an offline device, then broadcast the updated list |
| Hub task/stop/event/result | Forwarded to the selected desktop; normal Agent admission/abort handlers |
| sync state/changes | Existing nanomuse save rules; automatic desktop uploads and web read-only cloud history |

`task` creates a dedicated desktop session per server/account/caller/conversation,
sets permission mode to `ask`, observes the admitted turn and returns its final
assistant text. Progress never includes reasoning or tool arguments/results.
Disconnect/sign-out cancels the exact in-flight turn and suppresses stale frames.
Conversation-to-session mapping currently survives socket reconnects but not a
full desktop restart. Each desktop installation has its own persisted device id.

## Explicitly not implemented

Operator/admin dashboard, charging/quotas, invitations, training contributions,
real SMS/mail delivery, hosted media and avatar generation are not implemented.
Their account-page cards are hidden by explicit server capabilities, not backed
by invented balances or successful no-ops. Password removal is hidden because
this deployment's UI uses password login. Existing logged-code API remains a
development-only facility; the reused sign-in page does not claim codes are sent.
`/v1/models` still has an empty menu. Model proxy still requires an operator key.
S3 configuration sync is unchanged.

## Build and checks

Both local build and Docker use `scripts/copy-console.mjs` to ship the complete
asset directory (including license), avoiding stale single-HTML deployments.
`src/portal.test.ts` and `src/portal-hub.test.ts` exercise the console API and
real HTTP/WebSocket journey. Desktop bridge tests live in
`apps/desktop/test/conversation-task-bridge.test.mjs`.
For the actual browser journey, build the package, set `CLOUD_TEST_BROWSER` to
a local Chrome/Chromium executable, then run `pnpm test:browser`. It creates
an isolated browser profile and in-memory DB and substitutes only the desktop
boundary. It does not attach to a personal browser, desktop or real model.
