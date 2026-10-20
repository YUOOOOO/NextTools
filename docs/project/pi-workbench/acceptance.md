# Acceptance Checklist

Status: planned verification, not a test report. Every unchecked item is pending.
Parent: [roadmap](../pi-workbench.md). Scope: [phase specifications](phases.md).

## Evidence rules

For each accepted increment, record candidate/base SHA, environment, changed contracts, commands actually executed, results, skipped checks with reasons, residual risks, and rollback. A checked item needs evidence, not merely an implementation claim. Baseline failures are recorded separately. Do not use production profiles, the user's running app, or paid providers as default test fixtures. Run `verify:ui:*` only when explicitly requested. A documentation-only change does not require runtime/unit/Electron tests; verify documentation structure, links, paths, scope and package discovery instead.

## P0: Baseline and audit

- [ ] Source commit, remote baseline, branch/worktree, user changes, and toolchain versions recorded.
- [ ] Applicable AGENTS, source contracts and existing tests read; reusable paths/symbols cited.
- [ ] Baseline checks run with actual results and known environment limitations.
- [ ] OpenMinis intake commit selected and licensing/distribution review completed before source import.
- [ ] Missing capabilities and public/security/persistence changes have an approved design.

## P1: Layout and navigation

- [ ] Startup selects Agent and preserves existing session restoration behavior.
- [ ] Top icons are Agent, Workbench, Scheduled Tasks, Extensions; bottom icons are Notifications, Settings.
- [ ] Bar remains visible across destinations and Agent sidebar collapse.
- [ ] Re-selecting the active icon has no side effect; navigation history and Settings return remain correct.
- [ ] Agent -> Workbench -> Scheduled -> Extensions -> Settings -> Agent journey uses real navigation handlers.
- [ ] Current project/session, drafts, retained transcript, sidebar preference, and right-panel context survive switching.
- [ ] Running tasks are not aborted or recreated; hidden Agent controls/portals cannot take focus or cover the selected page.
- [ ] Notification unread count/popover works on each destination and opens the correct Agent session.
- [ ] 800x560 and larger layouts, theme contrast, keyboard focus, i18n labels, native controls and macOS safety area checked.
- [ ] Sidebar, work-panel, maximized-panel, and native Browser bounds account for the 48px bar.

## P2: Bundled plugin and primary pages

- [ ] Host marks bundled origin; UI and backend refuse uninstall/replacement of protected packages.
- [ ] Stable IDs cannot be shadowed by an installed user package.
- [ ] Existing plugin loader, scope, permissions, lifecycle and public contracts remain compatible.
- [ ] Example page/tab can open, switch, close, restore, and report unavailable/crashed content.
- [ ] UI and optional Agent Tool use the same business service through reviewed interfaces.
- [ ] Feature disablement releases timers/listeners/processes/network connections without deleting user data.
- [ ] No bundled plugin bypasses host storage, secure storage, filesystem/network or tool authorization.

## P3: Personal Agent local data

- [ ] Personal and project sessions remain separate and retain correct execution roots.
- [ ] Identity, persona, user facts, journal, topic/core memory and revisions persist through restart.
- [ ] User can inspect source, correct/delete a memory, review personality changes, and undo an accepted revision.
- [ ] Structured records are authoritative; Markdown edits use expected base versions.
- [ ] Existing-user database/transcript migration, interruption, rollback and recovery paths tested.
- [ ] Context retrieval is bounded, records provenance/version, and never turns stored prose into capability grants.
- [ ] No credentials or device-local grants enter shared context or exports by default.

## P4: OpenMinis intake and mobile adaptation

- [ ] Upstream URL, full commit, acquisition date, checksums, retained notices and local divergence policy recorded.
- [ ] Mobile detailed design reviewed: Android baseline, build/CI scope, repository layout, migration, permissions and lifecycle.
- [ ] Source is imported intentionally into `apps/mobile/`; no nested accidental Git checkout, submodule, Node workspace, or automatic upstream merge.
- [ ] Native baseline builds and repository tests run before adaptation; no desktop lockfile/toolchain disruption.
- [ ] Local personal chat and memory work without a relay connection; interruption and restart preserve records.
- [ ] Android keystore and foreground/background restrictions tested; offline status reflects actual readiness.
- [ ] Existing mobile data survives upgrade/migration; model keys and local tool permissions remain local.

## P5: E2E channel and relay

