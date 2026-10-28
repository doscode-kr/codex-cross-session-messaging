# Continue work in another session

[한국어](CHAINING.ko.md) · [Document list](README.md) · [Work state](CONTINUATION.md)

Session chaining gives a new Codex session a saved handoff from an exact source session.
It also restores a checkpoint after context compaction or a session resume.
All sessions must use the same computer and message directory.

A chain has a user-selected ID.
A binding connects one full session UUID to one chain.
A checkpoint is an immutable copy of the handoff at one time.
The binding pins the source checkpoint when you connect the sessions.
Later source updates do not change that pin.
After the new session saves its own checkpoint, its next resume uses that newer checkpoint.

## Prepare the source session

1. Install the updated plugin as described in [operations](OPERATIONS.md).
2. Review the plugin hooks in Codex `/hooks`.
3. Trust the hooks that you intend to use.
4. Open a new session with the updated plugin.
5. Call `link_chain` with `{"chain_id":"release-fix"}`.
6. Save your work with `set_work_state` as described in [work state](CONTINUATION.md).
7. Finish the turn so the Stop hook can save a checkpoint.
8. Call `get_chain` to read the full session UUID and checkpoint IDs.

Chain IDs accept 1 to 80 ASCII letters, digits, periods, underscores, and hyphens.
Session and checkpoint IDs must be full UUIDs in lowercase.
Names, UUID prefixes, branches, and the newest session cannot select a source.

The structured handoff comes from the existing work-state file.
Save decisions and evidence references in `progress_evidence`.
Keep remaining work in the checklist and `next_action`.
Update these fields when a work unit ends or the next action changes.
Automatic transcript records cannot replace this report.
If no work state exists, the restored context says that it has automatic records only.

## Launch availability

`chain launch` currently returns `CHAINING_LAUNCH_UNSUPPORTED`.
It does not create a ticket or start a process.
The shared Codex daemon does not receive environment variables from a newly attached CLI process.
An environment-only ticket therefore does not reach SessionStart.
Windows tests confirmed this failure with Codex 0.164.0.
Passing the ticket through a session config override instead used a separate server in tests with 0.161.0 and 0.164.0.
That server cannot provide this plugin's shared-daemon session identity.
An absolute `--codex-js` path or `--no-daemon` does not remove this restriction.

The ticket storage and hook claim checks are implemented, but a supported launch transport is still missing.
The checks distinguish `claimed`, `owner_resume`, `expired`, `consumed`, `mismatch`, `missing_ticket`, and `invalid_ticket`.
An unused ticket expires after ten minutes; its owner can resume after that limit.
A rejected ticket does not inject a handoff.
Tickets bind to their first consumer, without authenticating the parent's intent.
Do not put tickets in global configuration or a shell profile.

## Restore into a closed session

1. Record the full UUID of the receiving session.
2. Close that session completely.
3. Run the following command from another terminal.
4. Resume the receiving session by its exact UUID.

```text
node plugins/cross-session/src/cli.mjs chain link --session RECEIVING_UUID --chain-id release-fix --source-session-id SOURCE_UUID
```

Replace both placeholders with full lowercase UUIDs.
The source must have its own saved checkpoint in the selected chain.
The next SessionStart restores the pinned handoff.
Codex can run SessionStart on the first input.
Keep the receiving session closed between the link command and resume.

## Connect an existing session

Call `link_chain` in the receiving session:

```json
{"chain_id":"release-fix","source_session_id":"11111111-0000-4000-8000-000000000001"}
```

The MCP tool gets the caller UUID from Codex metadata.
It has no caller session argument.
A connected source without its own saved checkpoint returns `CHAINING_NO_CHECKPOINT`.
The CLI equivalent is `chain link --session UUID --chain-id ID --source-session-id UUID`.
CLI commands can use `CODEX_THREAD_ID` instead of `--session`.
A link call does not alter the current model context.
The binding stays in `restore_pending` until SessionStart outputs the source handoff or its bounded reference.
While pending, save hooks return `awaiting_restore` and do not replace the source with a new checkpoint.
Resume the same UUID to receive the handoff.
After a successful output write, the hook records confirmation.
Normal checkpoint saves resume after that record is saved.
This is an output acknowledgement, not proof that the host or model read the handoff.
If confirmation fails before commit, the next SessionStart can repeat the source handoff.
If the confirmation result is uncertain, the hook does not retry it automatically.

