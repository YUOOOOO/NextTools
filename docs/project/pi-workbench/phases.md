# Phase Specifications

Status: planned work; none of these implementation phases is accepted by creating this document.
Parent: [PI Workbench roadmap](../pi-workbench.md).
Architecture: [data ownership and protocol design](architecture.md).
Exit evidence: [acceptance checklist](acceptance.md).

## Phase 0: Baseline and upstream audit

Dependencies: none. Scope: read-only source/build audit and an explicit candidate-base decision.

Deliverables:

- Record current commit, tracked/untracked user changes, remote/default branch, worktrees, dependency versions, and baseline test/build commands and actual results.
- Map PI shell, page routing, plugin loader/contributions, Host Core storage, Agent Host, RACP, permissions, and event lifecycle to concrete paths and symbols.
- Map the selected OpenMinis upstream commit to Android build, Room schema/migrations, `MemoryRepository`, chat repository, Agent lifetime, foreground service, secure storage, and phone-only tools.
- Record upstream licenses and reuse strategy for PI, OpenMinis, Mino, and any AgentNet/relay reference. A template README license notice is not sufficient permission to copy unrelated repository implementation.
- Document missing plugin contributions, restart-safe task receipts, cross-runtime record adapters, and lifecycle gaps.

Exit: baseline reproducibility and evidence table are reviewed; failures are classified as baseline/environment/task-related; no unreviewed dependency upgrades or runtime rewrite.

Non-goals: implementing the roadmap, cloning a mobile tree before license review, merging incompatible remote codebases, or modifying user data.

## Phase 1: Desktop Activity Bar and destination shell

Status: desktop shell is implemented on the current development branch and is not accepted. Native chrome, resize, and navigation regression checks remain before exit.

Dependencies: Phase 0. This is the first functional implementation increment.

Deliverables:

- Fixed 48px left Activity Bar with approximately 22px icons and 44px hit targets, using existing shared primitives, themes, icon library, i18n, and accessible labels/focus.
- Top order: Agent, Workbench, Scheduled Tasks, Extensions. Bottom: Notifications then Settings. Agent remains startup default; internal `chat` route compatibility is retained.
- Preserve the existing PI project/session sidebar, active project/session, composer drafts, background execution, and optional right panel in Agent.
- Use the existing route state as the single source of truth, with a new Workbench destination. Selecting an already-active icon is a no-op, not Back, sidebar collapse, or new session.
- Other destinations occupy the area right of the Activity Bar, without the Agent session sidebar or session work panel. Settings keeps its own directory. Notifications remain a popover, not a new page.
- Retain Agent state and hidden-pane focus/portal isolation during route changes. Deduct Activity Bar width from sidebar/panel/titlebar budgets at 800x560 and larger sizes.
- Workbench is a minimal real destination without fake statistics or nonfunctional tools. Prefer a bundled plugin if current contributions can provide it; otherwise document the smallest host-shell seam needed by Phase 2.

Exit: desktop navigation journey and Agent regression tests pass; native chrome, sidebar/panel resize, minimized widths, Settings return, notifications, and Back/Forward remain coherent.

Non-goals: embedded Agent in Workbench, mobile, device relay, business plugins, or redesigning PI project storage.

## Phase 2: Bundled-plugin and Workbench page capability

Status: started. The host page session, Agent `Workbench` tool, plugin-panel bridge, and `contributes.workbenchPages` are implemented on the current development branch and are not a Phase 2 exit. The session is stored in the existing `kv` table at `ui` / `workbenchSession`. The menu, the Agent tool, plugin panels, and contributed pages call the same `workbench.get` / `workbench.apply` commands. A contributed page id is `pluginId/pageId` and its body is one of that plugin's views. Disable changes status, unloads the view, and keeps the record. A disabled plugin cannot open its page, but the saved record stays. A bundled plugin still cannot be uninstalled. A public install cannot replace that id unless it is a strictly newer marketplace version, which remains the ADR 0241 update path. Phase 1 native chrome, resize, and navigation regression remain open. Phase 3 has not started.

Dependencies: Phases 0-1. First inventory existing contributions; extend only proven gaps.

Deliverables:

