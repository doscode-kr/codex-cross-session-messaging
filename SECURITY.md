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
Optional work summaries are stored in plaintext in `work-state-v1.json` in the same directory.
They can contain objectives, scope, completion criteria, next actions, and reported evidence.
Work state has no automatic retention period.
Do not save secrets in work state.
Work-state tool results can also reach the configured model provider.
[Session continuity](docs/CHAINING.md) stores plaintext checkpoints in `session-continuity-v1`.
They can include the first observed user record, recent messages, work reports, Git state, and the session UUID and project.
Each session can restore only its own records from its verified project.
The latest checkpoint of each retained session is protected from cleanup.
Closed sessions can expire under the retention limits.
The old `chaining-v1` store is preserved but is not read or migrated.
The same OS account can read these records.
Restored records can reach the model provider and must not contain secrets.
The plugin does not make an external model call to create a checkpoint.
Clearing context does not erase records already sent to the model.
Continuity does not link other sessions or start a new Codex process.
The SessionStart hook reads local [project instructions](docs/PROJECT_GUIDANCE.md) into model context.
The plugin does not store these bodies in its journal or checkpoints.
Codex can retain them in conversation records and send them to the model provider.
They do not grant new approval or change session permissions.
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
Work-state tools operate on the caller's state only.
An active or completed declaration does not prove user approval or actual completion.
Checklist checks validate state transitions and evidence fields, not the truth of those reports.
An exhausted item cannot gain more attempts through a claimed approval field.
The optional Stop check is off by default and permits at most one extra continuation.
Its fixed prompt does not copy peer text or saved work text into a user instruction.
See [work state and Stop limits](docs/CONTINUATION.md).

## Supported security fixes

This project is at version 0.2.0.
No separate long-term support branch is provided.
Use the latest release after you read its compatibility notes.
Report the release or commit you use.
