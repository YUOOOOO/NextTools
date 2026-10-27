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

The desktop signs in from Settings → Cloud sync. The access token is encrypted
with the operating system store. Sync chats pushes local user and assistant
text; tool rows are not sent.
Unknown tokens answer `401 bad_key`. Calls while sync is off answer `409 sync_off`.
