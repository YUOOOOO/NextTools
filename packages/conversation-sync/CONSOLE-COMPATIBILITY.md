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
| sync state/changes | Existing nanomuse save rules; automatic desktop uploads, project groups and same-session cloud continuation |

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


Web task progress includes `stage: "session", sessionId` after configuring the
owned Host session. The browser stores this association on its account/device
conversation entry. Cloud sync notifications reconcile matching Host messages
into idle Web conversations, including desktop-originated continuations.
The last completed Web answer must be present before accepting a cloud snapshot;
this prevents delayed uploads from erasing an unsynced reply. Busy conversations
are not replaced. Reconciliation uses canonical cloud messages rather than
appending duplicates; associations survive browser reloads.


`GET /v1/sync/conversations` returns all live conversation metadata for the
bearer account, independently of the recent-message tail. Empty conversations
and older conversations therefore remain visible in the web cloud list.
Deleted conversations are excluded and the account sync switch is enforced.
Desktop `session.list` includes project sessions. Project grouping uses optional
opaque ids and display labels; full filesystem project paths stay local.


## Project groups and continuing a cloud conversation

Conversation metadata optionally includes `project_id`, `project_name`,
`execution_device` and `session_id`. A desktop hashes the local project identity
and sends only an opaque id and basename display label, not a full project
filesystem path. Group identity is execution device plus project id; absent
project metadata is shown as Global conversations. Native-Pi and remotely
hosted sessions are not advertised as executable local sessions.

The additive sync schema migration records version 1, keeps existing rows,
and backfills metadata even without a newer title timestamp. Repeated metadata
is idempotent; omitted legacy fields preserve stored values. Execution metadata
must name the push's own device and cannot take over another device's binding.
`GET /v1/sync/conversations/{cid}` reads account-scoped live conversation metadata
and up to 500 latest stored messages independently of the account-wide tail.

Selecting a cloud conversation uses the normal chat composer. `task`/`stop`
carry its cid and Host sessionId. The Hub verifies the exact account, session,
conversation and execution-device binding before forwarding. The desktop also
verifies that the session was successfully shared to the current account/server,
is still local and exists. It resumes that exact session with its original
project, model and mode, using normal Agent admission/abort and ask permissions.
Unshared/missing/remote sessions fail closed; missing metadata asks the user to
sync once on the original desktop. Offline history remains readable but input
is disabled until its executor reconnects. Unsaved composer drafts survive
sync refresh; concurrent aliases cannot run two tasks on the same Host session.
See ADR 0333 for the decision and permission boundaries.


## Interactive tool permissions and asktool cards

The Web console reads the selected online conversation's current tool permission
and asktool cards through `interactive.list`, using the same cid/session/device
binding as shared task continuation. Desktop-originated turns in shared sessions
are included. Its recursive polling has no overlapping list requests and ignores
responses from previous accounts, selections and sockets. Card state is ephemeral,
not a stored chat message; identical snapshots retain form input and selection.

`interactive.resolve` carries an opaque card token and either allow-once/deny or
an answers array (one string array or null per question). Desktop verifies caller,
account/server scope, session, current turn, exact pending request and live backend
again, then invokes normal permission/ask resolution. Other-tab tokens cannot be
reused and concurrent requests share a resolution lock. Desktop decisions remove
the card from the next Web snapshot; duplicate, expired or terminal cards fail
closed. Ask answers support single/multiple options, custom text and skip/decline.
Previews are redacted and rendered as text; no permanent grants are offered.

This mirrors the original nanoMuse approval roundtrip while adapting asktool to
Pilot's own canonical input protocol. Plan/Goal approval cards, plugin native
consent dialogs and app quit dialogs are not forwarded by this protocol. See
ADR 0334 for the authority and lifecycle decision.


Selected ask options are submitted as opaque option identifiers and mapped back
to original labels on the desktop, separately from custom text. Redaction or
truncation of display text therefore cannot change the selected answer. Card
tokens retain their issuing Host/sidecar identities; backend replacement and
TTL expiration are rechecked after asynchronous snapshot validation immediately
before dispatching any decision.
The console sidebar keeps its brand and account card outside one bounded,
keyboard-focusable navigation scroll region. Device, Web-conversation and
project/synced-conversation lists scroll without pushing the account card out
of view, including at the mobile sidebar height cap. Synced project/global
groups include only rows whose execution_device (or legacy device fallback)
matches the selected account device. Selecting another device clears the old
cloud selection, preserves its conversations and drafts, and shows only the
new device's groups. The device picker exposes pressed state and remembers the
selected device per account; a first connection asks the user to pick a device.


The sidebar presents Browser conversations (entries created in this browser)
and Desktop synced conversations (durable cloud mirrors executed by their
original desktop). Both are filtered by the selected device where applicable.
Account controls are outside the navigation scroll region. Console build
`1.1.0-sidebar-cards` appears below the account label and in the root
`data-console-version` attribute, so deployments can verify updated assets.
Interactive cards require both the updated cloud assets/Hub and updated desktop
Main broker; replacing only server HTML cannot enable an older desktop.
