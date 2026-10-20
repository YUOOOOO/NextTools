# PI Workbench Development Roadmap

Status: planning baseline; no implementation phase in this document is claimed complete.
Product name: **PI Workbench** (working name; branding is not frozen).
Planning baseline: published PI tree `5ae3d364c5b4d304be431be9b5ba8367519349ff` on `origin/dev`, identical to local source snapshot `87a48b953e8bada43a7a63f8922846198b9efb61`.
Mobile upstream reference: OpenMinis `main` at `b4c0661d5631ebab4d1a2e6f3fd4c805d4030a6c`, inspected for planning only; not imported.
Mino reference: MyAgents `main` at `db56b48be4bdaf025a549a6669c1adf41fc1e943`, design reference only.

## Purpose

Evolve the current PI-Desktop into a local-first personal AI workbench without replacing its Agent runtime or weakening its host boundaries. The product keeps PI's project-oriented coding Agent and adds a distinct personal Agent that can use the same identity, conversations, personality, and memory from the desktop and an OpenMinis-based phone app.

This is the planning source of truth for the fork. It separates confirmed product constraints from proposed implementation details and records the gates that must be passed before importing upstream mobile code or implementing remote data protocols.

## Product model

The product has two Agent domains:

| Domain | Owner | Purpose |
|---|---|---|
| Project Agent | PI desktop Agent Host and its local Host Core | Work in desktop projects, files, tools, and project sessions. A phone may remotely control an online desktop session; it does not become the owner of that project session. |
| Personal Agent | A local personal-agent adapter on each authorized device | Long-lived personal identity, conversations, user context, personality, and memory. The phone and desktop run locally and exchange approved state directly while online. |

The existing Agent workspace remains the primary startup destination. The Workbench is a separate destination, not an embedded Agent assistant. Project sessions and personal-agent conversations must remain visibly and durably distinct.

## Confirmed product constraints

- Reuse the current PI-Desktop Electron, React, Host Core, Agent Host, RACP, persistence, permissions, and plugin systems wherever their contracts fit.
- The desktop Activity Bar order is **Agent, Workbench, Scheduled Tasks, Extensions**. Notifications and Settings are pinned at the bottom. Agent is the default destination, and its current project/session workspace is preserved.
- Prefer first-party bundled plugins for workbench surfaces and business modules when the existing plugin contract can safely host them. Bundled plugins are visible as built-in and cannot be uninstalled or replaced by a user plugin with the same ID. Bundled status does not grant extra privileges; host-owned storage, credentials, permissions, and execution stay behind host APIs. Feature disablement is a separate policy decision from uninstallability.
- The phone app is planned as an OpenMinis-based local-first client. Its source is not present in this repository yet. Import only after auditing the selected upstream commit, build/runtime boundaries, dependencies, and GPL-3.0 distribution obligations against this repository's licensing and release model.
- Device-to-device application payloads use end-to-end encryption. The relay cannot decrypt, index, persist, or replay sessions, messages, memory, snapshots, or encrypted payloads. The relay may hold bounded connection state and bounded in-memory forwarding buffers only; protocol metadata retention must be explicitly minimized and specified.
- A phone-to-desktop project task is online-only. If the target desktop is offline or the authenticated encrypted channel is unavailable, the request is not sent, queued, or auto-delivered later.
- Personal-agent state remains durable on its originating devices. Devices reconcile personal-agent changes directly while both are online. A disconnected device has no cloud copy from which to recover.
- No model provider credentials, local project files, or device-local permissions are synchronized by default.
- Do not implement a second plugin runtime, a public marketplace for the fork's bundled modules, a hosted model service, anonymous remote control, or an online-only replacement for local Agent execution as part of this roadmap.

## Target architecture

```text
Desktop: PI Workbench                         Phone: OpenMinis-based client
+-----------------------------------+         +--------------------------------+
| Activity Bar                      |         | Native local-first shell        |
| Agent: project Agent + personal   |         | Personal Agent + local memory   |
| Workbench / Scheduled / Extensions|         | Device control / selected tools  |
| Bundled first-party plugins       |         | OpenMinis adapter + bundled app  |
+------------------+----------------+         +---------------+----------------+
                   |                                            |
       +-----------+--------------------+         +-------------+--------------+
       | PI Agent Host / Rust Host Core |         | OpenMinis local runtime       |
       | owns desktop tools and data    |         | owns phone tools and data      |
       +------------------+-------------+         +--------------+--------------+
                          |                                       |
              outbound authenticated E2E channels; relay forwards live frames
                          +-------------------+-------------------+
                                              |
                           Self-hosted device relay (no payload persistence)
```

