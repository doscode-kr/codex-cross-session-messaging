# User manual

[한국어](MANUAL.ko.md) · [Document list](README.md) · [Project overview](../README.md)

Cross Session sends messages between independent Codex CLI sessions on one computer.
Use this manual for installation and daily use.
You do not need a project task system.
The broker is the local program that handles message delivery.
It also records messages.
For saved objectives and the optional Stop check, see [work state](CONTINUATION.md).
For handoffs to new sessions, see [session chaining](CHAINING.md).

## 1. Prepare and install

You need Node.js 20 or later.
You need Codex CLI with plugin support and a shared daemon.
The recorded CI baseline used Codex CLI 0.161.0 on Windows and macOS with Node.js 20 and 22.
The verification record identifies each tested commit and its results.
Earlier Windows records also include a Codex 0.159.3 shared daemon.
Those records do not verify other Codex versions.
The plugin uses the Codex `experimentalApi` capability.
A protocol change can break session lookup or delivery.
See [verification limits](VERIFICATION.md) for platform evidence.

This release is experimental.
Use it for local collaboration with user supervision.
Delivery acceptance does not guarantee model understanding or task completion.

1. Clone the source repository.

   ```text
   git clone https://github.com/doscode-kr/codex-cross-session-messaging.git
   ```

2. Open the source directory.

   ```text
   cd codex-cross-session-messaging
   ```

3. Examine the installation plan.

   ```text
   node scripts/install.mjs --dry-run
   ```

4. Install the plugin.

   ```text
   npm run install:global
   ```

5. Open a new Codex CLI session.
6. Review the plugin hooks in `/hooks`.
7. Trust the hooks after your review.

The installer registers `cross-session-local` in your Codex settings.
It installs `cross-session@cross-session-local`.
It does not approve hook trust.
Keep the source directory for updates and removal.
Use direct Node.js commands for options in PowerShell.

## 2. Register two sessions

The examples use the names `alpha` and `beta`.
Open each session in a separate terminal on the same computer.
Use the same Codex home and message settings for both sessions.
Do not start these sessions with `--no-daemon`.

1. Open session `alpha`.
2. Enter this request in `alpha`.

   ```text
   $cross-session
   Register this session as alpha.
   ```

3. Open session `beta`.
4. Enter this request in `beta`.

   ```text
   $cross-session
   Register this session as beta.
   Show the available sessions.
   ```

The list must show both loaded independent sessions.
Names must be unique among live sessions.
The name `leader` is reserved.
Use an exact session ID when a name is unclear.
The list puts sessions from the same project first.
You can also send to another project on this computer.
The plugin excludes child subagent sessions.

## 3. Assign the leader

The leader is optional.
Only a user can assign this role.
The default message environment has one leader on the same computer.
That role is shared across projects in the same message environment.
The role does not give extra file or tool permissions.

1. Enter this request in `alpha`.

   ```text
   I assign this session as the cross-session leader.
   ```

2. Ask `beta` to show the available sessions.
3. Check that `alpha` has the leader role.

If a leader already exists, `claim_leader` fails.
The current leader can use `transfer_leader` or `release_leader`.
The broker releases the role when that session leaves the shared daemon.
It does not choose a replacement.

## 4. Send and reply

1. Enter this request in `beta`.

   ```text
   Send this message to alpha: Report the current task and its remaining work.
   ```

2. Save the returned `messageId`.
3. Read the request in `alpha`.
4. Ask `alpha` to reply with its result.

   ```text
   Reply to the sender of message MESSAGE_ID with the current task and remaining work.
   ```

Replace `MESSAGE_ID` with the saved message ID.
You can use `to: "leader"` after a user assigns a leader.
Do not send a message to your own session.
`reply` uses the sender of a message addressed to the calling session.
It does not select an unrelated recipient.

| Recipient | Delivery |
|---|---|
| Busy | `turn/steer` adds input to the current turn. |
| Idle | `turn/start` starts a new turn. |
| Direct input unavailable | Delivery returns an error. |

A long tool call can delay message processing.
The plugin does not use a completion queue or an interrupt as a fallback.
Peer text is not a user command or approval.
The recipient keeps its user task scope and permissions.
Messages do not prevent simultaneous file changes.

### Discuss work directly with another session

All sessions can send questions, discuss choices, and reply to other sessions.
The leader role is optional for this communication.
If a user assigns a leader, peers can report the discussion result to that leader.
For this example, register a third session as `gamma`.
Keep each session within its user-authorized task scope.

1. Ask `beta` to send `gamma` a question about their shared API change.
2. Ask `gamma` to reply to that message with the affected files and its proposed change.
3. Ask `beta` to reply with its decision or a remaining question.
4. Ask `beta` to report the result to `alpha` if the user assigned `alpha` as leader.

