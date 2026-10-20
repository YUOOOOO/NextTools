# Mobile Client Reservation

Status: directory reserved; no OpenMinis source, application, dependency manifest or mobile build has been imported.

## Purpose

This directory is reserved for a local-first mobile client based on [OpenMinis](https://github.com/OpenMinis/OpenMinis). It will adapt the Mino-inspired Personal Agent contract to the phone's native repositories/runtime and provide online-only control of authorized desktop project sessions.

The controlling plan is the [PI Workbench roadmap](../../docs/project/pi-workbench.md). See [Phase 4](../../docs/project/pi-workbench/phases.md#phase-4-openminis-intake-and-phone-adaptation) and the [acceptance checklist](../../docs/project/pi-workbench/acceptance.md).

## Current directory boundary

```text
apps/
  desktop/      Existing PI Electron desktop app; do not move or rename
  mobile/       This reservation; future OpenMinis-based native app
```

The placeholder has no `package.json`, Gradle project, Cargo manifest, submodule, Git checkout, dependency lockfile, signing files, or generated app assets. It must not alter pnpm package discovery, Cargo membership, desktop builds, or CI execution. Do not create fake Android/iOS source directories before the native import layout is reviewed.

## Intake gate (not executed)

- Select the then-current suitable upstream release/full commit. The planning audit inspected `b4c0661d5631ebab4d1a2e6f3fd4c805d4030a6c`; this is not an instruction to use a moving `main` or claim it remains latest.
- Review OpenMinis GPL-3.0 obligations and this repository's license/distribution strategy before importing, linking, packaging or distributing code. Preserve upstream license, notices and file attribution.
- Record URL, full commit, release tag if any, acquisition date, archive checksum where applicable, baseline build/test results and local patches in a future provenance file.
- Define how the original native tree and local adapters are separated inside this directory, whether Android-only source is imported, and how any upstream Node metadata is kept out of unintended desktop workspace discovery.
- Import once into the existing repository. No nested `.git`, submodule, automatic sync, dependency installation or upstream merge is authorized by this reservation.
- Independently design Android SDK/JDK/Gradle setup, application identity, signing, data migrations, secure storage, background availability and test commands. iOS and PWA are not implicit deliverables.

## Adaptation requirements

- Retain OpenMinis local Agent execution, local chat/memory, device tools, permissions and recovery.
- Map shared identity, persona, user facts, conversations and Mino journal/topic/core memory to native repositories. Do not copy desktop SQLite or fork PI's entire runtime into the phone.
- Keep model credentials and device permission grants local. A relay connection is optional for local work.
- Use endpoint-authenticated E2E transport. The relay cannot decrypt or persist messages, memory, snapshots or ciphertext.
- A desktop project task requires an online authenticated route; offline tasks are not sent or automatically retried later. Unknown acceptance is queried by request ID.
- Personal data changes may wait locally for an online peer and need versioned conflict/branch resolution. A local sync outbox must never become an offline desktop-execution queue.
- Prefer existing native extension/service seams where appropriate. Desktop plugins are not assumed to execute unchanged on Android.

## Update strategy

One-time pinned intake, independent adaptation, and selective reviewed upstream fixes. Do not automatically pull or merge upstream `main`. Any later update is its own task with provenance, migration/compatibility checks and baseline-versus-modified validation.