## Check and correct a binding

1. Call `get_chain` to read the current binding.
2. Call `unlink_chain` with its `expected_chain_id` and `expected_checkpoint_id`.
3. Read the returned `tombstone.id`.
4. Call `relink_chain` with that `tombstone_id`, the new `chain_id`, and the exact source UUID if needed.

For the expected checkpoint, use `latest_checkpoint_id` if present.
Otherwise use `pinned_checkpoint_id`.
Use the string `none` if both are null.
A concurrent save can change the latest checkpoint.
Read the binding again if unlink returns `CHAINING_CONFLICT`.
The unlink record blocks automatic reconnection and saves for that UUID.
Relink requires the exact unlink record ID.
The CLI provides the same `status`, `unlink`, and `relink` commands under `chain`.
Use `chain --help` for their options.

Unlink cannot erase context already sent to a model.
Use a new session after a wrong handoff.
Use these commands to correct bindings; do not delete store files as a recovery step.

## Hooks and diagnosis

`Stop`, `PreCompact`, and `SessionEnd` save connected sessions.
Stop includes the host's last assistant message when available.
SessionEnd has a short time budget and does not run retention cleanup or Git commands.
Unconnected sessions and subagents do not save checkpoints.
The hook rejects a transcript whose UUID differs from the hook input.
It reads identity from the file head and recent user/assistant text from the tail.
It excludes tool results, reasoning, and system/developer messages.
It skips broken JSON lines without skipping identity checks.

Every root SessionStart adds `Cross-session chaining hook attached.`
The context reports `unbound`, `bound_no_notes`, `restored`, `rejected`, `unlinked`, or `storage_error`.
It also includes a short `reason`:

| Status and reason | Meaning |
|---|---|
| `unbound` / `STORAGE_NOT_INITIALIZED` | The message directory does not exist. No handoff was selected. |
| `unbound` / `NO_BINDING` | The verified session has no binding in the current store. |
| `bound_no_notes` / `NO_CHECKPOINT` | The binding exists but has no checkpoint. |
| `restored` / `CHECKPOINT_LOADED` | The selected checkpoint passed storage checks and was prepared for output. |
| `unlinked` / `EXPLICITLY_UNLINKED` | An explicit unlink record prevents automatic restoration. |
| `rejected` / `CHAINING_TICKET_STORE_MISSING` | An explicit ticket needs a store that is absent. |
| `rejected` / `CHAINING_TICKET_REJECTED` | `ticket_status` explains why the ticket was refused. |
| `rejected` or `storage_error` / other `CHAINING_*` code | Identity, context preparation, or storage checks failed. |

`lifecycle` records the host's startup, resume, clear, or compact event when supplied.
This event does not prove that a previous binding existed.
An unbound new session is normal unless an explicit recovery request requires a binding or ticket.
The plugin cannot infer deleted history from an absent store.
A missing or corrupt checkpoint of an existing binding fails closed; it does not become `unbound`.

`relationship.receiving_session_id` identifies the current session.
`source_session_id` identifies the source fixed by the binding.
`checkpoint_session_id` identifies the owner of the selected checkpoint.
`selected_from` is `pinned_source` for the source handoff or `own_latest` for later progress.
The binding, chain, and checkpoint IDs connect these records without copying conversation text into diagnostics.
`restored` is not proof of model receipt or work completion.
Keep the original request, reported results, and remaining checklist items separate in the work-state report.

The attachment line is absent when Codex does not run the hook.
Run this read-only command to inspect the installed hooks and store usage:

```text
node plugins/cross-session/src/cli.mjs chain doctor
```