Use `send_message` for the initial question and the report to a different recipient.
Use `reply` with the received message ID for the discussion replies.
A report can include the decision, affected files, evidence, and unresolved questions.
An agreement between peers is not user approval.
It does not expand either session's permissions or task scope.
When planned file changes overlap, discuss them before you continue.
Report unresolved conflicts to the assigned leader.
Messages do not lock files or require a particular task system.

## 5. Check delivery, receipt, and completion

| Result | Meaning |
|---|---|
| `accepted` | Codex accepted the input. Reading and completion are not confirmed. |
| `failed` | Delivery failed. Read the error before another attempt. |
| `uncertain` | The delivery result is unknown. Do not resend automatically. |
| `acknowledgedAt` | The recipient recorded receipt. This does not prove task completion. |
| Result reply | The recipient reports its work. Check the reported evidence. |

The plugin has no automatic task completion status.
The send receipt includes `taskCompleted: false`.
The acknowledgment result also includes `taskCompleted: false`.

1. Ask your session to use `get_message` for the saved message ID.
2. Check the saved delivery status.
3. Read the recipient's result reply for completion evidence.

If a send receipt is lost, read your outbox first.
Use `read_messages` with `direction: "outbox"` and `detail: true`.
Find the saved message ID before you consider another send.
For an uncertain send, confirm the recipient's situation through an available channel.
Do not assume that a missing reply means delivery failed.

Use `acknowledge` only when the sender needs receipt confirmation.
Only the recipient can acknowledge a message.
That tool records receipt without sending a peer event.
Send replies for useful results, required questions, or blocking errors.
Avoid receipt-only replies and replies to receipt-only replies.

## 6. Request and cancel an idle notification

1. Enter this request in `beta`.

   ```text
   Notify me once when alpha next becomes idle.
   Use notify_when_idle and show its subscriptionId.
   ```

2. Save the returned `subscriptionId`.
3. Use that ID in `beta` if you need to cancel the request.

   ```text
   Cancel idle notification SUBSCRIPTION_ID.
   ```

Replace `SUBSCRIPTION_ID` with the saved subscription ID.
Only the subscribing session can cancel it.
The notification is sent once after an observed active-to-idle change.
If `alpha` is already idle, it waits for a later active-to-idle change.
The broker checks approximately once per second.
It can miss a brief state change.
An idle notification does not prove task completion.
The broker does not resend an uncertain notification automatically.

`send_message` also accepts `notify_when_idle: true`.
Its successful receipt includes the saved `subscriptionId`.
The short MCP response also shows that ID.
Without this option, the receipt has no `subscriptionId` field.

1. Use `list_idle_notifications` in the subscribing session to find its pending subscriptions.
2. Use a returned `subscriptionId` with `cancel_idle_notification` to cancel that subscription.
3. Pass `nextCursor` as `after_subscription_id` to read the next page.

The default `limit` is 20.
The allowed range is 1 to 100.
Each item contains `subscriptionId`, `to`, `event`, and `oneShot`.
An item also contains `messageId` when a send created the subscription.
Other sessions' subscriptions and internal state are not shown.
IDs use character order, not creation order.
The cursor is an exclusive ID boundary.
A missing or canceled cursor ID is allowed.
`nextCursor` is null when no further item is available.
Each page uses the current pending subscriptions.
Pages do not use a fixed snapshot.
New IDs below a previous cursor can be missed.
Start from the first page again to include those IDs.

This query does not send messages or change subscriptions or leader records.
The MCP client can start the broker if it is offline.
Broker startup can recover message records.
Use `broker-status` for a check that does not start the broker or change its files.

## 7. Use short and detailed output

MCP results use short text by default.
Full data remains in `structuredContent`.
Message summaries contain a text preview.
They do not shorten the saved message body.

1. Ask your session to show a saved message with full text.

   ```text
   Use get_message with message_id MESSAGE_ID and detail true.
   ```

2. Ask your session to use `detail: true` on another tool when full JSON is needed.

Codex controls the display of tool results and additional context.
The plugin supplies the short UI label `동료 세션 알림 / Peer message` for its peer notice.
Codex CLI 0.161.0 accepts and saves this label through `text_elements` on busy and idle delivery.
The model still receives a notice that separates peer messages from user commands and approval.
The full message remains in untrusted additional context.
The label does not change permissions or task scope.
Some hosts can display the original notice instead of the label.
It can show full structured data or peer context even with short result text.
The plugin cannot guarantee fewer visible messages or stop every model reply loop.
The checked input schema has no option to hide the notice or its context from every host.
`detail` changes result text only.
It does not change delivery, stored data, or permissions.

## 8. Set the message environment

