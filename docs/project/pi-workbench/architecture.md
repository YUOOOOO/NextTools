# Architecture and Data Ownership

Status: design proposal; review required before protocol or shared-state implementation.
Parent plan: [PI Workbench development roadmap](../pi-workbench.md).

## 1. Ownership model

```text
Phone OpenMinis local database ─┐
                                ├─ direct authenticated E2E sync while online
Desktop PI Host Core database ──┘
             │                                  │
             └──── live encrypted relay ───────┘
                    no content persistence
```

| Data/capability | Authority | Remote treatment |
|---|---|---|
| Desktop project folders and files | Desktop Host Core and filesystem | Never copied to phone implicitly; project operations execute on desktop |
| Project Agent sessions and turns | Desktop Agent Host + Host Core transcript store | Phone is a remote client; it does not execute the desktop turn |
| Personal Agent session branch | Device that owns that branch | Changes exchange directly while devices are online; offline work creates an explicitly unsynced branch |
| Shared personal identity/personality/user facts/memory | Replicated endpoint records with explicit version/provenance | Endpoints reconcile authenticated changes; relay forwards live ciphertext only |
| Model credentials and local permissions | Each endpoint's native secure storage and permission owner | Never synchronized |
| Desktop task acceptance/execution | Desktop Host Core and Agent Host | Request ID is persisted before acceptance; relay is not the execution ledger |
| Device authorization | User-approved endpoint device registry; optional relay account directory only if approved | Public metadata is minimized; device keys are endpoint-owned |
| Relay payloads | No durable owner; bounded memory buffers during a live connection only | Drop on delivery, backpressure, timeout, process exit, or disconnect |

The desktop and phone may each maintain a local materialized view of shared personal data. No device is treated as an always-online authority. An authorized device may create a branch while peers are absent; it cannot claim that other devices have received that change.

## 2. Personal Agent record contract (proposal)

All replicated records carry a schema version, stable record ID, personal-agent ID, author device ID and device generation, per-device monotonic counter, causal parent/change references, operation kind, payload hash, signature, and creation time. Wall-clock time is display metadata, never the conflict authority. Large records and attachments are chunked and bounded.

| Record | Content | Write policy |
|---|---|---|
| `identity` | Stable Agent identity and user-selected name | User edits create a revision |
| `persona_revision` | Personality/behavior document | User-approved changes only in first release; Agent suggestions are proposals |
| `user_fact` | A preference or fact, source, scope, confidence/status, and validity | Agent may propose; policy determines whether low-risk additions need review |
| `journal_entry` | Dated source event with session/message provenance | Append-only; redact/delete via explicit tombstone |
| `topic_memory` | Synthesized topic knowledge and links to sources | Versioned revisions; conflicts remain reviewable |
| `core_memory` | Small cross-topic memory and pointers to topics | Versioned, bounded, reviewable |
| `conversation` / `message` | Conversation branch, role/content blocks, provenance, timestamps, parent IDs | Append-only messages, stable IDs; deletion is a tombstone |
| `turn` | Input, execution device, context revision/hash, model label without credentials, terminal result | One local execution owner per branch/turn; outcome is never fabricated during recovery |
| `evolution_proposal` | Candidate memory/personality changes, inputs, rationale, source links, tool/model provenance | Idempotent and reviewable; accepted/rejected as separate records |

The wire contract is canonical structured data. UI and export may render Mino-like Markdown documents:

```text
IDENTITY.md
SOUL.md
USER.md
MEMORY.md
memory/topics/<topic>.md
memory/journal/<date>.md
```

The Markdown view is not independently synchronized as an opaque whole-file replacement. Editing it must map to record revisions with an expected base revision. OpenMinis and PI adapters map their native storage into the shared record contract; neither opens or rewrites the other's database.

### Memory and evolution rules

