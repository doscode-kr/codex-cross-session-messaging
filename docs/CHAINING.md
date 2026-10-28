# Keep each session's work across compaction

[한국어](CHAINING.ko.md) · [Documentation](README.md) · [Work state](CONTINUATION.md)

Session chaining helps each Codex session continue its own work.
It starts automatically with the session.
Before compaction, it saves the session's work records.
After compaction, it adds those records to the next model input for the same session.
When the user closes the session, it saves the last record and marks the session closed.

It works with one session.
With sessions A, B, and C, each session restores only its own records.
Use the existing message tools for collaboration between sessions.
Chaining does not import another session's work or open a new session.

## Use

1. Update the plugin with the [operations guide](OPERATIONS.md).
2. Review the plugin hooks in Codex `/hooks`.
3. Trust the hooks you want to use.
4. Continue work in the current project.

You do not need a chain name or a link command.
The hook also injects the current AGENTS contents as described in [Project guidance](PROJECT_GUIDANCE.md).
It supplies the text, not only a reminder to read the file.
Ordinary later prompts do not append the same contents again.
Startup and context recovery read the files again.

## Events

| Event | Action |
|---|---|
| SessionStart / startup | Verify the session ID and project, then prepare automatic storage. |
| PreCompact | Save this session's records before compaction. |
| SessionStart / compact | Add this session's records and current AGENTS contents to the next model input. |
| Stop | Save records from the completed turn. |
| SessionEnd | Save the last records and mark the session closed. |
| SessionStart / resume | Restore only this session's records when the user reopens the same session. |
| SessionStart / clear | Reset the saved context range so earlier work is not injected again. |

The end hook does not start another Codex process or session.
The plugin does not reopen a closed session automatically.
Restore does not authorize more work or rearm Stop continuation.

## Session isolation

The state and checkpoint contain the session UUID and project boundary.
A checkpoint is a work record saved at a specific time.
Restore checks both values against the current session.
Git projects use the real root of the current worktree.
A common Git directory does not join records from different worktrees.
A failed check stops that restore.
The plugin does not select a replacement by session name or modification time.

## Saved contents

- The first observed user message record
- Recent user and assistant message records
- This session's work-state report
- Items reported complete and remaining checklist items
- Limited Git status

If the first request cannot be identified, the record states that it is unavailable.
A recent message is not treated as the first request.
Automatic transcript reads have byte and record limits.
Long restored records are shortened to fit the context budget and marked as truncated.
This does not change the saved checkpoint.
The session can update its objective, remaining work, and evidence with `set_work_state`.
If no structured work report exists, the output says that only automatic records are available.

Restored records are earlier conversation data and model reports.
A model completion report is not independent verification.
Peer messages and past records are not new user commands or approval.
The current user request and session permissions still apply.
AGENTS files are read separately.
Past work records do not replace their contents.

## Inspect status

Call `get_chain` in the current session to inspect its automatic storage state.
The tool keeps its old name for compatibility.
The CLI also supports `chain status` and `chain doctor`.
A status query does not prove hook execution or model compliance.
The doctor reports configured, enabled, and trusted hooks separately.

```text
node plugins/cross-session/src/cli.mjs chain status --session YOUR_SESSION_UUID
node plugins/cross-session/src/cli.mjs chain doctor
```

Replace the placeholder with your session UUID.
MCP derives the caller UUID from Codex metadata.
The model cannot specify a different session UUID to import its work.

## Update from the earlier design

The earlier cross-session linking design did not match the intended behavior.
This version corrects chaining to automatic context continuity within each session.
`link_chain`, `unlink_chain`, and `relink_chain` are removed from the public tool list.
Old link commands and `chain launch` calls return an error.
Rejected calls do not create a ticket or session.

New records use `session-continuity-v1` in the message directory.
Existing `chaining-v1` files remain on disk.
The new restore path does not read old bindings or tickets.
It does not convert another session's old records into new session records.

## Files and failures

Records are local plaintext files.
Warning: Do not put secrets in work records.
Restored records and AGENTS contents can be sent to the configured model provider.
The plugin does not call an external model to create a checkpoint.

Writes use locking and atomic replacement.
Storage bytes, record counts, and execution time have limits.
Broker hook work has one deadline across status checks, startup polling, and the hook request.
The deadlines are five seconds at startup, three seconds for user input, and 1.8 seconds for passive events.
The host allows ten seconds for startup and five seconds for other hook processes, including process startup and exit.
A failed save is not reported as successful.
A failed restore never uses another session's records.
Checkpoint errors and AGENTS read errors are reported separately.
These failures are separate from the message delivery path.

Tests can verify that contents reached model input.
They cannot guarantee that the model remembers or follows every instruction.
