# Changelog

[한국어](CHANGELOG.ko.md)

## Unreleased

- Close client HTTP connections to avoid stale sockets after a broker restart.
  Do not resend requests after a lost response.
- Replay journals in chunks and read message bodies on demand.
  Preserve message data and skip identical metadata writes.
- Keep MCP and native RPC connections available after malformed input.
  Clear pending request state when a send fails synchronously.
- Close the journal and listener when broker startup recovery fails.
- Provide a short peer message display label while retaining the full untrusted context.
- Stop session discovery when the daemon repeats a page cursor.
  Read overlapping session IDs only once per discovery.
- Move session and idle history queries outside serial state updates.
  Preserve cancellation and shutdown checks before sending late idle notifications.
- Keep message history selections within the requested result limit.
- Retry a discovery `thread/read` once for the specific `-32603` empty-rollout metadata error.
  The metadata path and rollout path must match.
  This is a read retry, not a message resend.
- Allow delivery to another recipient while a Codex delivery response is pending.
  Keep submissions to the same recipient in order without waiting for its turn to finish.
- Protect pending delivery records during broker shutdown.
- Preserve an acknowledgment saved before the Codex delivery response in the send receipt.
  Confirm receipt only when that acknowledgment is recorded.
  This does not confirm task completion.
- Add peer-to-peer regression checks for direct questions, replies, and reports to a leader.
- Clarify experimental Codex API compatibility and direct peer collaboration in both languages.
- Find completed turns across history pages for one-time idle notifications.
- Show recovery steps when installation records refer to a missing source checkout.
- Preserve Korean text and emoji across HTTP request chunks.
- Stop journal writes after a write failure to prevent later records from overwriting the failed event.
- Run explicit test files on Node.js 20 and 22.
- Record passing Windows and macOS CI checks for the tested baseline.

- Add complete English and Korean manuals, reference documents, and documentation indexes.

- Refuse automatic Windows data cleanup when an 8.3 path alias is possible or its check fails.

- Use short MCP result text by default with optional `detail: true` text.

- Add English and Korean installation and operations documents.
- Add removal guidance and local data information.
- Add contribution, security, and release guidance.
- Add the MIT project license and repository package metadata.
- Limit the CI token to read access for repository contents.

## 0.1.0

Initial implementation; no release tag is claimed by this document.

- Immediate messages between independent sessions on one computer.
- Busy-session steering and idle-session turn start.
- Session names and one leader per message environment.
- Replies, read acknowledgments, and one-time idle notifications.
- Local authenticated broker and durable JSONL journal.
- Windows tests and an isolated real Codex integration test.
- Windows and macOS CI configuration.