- Daily journal is source material; topic memory is synthesized detail; core memory contains compact cross-topic lessons and pointers.
- Record provenance and sensitivity class on every learned item. Never learn credentials, tokens, or secrets.
- Preserve source records when synthesizing. A summary links to inputs and can be regenerated or rolled back.
- Do not automatically overwrite identity, core personality, a user correction, or a conflicting memory.
- A memory-evolution run declares the exact input-change set and base revisions; the same run ID cannot publish twice.
- If the base changed before publication, re-evaluate or produce a conflict proposal; do not silently rebase a semantic rewrite.
- Limit prompt injection from journal content: stored memories are data, not policy or capability grants.

## 3. Synchronization protocol (design target)

1. Both devices establish a mutually authenticated, end-to-end encrypted pair session. Verify public-key fingerprints during pairing and negotiate protocol/schema versions.
2. Exchange compact heads: per-device generation, highest contiguous counter, bounded sparse ranges, and authenticated snapshot checkpoint IDs. Do not expose record titles or payload hashes to the relay.
3. Request missing change ranges directly from the peer. Transfer size-bounded batches and, where necessary, independently authenticated encrypted chunks.
4. Receiver validates identity, generation, signature, size, schema, authorization, and causal dependencies. Apply a batch transactionally to local storage.
5. Receiver acknowledges only after durable local commit. Sender retains personal-state changes in its local encrypted outbox until acknowledged; outbox has explicit local storage limits and visible status.
6. Both sides compare heads again. A change is “synced” only when acknowledged by the intended peer, not when the relay accepted a frame.
7. If the connection drops, preserve unacknowledged personal changes on the originating endpoint and resume peer-to-peer when both endpoints are online. The relay does not replay after reconnect.
8. A stale endpoint older than a compacted causal checkpoint requires an online authorized peer to provide a current encrypted snapshot plus subsequent changes. If no peer with that state is online, recovery is unavailable; the relay cannot restore it.

The relay must enforce a bounded per-connection byte budget, frame size, rate limit, queue depth, and lifetime. Overflow returns an explicit backpressure/connection error; it must never spill to disk or become an offline delivery queue.

## 4. Conflict policy

| Conflict | Detection | Resolution |
|---|---|---|
| Independent append-only messages/journal entries | Distinct stable IDs and causal parents | Union and deduplicate; display deterministic causal ordering, with device ID as a stable tie-break only for concurrent siblings |
| Same ID with different payload/hash | Identity collision or tampering | Reject and quarantine locally; never last-writer-wins |
| Different fields/records edited offline | Causal heads do not descend from one another | Merge disjoint structured fields; record both causal parents |
| Same personality/core-memory section changed offline | Same base revision, overlapping semantic edit | Preserve both revisions and present a comparison; explicit user choice or new merge revision |
| Same user fact contradicted offline | Different evidence/status for one fact ID | Mark conflict/uncertain; do not inject as settled context until resolved |
| Delete versus concurrent edit | Tombstone and edit are concurrent | Show a delete/edit conflict; neither resurrect nor destroy silently |
| Both devices continue one conversation branch while offline | Both append turns to a common prior head | Keep explicit branches. Never combine two assistant answers as if one model saw the other |
| Same branch gets concurrent turn requests while devices can communicate | Competing turn admission | Only the selected local owner accepts the turn; other device forwards the user input or starts an explicit branch |

No global single-writer guarantee is possible while devices can work offline and the relay retains no authority. The safe promise is per-device branch ownership plus explicit reconciliation. User-authored content and completed local turns are never discarded by an automatic merge.

## 5. Device pairing, keys, and revocation

- Prefer an established mutually authenticated, forward-secret channel implementation supported on desktop Rust and Android; do not invent cryptographic primitives or a custom cipher protocol.
- Each install creates a random device ID and a device keypair. Keep private keys in the platform secure keystore; fail closed if secure persistence is unavailable.
- Pair by short-lived QR challenge with public-key fingerprint display, explicit confirmation on an already-authorized device, one-use expiry, protocol/version negotiation, and role/capability approval.
- Bind each key to an authorization generation. A reinstall is a new device identity, not a continuation of an old counter.
- Revocation is a signed change from an authorized device, immediately closes available relay links, advances the authorization generation, and rotates shared group/personal-data epoch keys before further synchronization.
- Offline revoked devices may retain data they previously decrypted; revocation prevents future authorized access and synchronization but cannot erase a device that never reconnects.
- A new device can receive the current state only from an authorized device that is online. With no authorized endpoint available, there is no cloud recovery path.
- Device-name, account-directory, public-key, IP, and audit metadata collection/retention requires an explicit privacy decision. Logs must never include payloads, plaintext, private keys, bearer tokens, or full personal records.