- [ ] Pairing expiry, one-use challenges, fingerprint verification, device-generation binding and role/capability grants tested.
- [ ] Chosen established crypto implementation interoperates across Rust/Android; tampered/truncated/replayed/wrong-peer frames are rejected.
- [ ] Private keys stay in platform secure storage; persistence failure fails closed.
- [ ] Relay forwards only authorized live routes, has bounded buffers/frames/rate/timeout, and applies backpressure.
- [ ] Sentinel plaintext and ciphertext never appear in service storage, temp files, logs, telemetry or application crash artifacts; OS swap/core-dump controls and operational limitations documented.
- [ ] Relay restart/disconnect cannot replay content; no offline queue, task scheduler, transcript database or cloud snapshot exists.
- [ ] Device revocation closes available links; offline propagation limits, key rotation, reinstall and recovery behavior verified.
- [ ] Public admission metadata persistence/retention decision is resolved before deploying a registry.

## P6: Online-only project remote control

- [ ] Authorized phone discovers a permitted desktop session and completes send -> progress -> approval -> result through real Host/RACP wiring.
- [ ] Offline desktop or missing encrypted route returns not-sent; restarting the desktop later does not execute that request.
- [ ] Disconnect-after-send-before-ack shows unknown status; reconnection queries the original receipt without replay.
- [ ] Same request ID/digest returns prior receipt; different digest is rejected; desktop restart cannot duplicate execution.
- [ ] Revoked/stale/mismatched approval responses are refused; phone cannot approve its own device-enrollment request or change desktop permission policy.
- [ ] Stop is confirmed by authoritative Host state; a lost connection is not reported as completion/failure.
- [ ] Event eviction/process epoch change uses a fresh authorized snapshot; tools/permissions are not replayed from history.
- [ ] Attachment transfer obeys size/content/authorization boundaries and does not expose arbitrary local paths.

## P7: Personal state synchronization

- [ ] Two online devices initial-sync and incrementally reconcile identity, personality, conversations and memory.
- [ ] Duplicated, out-of-order and interrupted batches do not duplicate records or acknowledge before durable apply.
- [ ] Same ID/different payload, invalid signature/schema, stale generation and missing parents are handled explicitly.
- [ ] Counter gaps are not skipped by recording only the maximum received counter.
- [ ] Offline personal changes wait locally; desktop execution requests cannot enter this synchronization outbox.
- [ ] Concurrent conversation work forms branches; handoff occurs at an idle boundary, not by moving active tool calls.
- [ ] Persona/memory conflict and delete/edit conflict preserve alternatives and allow explicit resolution.
- [ ] Stale peer/snapshot catch-up does not resurrect tombstones or re-execute tools.
- [ ] New-device recovery requires an online authorized endpoint; no cloud restoration is promised.

## P8: Evolution

- [ ] Maintenance is opt-in until policy is explicitly accepted; no hidden paid model work.
- [ ] Journal -> topic -> core proposals retain sources and support accept/reject/rollback.
- [ ] Duplicate run IDs, changed base revisions and interrupted publication cannot publish conflicting updates silently.
- [ ] User corrections, deleted memories and protected personality sections are not overwritten by autonomous maintenance.
- [ ] Cross-device publication and rollback converge without creating new task execution.

## P9: Business tools

- [ ] Tushare manual query and Agent Tool use one service; fixtures cover limit/auth/network/error cases without paid live calls.
- [ ] Credentials stay out of renderer/shared records; data provenance, date range and adjustment semantics are visible.
- [ ] Quant computation does not block UI; fees/slippage/range and look-ahead limitations are explicit; cancellation/results persist.
- [ ] News retains source, publish/ingest times and source links for AI summaries.
- [ ] Each first-party module is independently configurable, protected from uninstall, and cleans up its resources.
- [ ] No live trading or offline cross-device execution is enabled implicitly.

## Validation commands and levels

Use the smallest relevant existing suite that covers the behavior plus its user journey. Verify command availability on the implementation candidate before execution. Current desktop commands include:

```powershell
pnpm docs:check
pnpm check:agent-policy
pnpm --filter @pi-desktop/desktop typecheck
pnpm build:js
pnpm lint
pnpm --filter @pi-desktop/desktop test
cargo test -p host-core --locked
```

These are available command references, not a claim that they were executed for this roadmap. Select focused desktop/Host/RACP tests for the changed seam; run native Android checks only after the source/build layout is approved. Use deterministic fixtures for packet loss, restart, concurrent editing, revocation, receipts, and migrations. Add isolated E2E only where real process/transport/native UI boundaries require it; no live-provider calls without explicit authorization.

## Acceptance record template

```text
Stage/increment:
Candidate commit and base:
Scope and changed paths:
Existing/new contracts:
Migration/compatibility:
Commands executed and results:
User-path mapping:
Checks skipped and why:
Remaining decisions/risks:
Rollback:
Accepted by/date:
```
