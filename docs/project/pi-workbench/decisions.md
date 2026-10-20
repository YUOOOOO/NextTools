# Decisions and Open Questions

Parent: [PI Workbench roadmap](../pi-workbench.md).
This is a planning decision register, not an ADR claiming implementation.

## Confirmed constraints

| ID | Decision | Consequence |
|---|---|---|
| WB-01 | Keep PI's existing project/session Agent workspace; add a distinct Personal Agent | Do not migrate every project session into shared personal state |
| WB-02 | Agent, Workbench, Scheduled Tasks, Extensions in Activity Bar; Notifications then Settings at bottom; Agent default | Preserve Agent context across navigation |
| WB-03 | No embedded Agent assistant in Workbench | Dedicated Agent area remains the interaction surface |
| WB-04 | Prefer bundled first-party plugins, protected from uninstall | Audit current contributions; add host contracts only for real gaps; do not create a second plugin runtime |
| WB-05 | Host owns persistence, security, permissions and execution | Plugin UI/services access bounded host APIs; built-in status is not a sandbox exemption |
| WB-06 | OpenMinis-based local-first mobile app, later detailed design | Reserve `apps/mobile/` now; do not fetch or adapt mobile code in this documentation task |
| WB-07 | Relay cannot decrypt or retain application content, including ciphertext | No server conversation/memory database, snapshot store, offline queue or durable task broker |
| WB-08 | Desktop tasks can be sent only to an online authenticated target | No automatic task delivery after the desktop comes online; unknown acceptance is queried, not replayed |
| WB-09 | Personal Agent shares identity, conversations, memory and personality across endpoints | Versioned peer synchronization while online; no guarantee of constant equality while disconnected |
| WB-10 | Mino is a memory/identity design reference | Preserve readable layered memory; do not adopt Git/cloud sync or copy unrelated AGPL implementation without review |
| WB-11 | One-time upstream imports, independent fork, selective reviewed updates | Pin full commit and provenance; never auto-follow upstream branches |

## Proposed defaults needing phase-specific review

| ID | Proposal | Resolve before |
|---|---|---|
| Q-01 | Relay may use operator-managed public admission keys; no account database by default | Phase 5 deployment design; clarify whether any public device metadata may persist |
| Q-02 | Established forward-secret mutual authentication inside live WSS relay, with independent fingerprint pairing | Phase 5 protocol/library review and cross-platform interoperability tests |
| Q-03 | Offline personal conversations may create explicit local branches; no automatic merge of assistant replies | Phase 3/7 UI and execution design |
| Q-04 | Memory maintenance starts opt-in; identity/core persona changes require approval | Phase 3/8 behavior and model-cost policy |
| Q-05 | Bundled packages cannot be removed; supported features may be disabled without data loss | Phase 2 lifecycle and recovery design |
| Q-06 | Android first; retain OpenMinis local runtime and repository boundaries | Phase 4 mobile detailed design; iOS remains a separate decision |
| Q-07 | Local encrypted export/recovery with user-controlled retention; no server backup | Phase 3/5 recovery design; device-loss risk must be visible |
| Q-08 | Causal logs with peer acknowledgement; snapshots and tombstones compact only under explicit checkpoints | Phase 7 retention/bounds design |
| Q-09 | Keep one default Workbench configuration initially | Phase 2 page/tab contract; multiple named workbenches require a separate scope |

## Source evidence and boundaries

PI baseline source:

- Desktop shell (`apps/desktop/src/features/app/AppShell.tsx`): existing routed destinations and retained Agent UI.
- Agent Host (`packages/agent-host/src/agent-host.ts`): turn admission, approvals, queue and in-memory idempotency.
- Event log (`packages/agent-host/src/event-log.ts`): bounded in-memory streams, epoch/sequence cursors and resync decisions. The word durable in its event vocabulary does not mean a disk-backed cross-restart log.
- [Storage ownership](../../spec/03-runtime/04-data-storage.md): Host Core owns desktop SQLite/transcripts; renderer and Node sidecar do not open them directly.
- [RACP](../../spec/03-runtime/19-remote-agent-control-protocol.md): semantic control boundary, not public desktop IPC or an arbitrary host RPC tunnel.
- [Plugin development](../../plugin-development.md): existing panels, views, renderer slots, services, commands and permissions must be inventoried before extension.

