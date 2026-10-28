# ADR 0333: Cloud project groups route continuation to the original desktop

- Status: Accepted
- Date: 2026-10-28

## Context

The cloud mirror retained text but discarded project identity. Its Web console
could inspect a stored conversation but could not continue that exact desktop
session. Creating another generic Web session loses the original project,
model selection and context. Accepting arbitrary Host session ids would expose
unshared local sessions to remote calls.

## Decision

Extend the existing conversation metadata with an opaque project id, a display
name, an execution device and the original Host session id. The desktop hashes
its project identity rather than sending full filesystem paths. Web groups by
execution device plus project id, including a global group. The additive cloud
schema migration preserves existing rows and legacy clients cannot erase new
metadata by omission. The execution device cannot be replaced by another
account device's push.

The Web console reads a selected conversation's bounded stored history and
uses the original task protocol with an explicit cid/sessionId. The Hub verifies
these match the account's live synced metadata and destination. The desktop
also requires a session it successfully shared under the current server/account,
checks it still exists and is local, then invokes normal Agent admission and
abort. It preserves project/model/mode and narrows permissions to ask. It never
creates a replacement session for a missing continuation target. Stop remains
owned by the caller; concurrent aliases share one Host-session busy lease.

## Consequences

Older clients can still push and read conversations. Existing rows become
controllable after the owning desktop uploads metadata. Offline devices leave
history visible with a disabled composer and reconnect re-enables continuation.
Metadata sharing must precede execution; arbitrary sessions are rejected even
when the caller knows their ids. This is a stored chat mirror extension and
does not change the transient project-control relay, S3 config sync, Host-owned
local database or plugin permission boundaries. No cloud worker/model runtime
is introduced: the original desktop remains the executor.