- Define a host-owned built-in origin, stable plugin IDs, installation/upgrade behavior, and backend refusal of uninstall/replacement. Hiding the UI action alone is insufficient.
- Reuse the existing loader, contribution registry, activation scopes, permissions, services, and failure isolation. No second plugin runtime.
- Provide host-owned Workbench page/navigation contributions and bounded page-instance/tab state only where existing panel/view contracts cannot host a primary page.
- Use a small first-party example to open/close/switch a page or tab, persist allowed restoration state, and recover unavailable/disabled/error pages.
- Separate one initial personal Workbench configuration from PI projects and execution roots; multiple named workbenches are deferred until a real use case requires them.
- Keep UI components separate from business services. Expose the same typed service to a plugin UI and optional Agent Tool through a reviewed API.
- Decide feature disablement policy explicitly; “cannot uninstall” does not imply “must keep network/background work active.”

Exit: bundled module cannot be uninstalled or shadowed via public mutation paths; the example page and Tool use the same service; original plugins still work; disabled features release resources without deleting data.

Non-goals: a fork marketplace, arbitrary host-state mutation, new sandbox assumptions, or business implementation.

## Phase 3: Local desktop Personal Agent

Dependencies: Phases 0-2 and approval of the local data contract.

Deliverables:

- Add a distinct Personal Agent entry inside Agent while retaining Project Agent sessions and their existing defaults.
- Implement host-owned identity/personality/user-fact records, conversations/branches/turns, Mino-inspired journal/topic/core memory, source links, revisions, and explicit corrections/deletions.
- Keep desktop SQLite/transcript ownership in Rust Host Core. Add migrations and upgrade/rollback behavior rather than repurposing project-memory keys as an implicit personal profile.
- Provide bundled-plugin onboarding, memory/personality editing, reviewable Markdown projections/export, and budgeted context assembly.
- Record which personality/memory revision informed each turn. Memories cannot become tool permissions or replayed task instructions.
- Define adapter boundaries so the phone can later implement the same contract without sharing the desktop database schema.

Exit: a user can initialize an identity, converse, inspect/correct memories, edit personality, restart, and recover the same local state; migrations preserve existing PI sessions.

Non-goals: cross-device synchronization, autonomous code changes, automatic core-personality rewriting, or embedded Agent inside Workbench.

## Phase 4: OpenMinis intake and phone adaptation

Dependencies: Phase 0 license/build review and Phase 3 shared-record contract.
Status: intentionally deferred for detailed mobile design. Directory reservation is not source intake.

Deliverables:

- At intake time, select the then-current suitable OpenMinis release/commit, audit it, pin the full SHA, retain upstream notices, and record import provenance/checksum. The planning reference is not automatically the import version.
- Import into `apps/mobile/` only after deciding how the upstream tree coexists with local adapters and host package discovery. Do not create a second Agent engine or automatically track upstream `main`.
- Define Android-first native build/test commands, dependency caches, application ID, data directories, signing separation, and app lifecycle. iOS is not implicitly included because it exists upstream.
- Map shared Personal Agent records to OpenMinis repositories/Room migrations; integrate personality, journal/topic/core memory, conversations and branch provenance without overwriting existing mobile data.
- Keep phone tools, keystore, providers, and permission grants device-local. Display actual connected/ready state, not a guarantee of permanent background reachability.
- Reuse phone-native extension/service mechanisms where present; desktop plugin JavaScript is not presumed portable to Android.

Exit: imported baseline builds independently, provenance/license review is recorded, local personal conversations and memory work offline, upgrade migrations preserve data, and the adaptation design is accepted.

Non-goals: PWA replacement, native iOS qualification, relay-only dependence, or automated full-upstream merges.

## Phase 5: Identity, end-to-end encryption, and transient relay

Dependencies: Phases 0, 3-4; approved threat model and protocol/schema review. A desktop-plus-test-peer fixture may precede phone integration.

Deliverables:

- Finalize short-lived pairing, identity fingerprint verification, authorization generations, signed capabilities, secure key storage, session rekeying, revocation, and local backup/recovery policy.
- Specify and test bounded encrypted frames, chunking, acknowledgements, timeout/error codes, protocol negotiation, backpressure, reconnect and cleanup.
- Implement a self-hosted relay with authenticated live routes and bounded volatile buffers. No payload/ciphertext history, memory store, offline task queue, transcript API, PostgreSQL or durable message broker is introduced.
- Decide whether relay public-key admission configuration may persist before adding an account/device database.
- Test cross-platform established cryptography libraries with identical known-answer/negative fixtures; no custom encryption construction.