External references inspected for planning:

- [MyAgents/Mino template](https://github.com/hAcKlyc/MyAgents/tree/db56b48be4bdaf025a549a6669c1adf41fc1e943/bundled-workspaces/mino): identity, soul, user, daily/topic/core memory; Git sync is not adopted.
- [MyAgents AgentNet design](https://github.com/hAcKlyc/MyAgents/blob/db56b48be4bdaf025a549a6669c1adf41fc1e943/specs/tech_docs/agent_network.md): inner encrypted transport and non-replay of remote execution are design references, not an adopted wire protocol.
- [OpenMinis memory repository](https://github.com/OpenMinis/OpenMinis/blob/b4c0661d5631ebab4d1a2e6f3fd4c805d4030a6c/src/android/app/src/main/java/com/openminis/app/data/repository/MemoryRepository.kt): user-maintained `GLOBAL.md`, daily entries and bounded prompt fragments.
- [OpenMinis Room database](https://github.com/OpenMinis/OpenMinis/blob/b4c0661d5631ebab4d1a2e6f3fd4c805d4030a6c/src/android/app/src/main/java/com/openminis/app/data/db/AppDatabase.kt): database schema/migrations belong to the native mobile repository.
- [OpenMinis foreground service](https://github.com/OpenMinis/OpenMinis/blob/b4c0661d5631ebab4d1a2e6f3fd4c805d4030a6c/src/android/app/src/main/java/com/openminis/app/service/AgentForegroundService.kt): Android lifecycle is an explicit integration concern, not proof of permanent availability.

The inspected MyAgents root license is AGPL-3.0 and OpenMinis is GPL-3.0. Mino's template README says MIT, which does not establish that unrelated MyAgents files have that license. Preserve file-specific notices and review compatibility before code import, shared linking, packaging or distribution. This task imports no external implementation.

## Baseline and workflow record

The primary checkout used for discussion was local `dev` at `87a48b953e8bada43a7a63f8922846198b9efb61`; it contained an unrelated `.gitignore` modification. The remote default branch was `dev`, not `main`, and originally pointed to a different Tauri/WorkBuddy code tree. Do not treat that earlier remote tree or the historical board as the PI implementation baseline.

At the user's explicit request, remote `origin/dev` was replaced using a normal fast-forward commit `5ae3d364c5b4d304be431be9b5ba8367519349ff` whose tree exactly matches `87a48b9`, retaining the previous remote history. The documentation task worktree is based on this published PI tree. No `.gitignore` user changes or unfinished roadmap files were included in that publication.

For future work, follow root `AGENTS.md` isolation and validation requirements. This fork has no `origin/main`; use the actual remote target only after explicitly recording the mismatch, as done here, rather than merging a different product tree. This document does not globally rewrite root branch policy or authorize commits/pushes. New task code must incorporate the selected current remote target before candidate validation.

## Superseded assumptions

- The Activity Bar/layout is not already implemented by documenting it.
- A mobile PWA is not the selected mobile runtime; OpenMinis is.
- Server-side stored plaintext or ciphertext synchronization, PostgreSQL-backed task queues and offline remote task execution are outside this roadmap.
- A global single-writer lease cannot be guaranteed while local devices work during a network partition; use branch ownership and explicit handoff/reconciliation.
- Shared data does not mean shared model credentials, identical tool availability, deterministic personality behavior or copied runtime memory.
- Existing S3 portable-configuration sync is a separate shipped feature; it is not the new personal-agent synchronization mechanism and is not removed by this plan.
