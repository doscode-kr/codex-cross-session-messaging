# Codex Cross Session

[한국어](README.ko.md)

[User manual](docs/MANUAL.md) · [All documentation](docs/README.md)

Send messages between independent Codex CLI sessions on one computer.
The plugin uses the Codex shared daemon and a local Node.js broker.
It has no required project workflow.
Each session also saves and restores its own work across compaction.
This starts automatically and works without sending messages.

| Recipient state | Delivery |
|---|---|
| Busy | `turn/steer` adds input to the current turn. |
| Idle | `turn/start` starts a new turn. |
| Direct input unavailable | The tool returns an error. |

The plugin never uses a completion queue or an interrupt for delivery.
Long tool calls can delay message processing.
`accepted` means that Codex accepted the input.
It does not confirm reading or task completion.
The plugin never resends an `uncertain` message automatically.

## Requirements

- Node.js 20 or later.
- Codex CLI with shared daemon and plugin support.
- Independent CLI sessions on the same computer.

The recorded CI baseline passed with Codex CLI 0.161.0 on Windows and macOS with Node.js 20 and 22.
The verification record identifies the tested commits and skipped checks.
Each result applies only to its tested commit and environment.
Earlier Windows records also include a Codex 0.159.3 shared daemon.
Other Codex versions are unverified by those records.
The plugin enables the Codex `experimentalApi` capability.
Codex protocol changes can break session lookup or message delivery.
See [compatibility and verification limits](docs/VERIFICATION.md).

This release is experimental.
Use it for local collaboration with user supervision.
Check delivery results and recipient reports before you treat a task as complete.
The plugin does not guarantee model understanding or task completion.

## Install

1. Clone this repository.

   ```text
   git clone https://github.com/doscode-kr/codex-cross-session-messaging.git
   ```

2. Open the repository directory.

   ```text
   cd codex-cross-session-messaging
   ```

3. Examine the install commands.

   ```text
   node scripts/install.mjs --dry-run
   ```

4. Install the plugin.

   ```text
   npm run install:global
   ```

5. Open Codex or resume your saved session.
6. Review the plugin hooks in `/hooks`.
7. Trust the hooks after your review.
8. Enter `$cross-session` in Codex.

The installer registers this directory as the `cross-session-local` marketplace.
It installs `cross-session@cross-session-local` in your Codex user settings.
It does not approve hook trust.
Keep the source directory for updates.
For an isolated installation, use `node scripts/install.mjs --home <temporary-directory>`.
Use the direct Node.js command for options in PowerShell.
An npm PowerShell wrapper can consume options such as `--dry-run`.

## Use

Ask each session to set its name:

```text
$cross-session
Register this session as backend.
Show the available sessions.
```

Assign the leader only when you need that role:

```text
Make this session the cross-session leader.
```

Send a request from another session:

```text
Send my current status to the leader.
Ask frontend to check the API response format.
Notify me once when frontend next becomes idle.
```

The session list puts sessions from the same project first.
Git worktrees use the common Git directory for project matching.
You can also send to another project.
Messages do not prevent concurrent file changes.
Each recipient keeps its permissions and user task scope.
Peer messages are not user approval.

All sessions can ask questions, discuss shared work, and reply directly to each other.
They can then report their results to a user-assigned leader.
Direct peer communication does not require a leader.
For example, ask backend to discuss an API change with frontend and report the agreed result to the leader.
An agreement between peers must stay within each session's user-authorized task scope.
It cannot grant permission for a new action.
When file changes overlap, discuss the affected files before you continue.
Report unresolved conflicts to the leader if that role is assigned.

## Tools

| Tool | Function |
|---|---|
| `list_agents` | List loaded independent sessions. |
| `register_session` | Set this session's name. |
| `send_message` | Send a message immediately. |
| `reply` | Reply to a message's sender. |
| `read_messages` | Read the inbox or outbox. |
| `get_message` | Read a message and its delivery result. |
| `acknowledge` | Record the recipient's receipt confirmation. |
| `claim_leader` | Claim the leader role after user assignment. |
| `transfer_leader` | Transfer the current leader role. |
| `release_leader` | Release the current leader role. |
| `notify_when_idle` | Request one notification of the next idle state. |
| `list_idle_notifications` | List your pending notifications with IDs for cancellation. |
| `cancel_idle_notification` | Cancel your notification request. |
| `get_work_state` | Read this session's work summary and revision. |
| `set_work_state` | Save this session's checklist, attempt results, and work summary with a revision check. |
| `get_chain` | Read automatic continuity status for this session. |

