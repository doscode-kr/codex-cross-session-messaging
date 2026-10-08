# Changelog

## Unreleased

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
