# ADR 0334: Resolve desktop interactive requests from the cloud console

- Status: Accepted
- Date: 2026-10-28

## Context

The original nanoMuse task service emits approval cards and receives an
`approve` action from the originating caller. Pilot's cloud task bridge only
forwarded text/progress and left Host-owned tool permissions and Agent Host
asktool inputs inaccessible to a Web-only caller. Subscribing only to sidecar
events would miss permissions produced by Host and stale card resolution would
risk executing a decision for a later task.

## Decision

Add `interactive.list` and `interactive.resolve` Hub actions. Reuse the selected
conversation/executor binding: shared sessions pass the Hub's account/cid/local
session/device validation and the desktop's current scoped sharing grants.
Web-owned sessions use the existing caller-bound conversation map. The desktop
reads canonical pending requests through normal Agent IPC and associates them
with the current Agent Host turn. No authority or pending state moves to cloud
SQLite. The browser polls the selected session with one bounded in-flight call
and treats each response as the authoritative current card set.

Desktop issues opaque, short-lived, caller/account/session/turn-bound card tokens.
Submission rechecks backend identity, sharing authorization, active turn and
exact pending request before invoking the existing permission/ask handlers.
A request-wide lock prevents concurrent Web decisions. Any successful decision
consumes tokens for that request across tabs. Desktop resolution, timeout,
terminal turns, restart or logout invalidate cards; snapshots cannot resurrect
answered inputs. Only allow-once/deny is available remotely. Asktool supports
single/multi/custom answers and null skip/decline with bounded validation.
User-visible previews use the desktop redactor and render as text; internal
error bodies and raw request ids are not sent to Web.

## Consequences

Web and desktop can decide the same current request, with Host remaining the
source of truth and final resolver. Readiness/polling adds at most a short delay;
failed or stale decisions fail closed and refresh the browser's card set.
These actions cover tool permission and asktool input cards. Plan/Goal approval
and application lifecycle dialogs retain their existing local interfaces.
No sandbox bypass, permanent permission grant or automatic confirmation is
introduced. The normal task cancellation/disconnect path remains in force.