## 6. Project-session remote control

Remote project control is a separate RACP-backed channel, not a shared personal-agent conversation and not an offline task queue.

```text
Phone local UI -> explicit online/secure-channel check -> relay live forward
               -> Desktop owner validates request -> durable request receipt -> Agent Host
Phone UI <- encrypted event/approval/result <- live relay <- Desktop owner
```

- If the desktop is not reachable and authenticated, the phone marks the task **not sent**; it does not retain an automatic-delivery outbox.
- The desktop validates device authorization, session/project binding, request size, idempotency key, permission ceiling, and the existing host approval policy.
- Before acknowledging task acceptance, the desktop durably records `requestId`, canonical input digest, sender/device generation, target session, acceptance state, and resulting `turnId`. Repeated requests with the same ID and digest return the prior receipt; a different digest is a conflict.
- The desktop remains authoritative for transcript, tool results, approvals, project paths, and final task state. Phone decisions answer the desktop's approval request but do not replace desktop-side approval validation.
- If a connection drops after acceptance, the phone shows **status unknown / checking desktop**, then queries the same request ID after reconnection. It never resubmits execution automatically.
- If the desktop process restarted, it queries its durable receipt/session state and returns accepted/running/terminal/unknown. An unknown result is not replayed.
- A remote permission decision is bound to the exact device generation, turn, request, and operation digest. Stale, duplicate-with-different-choice, revoked-device, or mismatched approvals are refused.
- Stopping is an authenticated request to the existing desktop Host turn. It is not evidence that the turn has stopped until the Host confirms a terminal state.
- Attachments, screenshots, and file content require an explicit bounded encrypted transfer contract. They do not ride unbounded control frames.

The current PI RACP and Agent Host are strong reuse candidates, but their in-memory event replay and idempotency state must not be mistaken for durable restart recovery. A host-owned persistent request receipt and tested restart behavior are a prerequisite to claiming that an accepted request cannot execute twice.

## 7. Service scope and topology

The relay is initially a single-purpose self-hosted service, not a model server or data store. Its responsibilities are limited to authenticated device rendezvous, live forwarding, routing authorization, bounded in-memory buffering/backpressure, protocol version checks, and minimal operational health. It MUST NOT implement a transcript API, cloud memory store, task scheduler, or durable encrypted-message queue.

A stateless relay deployment may still need a control-plane/configuration source for authorized device credentials. Whether this is a local operator-managed config, a separate identity issuer, or endpoint-signed admission tokens is an open decision. Do not silently introduce persistent account or device-directory storage while implementing the relay.

Do not add PostgreSQL, Redis, Kafka, Kubernetes, or a hosted account system unless an approved scale/security requirement demonstrates the need. Durable personal-state changes belong on endpoints; desktop execution receipts belong in desktop Host Core storage.

## 8. First-party plugin policy

- Inventory existing PI manifest contributions before defining a Workbench-specific extension.
- Reuse plugin panels, work-panel views, renderer slots, commands, background services, and permissions when their ownership/lifecycle model fits.
- Bundled plugins are signed or otherwise identified by a host-owned immutable origin; users may configure or disable supported features but cannot uninstall/replace the bundled package.
- Bundled status does not bypass plugin sandbox, IPC allowlists, host permission, filesystem/network scope, or i18n requirements.
- Durable data and security-critical state are accessed through host-owned APIs; plugin-private storage is not a second authority for Agent sessions, identities, device keys, or project execution.
- Add central Workbench navigation/page contributions only after the extension audit proves current contributions insufficient. This is a host-shell extension, not a second plugin loader.