Exit: an untrusted relay cannot read or substitute endpoint content/identity; slow/offline peers cannot cause unbounded buffering; disconnect/restart leaves no payload recovery path on the service; endpoint revocation and cleanup behavior are explicit.

Non-goals: remote execution bypass, shared provider secrets, cloud model execution, or promising metadata anonymity.

## Phase 6: Online-only desktop Project Agent control

Dependencies: Phases 1, 4-5 and durable desktop receipt design.

Deliverables:

- Bundled device-management UI and phone session picker with authorized project/session discovery, prompt, stream, approval, stop, and bounded result/attachment access.
- Reuse PI Host/RACP operations behind a reviewed encrypted adapter. Do not expose internal IPC/RPC or relax loopback listener restrictions.
- Host-owned durable acceptance receipts, input digest conflict checks, sender-generation/session binding, and restart-safe request-status queries.
- Refuse an offline target before dispatch. Do not create an automatic phone/relay execution outbox. An accepted-but-unconfirmed task is queried using its original request ID; it is never automatically re-executed.
- Rehydrate UI from desktop state after event-log eviction or host restart. A lost live stream is not evidence of task failure or success.

Exit: phone sends to online desktop, observes tools, answers a real permission request, stops a task, and reconnects without duplicate execution. Offline submission is visibly not sent and is not delivered after the desktop returns.

## Phase 7: Personal Agent peer synchronization

Dependencies: Phases 3-5; shared data, deletion, retention, and branch policies approved. Independent of Phase 6's project-control implementation.

Deliverables:

- Causal change envelopes, device-generation counters, sparse gap recovery, durable endpoint acknowledgements, idempotency and schema-version adapters.
- Initial authorized online peer transfer, incremental sync, bounded attachment transfer, snapshot catch-up and old-device rebootstrap rules.
- Explicit per-branch execution ownership and idle-turn handoff. Offline continuation creates a local branch; global single-writer semantics are not promised during a partition.
- Conflict comparison and resolution for persona, user facts, memory, deletion and conversation branches. Resolution creates a new causal revision and retains source provenance.
- Local visibility for pending/confirmed sync and storage limits. Personal data may wait locally for synchronization; desktop execution requests may not enter this queue.

Exit: two devices share identity, history and memory after successful reconciliation; interruption, duplicate delivery, stale counters, concurrent edits and delete/edit conflicts never silently lose records or replay tools.

## Phase 8: Reviewable memory evolution

Dependencies: Phases 3 and 7. Local-only experiments may precede full multi-device enablement.

Deliverables:

- Opt-in extraction/maintenance policy, source journal -> topic -> core proposals, conflict/source validation, review UI, history and rollback.
- Input-range/run identity and publication guards prevent duplicate maintenance and stale-base overwrite across devices.
- User corrections, deletion and personality controls remain authoritative. No self-modified executable code or expanded permissions.

Exit: changes can be explained, approved/rejected, undone and synchronized; duplicate or interrupted runs publish at most one accepted revision.

## Phase 9: First-party business tools

Dependencies: Phases 2-3; Phase 7 where cross-device results are in scope.

Deliverables, as separate increments:

- Tushare: secure credential setup, symbol search, dated query, clear data/adjustment provenance, table/chart/export, cache/limits/errors, and UI/Agent Tool sharing one service.
- Quant: parameterized backtests, explicit fees/slippage/data range, progress/result persistence, cancellation and chart metrics; computation runs outside the UI thread.
- News: source/time/ingest provenance, search/filter/detail, cited summaries and optional symbol links.
- Automation reuses existing host scheduling and endpoint execution policy. No unattended live trading or offline remote task delivery is enabled.

Exit: each bundled plugin is independently configurable, cannot be uninstalled/replaced, passes its user-path/error/permission tests, and adds no second source of truth for shared state.

## Per-increment delivery record

Record scope, candidate/base SHA, paths changed, reused/new interfaces, migrations, compatibility, tests actually run with results/skips, residual risks, rollback and next bounded task. Follow root `AGENTS.md`: a roadmap does not authorize commits, pushes, releases, or paid-provider tests. Use a dedicated worktree, preserve unrelated changes, and request the appropriate design decision before changing frozen public/security/persistence boundaries.