See [work state and the optional Stop check](docs/CONTINUATION.md) for completion guidance and limits.
See [session chaining](docs/CHAINING.md) for automatic work continuity within each session.
The trusted SessionStart hook also reloads [project instructions](docs/PROJECT_GUIDANCE.md) when the same session resumes or compacts.

MCP tool results use short text by default.
The full result is available in `structuredContent`.
Set `detail: true` on a tool call when you need the full JSON result in text.
For a full message, use `get_message` with `message_id` and `detail: true`.
For a lost send receipt, use `read_messages` with `direction: "outbox"` and `detail: true`.
Codex can still display full structured data or peer context.
The option does not change message delivery, stored data, or permissions.
Send replies for results, required questions, or blocking errors.
Avoid replies that only confirm receipt.

Only the current leader can transfer or release the role.
The default message environment has one leader on the same computer.
That role is shared across projects in the same message environment.
The broker releases the role when the leader leaves the shared daemon.
It does not select another leader automatically.

Delivery results are `accepted`, `failed`, or `uncertain`.
After a lost send receipt, use `read_messages` with `direction: "outbox"`.
Check the saved message before you consider another send.
An idle notification is a state signal.
It does not prove task completion.
The broker checks subscribed sessions approximately once per second.
It can miss a brief state change.

## Local data and settings

The broker accepts requests on `127.0.0.1` with a random authentication token.
It writes messages and delivery results to a local JSONL journal.
It does not provide automatic retention or rotation.
See [privacy and security](SECURITY.md) before you share logs.

| Setting | Function |
|---|---|
| Default | Store data in `~/.codex/cross-session/`. |
| `CODEX_HOME` | Store data in `<CODEX_HOME>/cross-session/`. |
| `CROSS_SESSION_HOME` | Use this directory for the message environment. |
| `CROSS_SESSION_CODEX_BIN` | Use an absolute Codex executable or JavaScript entry path. |

Use the same settings for sessions that must share names and a leader.
Separate message directories do not share registrations or leader state.
On Windows, prefer the native `codex.exe` path.
The plugin does not restart or upgrade the running Codex daemon.

## Update and remove

Use the [update procedure](docs/OPERATIONS.md).
Use the [removal procedure](docs/UNINSTALL.md) to remove the plugin and optional local data.
Plugin removal and local data removal are separate operations.
Windows runtime directories with 8.3 path aliases need manual data cleanup.
Automatic cleanup also refuses a failed alias check.

## Check and support

Check the running daemon without sending messages:

```text
npm run doctor
```

Inspect the message broker without starting it:

```text
node plugins/cross-session/src/cli.mjs broker-status
```

See [broker status results](docs/OPERATIONS.md#inspect-the-message-broker) for metric definitions and errors.

Run the standard repository checks:

```text
npm ci --prefix plugins/cross-session --ignore-scripts
npm run check
npm test
```

The real Codex integration test needs a separate opt-in.
It uses a temporary `CODEX_HOME` and a local mock model server.
See [verification instructions](docs/VERIFICATION.md).

Sessions started with `--no-daemon` are not supported.
Sessions on another computer are not supported.
Sessions connected only to a separate app server are not listed by the shared daemon.
Codex can reject direct input during compaction or review.
The plugin does not answer approval requests.

For a bug, use the [issue tracker](https://github.com/doscode-kr/codex-cross-session-messaging/issues).
Include your OS, Node.js version, Codex version, and a redacted error.
Do not include message bodies or authentication tokens.
Use [SECURITY.md](SECURITY.md) for security reports.
See [CONTRIBUTING.md](CONTRIBUTING.md), [CHANGELOG.md](CHANGELOG.md), and the [release checklist](docs/RELEASE.md).

## License

This project uses the [MIT License](LICENSE).
The dependency `ws` has its own MIT license.
