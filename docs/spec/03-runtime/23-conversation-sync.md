# Conversation sync store

`@pi-desktop/conversation-sync` stores an account's chat text so devices can
converge. It is not the host-core transcript and not the transient
project-control relay.

## Save effect

`POST /v1/sync/changes` accepts `{device, conversations, messages}`.

- A new conversation or message, a newer title, or a tombstone takes the next
  account `seq`. Repeating a known message id does not change it.
- Text longer than 16,384 UTF-8 bytes is cut without splitting a character and
  marked `truncated`.
- Attachments are stored as `{name, mime, size}` only. Files and pictures are
  dropped. At most 20 attachments are kept.
- The account has one live `main` conversation. A second one is rejected with
  `main_exists` and `cid_main`. Its messages are rejected the same way.
- A new side conversation past 2,000 live side conversations is rejected with
  `conversation_limit` and stays on the device.
- Past 20,000 live messages, the oldest conversations' messages are dropped
  from the relay. Conversations written in that request are trimmed last.
- Turning sync off, or `DELETE /v1/sync/changes`, deletes stored conversations
  and messages. The seq counter remains. Turning sync off is the only one of
  those that also disables the switch.
- `DELETE /v1/sync/conversations/{cid}` tombstones the conversation and deletes
  its texts immediately. Tombstones older than 30 days are removed on the next
  push.
- `POST /v1/sync/working` is presence only. It is kept in memory for 10 minutes
  and is not written to SQLite.

`GET /v1/sync/changes?since=` returns later changes in seq order. `since=0&tail=K`
returns the newest K messages, their conversation rows, and the live main
conversation even when its messages are outside the tail.

Authorization is `Authorization: Bearer <token>` mapped to an account id.

`POST /v1/auth/register` and `POST /v1/auth/login` take `account` or
`identifier`, plus `password`. An identifier may be a 3–32 character account
name, an e-mail address, or a mainland phone number. The response carries the
same secret as both `token` and `api_key`, and `account` is
`{id, channel, hint, member}`. `POST /v1/auth/code` logs a six-digit code for
an e-mail or phone; it does not send SMS. `POST /v1/auth/verify` exchanges
that code for a session. `POST /v1/auth/password` changes the password,
`POST /v1/auth/sign-out` revokes the bearer token, and `DELETE /v1/me`
deletes the account. `GET /v1/models` answers `{object:"list", data:[]}`.
`GET /v1/me` and `GET /v1/me/profile` answer the stored profile;
`PUT /v1/me/profile` updates the name and look. `POST /v1/chat/completions`
returns `503 upstream_unconfigured` unless `CONVERSATION_SYNC_UPSTREAM_KEY`
is set. The PI-Desktop client dials the typed server with Node HTTP, not
Chromium's fetch, and accepts a host:port without a scheme.

`/v1/hub` is a WebSocket. A device sends `hello` with its bearer `key` and
`device.kind` of `phone`, `computer`, or `web`. A `web` device can send `call`
but cannot be called. The hub forwards `call`, `result`, and `event` inside
the account and does not run the action. Computers and phones stay in
`hub_devices` after they disconnect. A push notifies the other sockets with
`sync`. `GET /v1/devices` lists remembered devices; `DELETE` forgets an
offline one and `PATCH` renames it. The desktop connects as `computer` and
accepts `info`, `sessions.list`, `chat.send`, and the remote actions `shell`,
`files`, `file.get`, `file.put`, `open`, and `screen`. Those remote actions
ask the person at the computer before they run. `chat.send` starts an agent
turn on that desktop.

The desktop signs in from Settings → Cloud sync. The access token is encrypted
with the operating system store. Sync chats pushes local user and assistant
text; tool rows and streaming assistant checkpoints are not sent. A serial automatic uploader backfills on startup
and sign-in, requests a round after a Web task settles, and retries every 15
seconds so completed local turns are included after Host persistence. It checks
the account sync switch before loading/uploading transcripts, does not overlap
automatic rounds, and stops scheduling on quit. In-flight transcript loading
cannot upload after sign-out or account replacement. Rejected push entries are
observable failures rather than a successful status. The manual button remains.

The web sidebar lists cloud conversations, reads up to the latest 2,000 stored
messages on connect and `sync` notifications, and offers explicit refresh.
Selecting one loads its bounded cloud history independently of the browser's
local task history and enables same-session continuation when executor metadata
is available. It does not import or overwrite another desktop's Host transcript. Web task settlement notifies the local desktop session list.
`/sync-view` shares the main web login and refreshes on Hub sync notifications.
Unknown tokens answer `401 bad_key`. Sync data calls while sync is off answer
`409 sync_off`; account and Hub calls remain available.

## Multiple Web conversations

Each device has a list of independently identified Web conversations. New
conversation creates a fresh task conversation id and an empty transcript;
selecting a list entry restores its messages and live busy/stop state. The
first user message titles the list entry. Messages, list and active selection
are persisted per account and device. Existing single-conversation history is
migrated lazily without deleting its original data. Task callbacks capture the
conversation id at dispatch, so switching views cannot redirect a final answer
or persist it under another conversation. Stop addresses the selected conversation
only. Clear history is disabled for a running conversation and does not rotate
its task id. The desktop bridge continues to own a distinct Host session per
caller/conversation; Web history does not merge with the read-only cloud list.

## Reused cloud console

`/` and `/app/` serve the adapted nanoMuse cloud user console; `/app` redirects
there. Static assets and license notices ship as one directory in both local
and Docker builds, with revalidation caching. `/sync-view` keeps the previous
sync-inspection page. S3 configuration sync is unchanged.

The console selects a device and sends `task {text, conversation, from}`.
The desktop creates/reuses a dedicated session, sets permission mode `ask`, and
uses normal Agent prompt/abort admission. It forwards safe progress events and
returns `{text}` only after the admitted turn ends. `stop {conversation}`
cancels that caller's conversation only. Socket loss, account replacement or
sign-out cancels work and suppresses stale results. Each desktop installation
persists a distinct device id; conversation mapping currently survives socket
reconnects within a process, not full desktop restarts.

`GET /v1/me` includes true `has_password`, creation time and session count.
`GET /v1/me/sessions`, `DELETE /v1/me/sessions/{opaque-id}` and
`POST /v1/auth/sign-out-all` manage real sessions, never exposing bearer tokens.
Revocation closes affected live Hub sockets with code 4001. `GET /v1/me/events`
returns account-scoped activity, not chat text. Additive portal schema version 1
preserves existing passwords and sessions. The Hub accepts the console's
`forget {device_id}` frame for offline devices.

Billing, invitations, training contributions and password removal are not
advertised by this service. The reused page hides unsupported controls using
capability flags instead of displaying fictitious usage or functioning toggles.
See the package's CONSOLE-COMPATIBILITY.md and source notices for the full mapping.


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
Desktop `session.list` already includes project sessions; project grouping and
filesystem project paths are not carried by the current sync format.


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


## Web input provenance on the desktop

Authenticated Hub calls from a `web` caller mark only the accepted durable user
row with optional `inputSource: "web"`. Main keeps this admission marker by
object identity; serialized renderer, model or caller-supplied fields do not
establish provenance. The field is display metadata, not model prompt text or
permission authority. Host transcript metadata preserves it across reads/reopen.
Absent fields in legacy messages remain ordinary input and are not backfilled.
Desktop user rows show a quiet localized From web chip below the bubble; local
user messages and assistant/tool rows show no source chip. Mixed-origin turns
in one session keep independent provenance. The legacy chat.send path uses the
same trusted Main marker as task admission.