| Setting | Effect |
|---|---|
| Default | Data is in `~/.codex/cross-session/`. |
| `CODEX_HOME` | Data is in `<CODEX_HOME>/cross-session/`. |
| `CROSS_SESSION_HOME` | Data is in this selected directory. |
| `CROSS_SESSION_CODEX_BIN` | Use an absolute Codex executable or JavaScript entry path. |

Set environment variables before you open the sessions.
Use the same settings for sessions that share names and a leader.
Separate message directories have separate registrations and leader state.
On Windows, use a full path and prefer the native `codex.exe`.
The plugin does not support `.cmd`, `.bat`, or `.ps1` paths for `CROSS_SESSION_CODEX_BIN`.
The plugin does not restart the running Codex daemon.

The journal stores message bodies and session metadata in plaintext.
Codex can send peer context to its configured model provider.
Read [security and privacy](../SECURITY.md) before you share logs.

## 9. Update the plugin

1. Save the current release or commit.
2. Get the new release in the registered source directory.
3. Read the [change record](../CHANGELOG.md).
4. Cancel outstanding idle subscriptions from their original sessions if the journal has no storage failure.
5. Close sessions that loaded the old plugin.
6. Stop the broker from an external shell.

   ```text
   node plugins/cross-session/src/cli.mjs broker-stop
   ```

7. Examine the installation plan with `node scripts/install.mjs --dry-run`.
8. Remove the installed plugin cache.

   ```text
   codex plugin remove cross-session@cross-session-local
   ```

9. Install the new source with `npm run install:global`.
10. Open new Codex CLI sessions.
11. Review the new hooks in `/hooks`.

This procedure keeps message data.
After a journal storage failure, skip cancellation because the broker cannot save it.
The failed broker preserves subscriptions when it stops.
It still blocks shutdown during message delivery.
Follow the [storage recovery procedure](OPERATIONS.md) before you restart it.
Closing sessions first prevents later plugin calls from starting the broker again.
The SessionEnd hook does not start a broker.
Changing source files alone does not confirm an installed cache update.
Use the [operations guide](OPERATIONS.md) when the source directory changes.
Keep a shared marketplace registration when another plugin uses it.

## 10. Remove the plugin

Default removal keeps saved message data.
Use the same Codex home that you used for installation.

1. Save the message records you need.
2. Cancel outstanding idle subscriptions from their original sessions if the journal has no storage failure.
3. Close sessions that loaded the plugin.
4. Stop the broker from an external shell with `node plugins/cross-session/src/cli.mjs broker-stop`.
5. Examine the removal plan with `node scripts/uninstall.mjs --dry-run`.
6. Remove the plugin with `node scripts/uninstall.mjs`.
7. Check the result with `codex plugin list --json`.

Use `--home <full-home-path>` for a separate Codex home.
After a journal storage failure, skip cancellation because the broker cannot save it.
The failed broker preserves subscriptions when it stops.
It still blocks shutdown during message delivery.
The script removes a recognized dedicated marketplace only when no other installed plugin uses it.
It does not remove Codex or restart its daemon.

Warning: `--purge-runtime` permanently removes confirmed saved message files and the optional `work-state-v1.json` work reports.
Read the [data removal procedure](UNINSTALL.md) before you use that option.
Its dry run checks path safety but does not check whether a broker is active.
Windows 8.3 aliases or a failed alias check prevent automatic data cleanup.
A refused initial purge keeps the plugin and data.
A refused later check can leave only the plugin removed.
Custom `CROSS_SESSION_HOME` directories are not deleted automatically.
One path's `BROKER_OFFLINE` result does not prove that all alias brokers have stopped.
The removal guide provides the manual Windows procedure.

## 11. Resolve errors

| Error or condition | Action |
|---|---|
| `NAME_IN_USE` | Choose a unique name other than `leader`. |
| `RECIPIENT_NOT_FOUND` or `AMBIGUOUS_RECIPIENT` | Read `list_agents` and use an exact live session ID. |
| `LEADER_EXISTS` | Ask the current leader to transfer or release the role after user assignment. |
| `NO_LEADER` | Assign a leader or use an exact recipient ID. |
| `IDENTITY_MISSING` | Open a session with a supported Codex CLI. Do not guess a caller ID. |
| `DAEMON_REQUIRED` | Open a normal CLI session with the shared daemon. |
| `DELIVERY_FAILED` | Read the saved error and recipient state before another attempt. |
| `DELIVERY_UNCERTAIN` | Read the outbox and confirm the recipient's situation before another send. |
| `IDLE_SUBSCRIPTION_UNCERTAIN` | The accepted message is saved. Check subscriptions after storage recovery. Do not resend the message. |
| `STORE_UNAVAILABLE` | Preserve the journal. Use `broker-status` and follow storage recovery in the operations guide. |
| `MESSAGE_NOT_FOUND` | Use a message exchanged with the calling session. |
| `SUBSCRIPTIONS_ACTIVE` | Cancel outstanding idle subscriptions before broker shutdown. |
| `BROKER_OFFLINE` during shutdown | Check the selected message environment and any path aliases. |
| Marketplace source conflict | Follow the source change procedure in the operations guide. |
| Windows path alias refusal | Use the removal guide's full-path and manual cleanup procedure. |