The result lists each hook's configured, enabled, and trust status.
It reads these values from Codex `hooks/list`; it does not approve trust.
`ready` means configured, enabled, and trusted.
It is not proof that a hook ran.
Use the attachment line and checkpoint status as execution evidence.
New hook events require another trust review after an update.
This release adds `PreCompact` and preserves the existing hook command strings and positions.

The plugin adds its rules and handoff only at SessionStart.
Its UserPromptSubmit hook updates session registration and does not add guidance text.
It also reloads local AGENTS contents as described in [project instructions](PROJECT_GUIDANCE.md).
This does not require a chain binding.
Project hooks can provide other task-specific rules.
The plugin does not remove or rewrite another hook's output.
If project guidance repeats, inspect both hook registrations and the command that writes that guidance.
A project hook can send full rules on SessionStart and changes on later inputs in the same session.
It must send full rules again after context restoration or compaction.
A display cache must not imply message receipt or work completion.

Restored data is explicitly marked as untrusted.
Structured handoffs are model reports, not independent verification.
Automatic records are marked as unconfirmed.
Prior next actions are suggestions within the current user's request and permissions.
The restore does not copy work-state ownership or restore Stop continuation eligibility.
Do not use a new session to reset unfinished checklist attempts.

The context has a byte limit.
It removes automatic messages first, then Git data, then older list entries.
If needed, it replaces oversized handoff text with checkpoint identifiers.
It keeps valid JSON, a reduction marker, and the original checkpoint path.
It never changes the checkpoint on disk to reduce context size.

## Storage and limits

The message directory contains `chaining-v1/state.json` and `chaining-v1/checkpoints/`.
The default directory is `$CODEX_HOME/cross-session`, or `~/.codex/cross-session` without `CODEX_HOME`.
`CROSS_SESSION_HOME` selects a different message environment.
Checkpoints copy the existing work-state report; they are immutable historical records.
Writers use an exclusive lock and atomic publication.
Concurrent writes either succeed without damage or return `CHAINING_BUSY`.
The hook stops a slow checkpoint helper before its time budget ends.
It releases only the matching lock of a helper whose exit it confirmed.
An interrupted parent can leave a lock in place; `chain doctor` reports `lock_present`.
That lock stops later writes until its ownership can be resolved.
Do not infer a failed save from a timeout or repeat uncertain writes automatically.

| Limit | Default |
|---|---|
| Index | 2 MiB |
| One checkpoint | 256 KiB |
| Entire chaining store | 64 MiB |
| Checkpoint files | 2,048 |
| Active bindings | 1,024 |
| Unlink records | 2,048 |
| Tickets | 4,096 |

After a successful save, cleanup retains at most 20 recent unprotected checkpoints per saving session within 30 days.
Active latest checkpoints, pinned sources, and claimed or unexpired ticket sources remain protected.
Cleanup does not remove another session's checkpoints.
Unknown or unreadable records remain in place with a warning.
A cleanup failure does not undo a successful save.
A write over a limit returns `CHAINING_LIMIT` before cleanup can remove data.
Protected records can therefore fill the store.
This release has no automatic purge for protected records.
`chain doctor` reports usage and limits.
A separate `CROSS_SESSION_HOME` starts a separate environment; it does not migrate old bindings or checkpoints.
An unavailable store disables chaining while message delivery remains available.
Plugin removal keeps these checkpoints, including when `--purge-runtime` removes the confirmed message files.

## Privacy and known limits

Do not put secrets in handoffs or conversation text that a checkpoint can save.
The same OS account can read the local checkpoint files.
Restored content can reach the configured model provider as model input.
The plugin does not call an external model to make or summarize checkpoints.

- Chaining does not change reasoning ability within a session.
- Automatic records do not transfer decisions and unfinished work reliably; the session must write a structured handoff.
- Chaining works on one computer only.
- Untrusted hooks do not save checkpoints.
- Unlink cannot remove context that was already injected.
- Tickets bind to the first consumer, without authenticating the parent's intent.
- Handoffs are model reports, not independent verification results.

See [verification](VERIFICATION.md) for executed tests and platform limits.
