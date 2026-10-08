# Security and privacy

[한국어](SECURITY.ko.md) · [Document list](docs/README.md)

## Report a security problem

Do not put tokens, message bodies, or exploit details in a public issue.
Use the repository's private vulnerability reporting option if it is available:
[Report a vulnerability](https://github.com/doscode-kr/codex-cross-session-messaging/security/advisories/new).
The maintainer must enable that option before release.
If it is unavailable, open an issue that asks for a private contact method.
Include no vulnerability details in that public request.
No fixed response time is promised.

## Stored data

The plugin stores a journal called `events.jsonl`.
It can contain message bodies, session IDs, display names, project paths, permission labels, timestamps, delivery errors, and idle subscriptions.
The directory also contains an `auth-token` file.
The installer can also store `.cross-session-install.json` in the Codex home.
That record contains the plugin identity and source directory path.
The journal is plaintext.
The plugin does not encrypt the journal or apply an automatic retention period.
New files request owner-only Unix permissions.
Those mode values do not provide a Windows ACL guarantee.
Use your operating system's access controls for the data directory.

The default directory is `~/.codex/cross-session/`.
`CODEX_HOME` changes the parent directory.
`CROSS_SESSION_HOME` selects a separate message directory.
See [removal](docs/UNINSTALL.md) for data cleanup.

The plugin sends peer context into the recipient's Codex turn.
Codex can include that context in requests to its configured model provider.
Local broker storage does not mean that message content stays off the model provider.
Send only content that both sessions are permitted to use.

## Trust boundary

The broker listens on `127.0.0.1`.
Broker requests need the local authentication token.
The implementation rejects requests with an HTTP Origin header.
This boundary does not isolate programs that can read the same user's files.
It is not a boundary between hostile programs running as the same OS user.

The plugin identifies the caller from Codex session metadata.
The broker limits message reads to the sender or recipient.
Peer text is untrusted additional context.
The recipient keeps its own user scope and permissions.
Sender permission labels do not grant permission to the recipient.
Only the user can assign the leader role.
The plugin does not answer approval requests.

## Supported security fixes

This project is at version 0.1.0.
No separate long-term support branch is provided.
Use the latest release after you read its compatibility notes.
Report the release or commit you use.