- Each endpoint owns its Agent execution, local transcript database, secrets, permissions, and device-specific capabilities.
- The desktop's existing project session and its remote-control protocol remain host-owned. The phone never receives desktop IPC, Rust RPC, SQLite access, provider secrets, or arbitrary host operations.
- Personal-agent interoperability uses a versioned shared data contract plus separate PI and OpenMinis adapters. It does not copy either app's internal database or runtime memory.
- The relay is a transport/rendezvous component, not the source of truth for conversations, memory, or task results. Endpoint-side durable outboxes may retain personal-state changes until peer acknowledgement. Project execution requests are explicitly excluded from offline outbox replay.
- A phone and desktop can behave differently because their models, local tools, permissions, and runtime lifecycle differ; shared identity/memory does not imply identical capabilities or deterministic replies.

## Mino-inspired personal-agent model

Use the organization and user-facing transparency of OpenMino/Mino as a design reference, not its Git-based synchronization or unreviewed code:

```text
Identity and profile
Personality and behavior contract
User profile and preferences
Core memory (small, frequently loaded)
Topic memory (retrieved for relevant work)
Daily journal (source record, selectively retrieved)
Conversations and turn/branch history
Evolution proposals, source links, revisions, and rollback records
```

The durable authority is versioned, structured records owned by the local host. Markdown documents may be provided as a readable/editable projection and export format. Concurrent edits must be detectable and recoverable; replacing whole Markdown files with timestamp-based last-writer-wins is not acceptable.

The first personal-agent increment does not include autonomous code changes, permission expansion, credential sharing, or unreviewable changes to the core personality. Evolution must retain source provenance and support review, correction, and rollback.

## Stage map

Detailed scope, dependencies, deliverables, exit criteria, and non-goals are in [phase specifications](./pi-workbench/phases.md). The consolidated gates are in the [acceptance checklist](./pi-workbench/acceptance.md).

| Stage | Name | Depends on |
|---|---|---|
| 0 | Baseline and upstream audit | None |
| 1 | Desktop Activity Bar and route shell | Stage 0 |
| 2 | Bundled-plugin and Workbench page capability audit/adapter | Stages 0-1 |
| 3 | Desktop personal Agent local data model and Mino-inspired memory | Stages 0-2 |
| 4 | OpenMinis source intake and phone adaptation | Stages 0, 3, license gate |
| 5 | Device identity, E2E relay protocol, and relay service | Stages 0, 3-4, security review |
| 6 | Online-only phone control of desktop project sessions | Stages 1, 4-5 |
| 7 | Online peer synchronization of personal Agent state | Stages 3-5 |
| 8 | Reviewable personal-Agent memory evolution | Stages 3, 7 |
| 9 | First-party business plugins: Tushare, then Quant and News | Stages 2-3; Stage 7 for phone sharing |

A stage is a roadmap boundary, not an authorization to implement all of its work at once. Each implementation request must identify one bounded increment and receive its own plan and acceptance review.

## Current planning status

- The Activity Bar requirements and intended route behavior have been discussed, but are not implemented by this planning change.
- PI source audits establish reusable Host Core, Agent Host, RACP, plugin, transcript, and permission boundaries; a fresh baseline validation has not been run for this roadmap.
- MyAgents/Mino and OpenMinis were inspected at the commits above. OpenMinis has not been cloned, vendored, or modified in this repository.
- The relay cryptographic protocol, public-key/device registry, revocation behavior, personal-state wire schema, and branch reconciliation require dedicated design review before implementation.
- See [decisions and open questions](./pi-workbench/decisions.md).

## Links

- [Architecture and data-ownership design](./pi-workbench/architecture.md)
- [Phase specifications](./pi-workbench/phases.md)
- [Acceptance checklist](./pi-workbench/acceptance.md)
- [Decisions and open questions](./pi-workbench/decisions.md)
- Reserved mobile source directory: `apps/mobile/` (see its repository README; source intake is deferred).