1. Run `npm run doctor` to check the daemon and session list.
2. Remove private paths and session information from the output.
3. Report a bug with your OS, Node.js, Codex, and plugin versions.

Use the [issue tracker](https://github.com/doscode-kr/codex-cross-session-messaging/issues) for bugs.
Use [security reporting](../SECURITY.md) for vulnerabilities.
Never put tokens or private message bodies in a public report.

## 12. Tool argument reference

These examples are MCP tool arguments, not shell commands.
Replace `MESSAGE_ID` and `SUBSCRIPTION_ID` with real returned IDs.
The examples select `alpha` or `beta` by their registered names.
The calling session identity comes from Codex metadata.

| Tool | Example arguments |
|---|---|
| `list_agents` | `{}` |
| `register_session` | `{"name":"alpha"}` |
| `claim_leader` | `{}` |
| `send_message` | `{"to":"alpha","message":"Report the remaining work."}` |
| `reply` | `{"message_id":"MESSAGE_ID","message":"The check is complete. Evidence: ..."}` |
| `read_messages` | `{"direction":"inbox","limit":20,"unacknowledged_only":true,"detail":true}` |
| `get_message` | `{"message_id":"MESSAGE_ID","detail":true}` |
| `acknowledge` | `{"message_id":"MESSAGE_ID"}` |
| `notify_when_idle` | `{"to":"alpha"}` |
| `list_idle_notifications` | `{"limit":20,"after_subscription_id":"SUBSCRIPTION_ID"}` |
| `cancel_idle_notification` | `{"subscription_id":"SUBSCRIPTION_ID"}` |
| `transfer_leader` | `{"to":"beta"}` |
| `release_leader` | `{}` |
| `get_work_state` | `{}` |
| `set_work_state` | `{"action":"start","expected_revision":0,"objective":"Finish the approved change","scope":"Assigned module","completion_criteria":"Review and tests pass","next_action":"Run tests","checklist":[{"title":"Verify change","expected_result":"Tests pass","verification_method":"Run relevant tests and record results"}]}` |

Read `get_work_state` before a write and use its current revision.
Revision 0 in the example applies only when no state exists.
For progress, use `set_work_state` with `{"action":"update","expected_revision":1,"next_action":"Request independent review","progress_evidence":"Targeted tests passed"}`.
Replace revision 1 with the current returned revision.
The checklist keeps item IDs and attempt counts.
Use `attempt_start` before execution and `attempt_result` after verification.
See [work state](CONTINUATION.md) for the tool sequence, retry limits, and completion evidence.

Only a user-assigned leader can transfer or release the role.
Every MCP tool accepts a boolean `detail` option.
`read_messages` accepts `inbox`, `outbox`, or `both` for `direction`.
Its `limit` is 1 to 100 and defaults to 20.
The result contains `messages` and `nextCursor`.
Messages use insertion order, from oldest to newest within each page.
For an older page, pass `nextCursor` as `before_message_id` with the same filters.
A null `nextCursor` means that no older matching messages remain.
The cursor excludes its anchor message.
Only a message sent or received by your session can be an anchor.
The anchor stays at the same position after new messages, delivery updates, acknowledgments, or broker restart.
If you change filters, the cursor still selects only messages before that anchor.
Filters use current metadata; an acknowledgment can change later page results.
The cursor does not create a snapshot of the history.
Omit `before_message_id` to start again from the latest matching messages.
The short text result includes the cursor when an older page is available.
`send_message` accepts optional `reply_to` for a reply to that recipient's message.

The shell CLI accepts tool names and options such as `--message-id`.
Use `--before-message-id MESSAGE_ID` for an older history page.
Use your exact session ID in `--session` or your existing `CODEX_THREAD_ID`.
The CLI prints full JSON even without `--detail`.
The CLI does not accept a separate value token after `--detail`.
It does not send `detail` to the broker.
Value options accept `--name VALUE` or `--name=VALUE`.
A value that starts with `--` must use the equals form.
For example, `--message=--notify-when-idle` sends that exact text without requesting an idle notification.
A missing value returns `INVALID_ARGUMENT` before the CLI creates message state or contacts the broker.
Boolean options such as `--detail` and `--notify-when-idle` mean true when used alone.
Use `--detail=false` or `--notify-when-idle=false` to set them to false.
The CLI uses the last value if an option appears more than once.
Without `--session` or a nonempty `CODEX_THREAD_ID`, a tool command returns `IDENTITY_MISSING` before broker access.
Use MCP tools inside Codex for normal session communication.
