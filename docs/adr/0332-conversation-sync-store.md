# ADR 0332: Conversation sync store matches nanomuse save rules

- Status: Accepted
- Date: 2026-10-27

## Context

PI Workbench phase 5 keeps the project-control relay transient: it must not
store payloads. nanoMuse's conversation sync does the opposite for chat text.
Devices push conversations and messages; the relay assigns a per-account seq,
stores truncated text, and lets other devices pull by cursor.

The requested behavior is that save logic and its effect match that store, not
the transient project-control relay.

## Decision

`@pi-desktop/conversation-sync` is a separate SQLite store and `/v1/sync/*`
HTTP surface. Accepted writes follow the nanomuse rules:

- one monotonic seq per account; the counter is not rewound when sync is turned off
- one live `main` conversation; a second main is refused with `main_exists`
- message text is cut at 16 KB UTF-8 without splitting a character
- attachments keep name, mime, and size only, at most 20
- known message ids are idempotent unless the new write is a tombstone
- deleting a conversation tombstones it and deletes its texts immediately
- at most 2,000 live side conversations and 20,000 live messages
- tombstones older than 30 days are removed on the next push
- `working` presence stays in memory for 10 minutes and is not written

Project-control frames, files, and pictures are not part of this store.
Local host-core transcripts are unchanged.

## Consequences

An operator of this service can read stored chat text. That is the requested
effect. It does not weaken the phase 5 rule for project-control relays.
Desktop sessions do not push into this store until a later client wires them.
