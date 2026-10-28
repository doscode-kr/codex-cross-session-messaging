# Changelog

[한국어](CHANGELOG.ko.md)

## 0.2.1

- Report the installed plugin version consistently in broker health, MCP server metadata, and native client metadata.

## 0.2.0

- Correct session chaining to automatic work continuity within the same session.
- Remove cross-session link, relink, unlink, and launch flows. Old calls fail without changing state.
- Keep earlier chaining records untouched. New records use `session-continuity-v1`.
- Restore only records with the same session UUID and verified project boundary.
- Keep current AGENTS body injection at startup and context recovery.
- Exclude built-in project instructions from the first observed work request.
- Shorten long restored records without changing the saved checkpoint or losing checklist item IDs and states.
- Bound the full broker hook operation, including status checks and startup polling.
- Give non-startup hook processes five seconds for startup, bounded work, and exit.
- Accept empty old-version cache directories left by Windows during an upgrade without stopping their processes.

## Earlier development before 0.2.0

The linking and handoff entries below describe the earlier implementation.
Version 0.2.0 replaces those flows with continuity inside each session.

- Inject project AGENTS file contents at startup, resume, and compaction through the installed SessionStart hook.
- Keep instruction discovery inside the current worktree, with bounded reads and isolated failure handling.
- Do not add project bodies on ordinary UserPromptSubmit events. See [project guidance](docs/PROJECT_GUIDANCE.md).

- Deliver peer bodies without a second lookup notice, with a bounded fallback for explicit input rejection.
- Add `request_id` to recover send and reply receipts without another native submission.
- Separate storage, target acceptance, recipient receipt, and unreported task completion.
- Preserve unknown idle notification outcomes, including older journal records.
- Add handoff reason codes and verified session/checkpoint relationships.
- Document the separate responsibilities of project hooks and plugin hooks.

- Add session chaining with exact UUID bindings and immutable checkpoints.
- Reject `chain launch` with `CHAINING_LAUNCH_UNSUPPORTED`: the shared daemon cannot receive the child-only ticket.
- Restore untrusted handoffs from existing work-state reports and bounded automatic records.
- Keep the first source handoff pending until SessionStart outputs it, so earlier save hooks cannot hide it.
- Add `chain` CLI commands and caller-owned link, status, unlink, and relink MCP tools.
- Add read-only hook trust and chaining storage diagnostics.
- Add the `PreCompact` hook event. Review and trust the new event in Codex `/hooks` after updating.
  Existing hook command strings and array positions remain the same.
- Keep SessionEnd from starting a broker and give checkpoint work a short time budget.

- Add fixed work checklist items with verification methods and completion evidence.
- Limit each item to one initial attempt and three retries.
- Block exhausted items and reject overall completion while required items remain incomplete.

- Add caller-owned work summaries with revision checks and separate storage.
- Add an optional Stop check with one continuation, a ten-minute eligibility limit, and no automatic reactivation.
- Keep Stop and Interrupt hooks from starting a broker or exposing raw errors.
- Add skill guidance for remaining work, completion evidence, and user stops.

- Recheck installation paths before and after Codex commands and before temporary file cleanup.
- Use fixed JSON error messages for installation records and cached package files without showing their contents.

- Reject invalid HTTP request UTF-8 before message delivery or journal changes.
  Preserve valid Korean text, emoji, and replacement characters.

- Add `list_idle_notifications` to inspect your pending subscriptions with bounded pages.
  Return the saved subscription ID when a message requests an idle notification.
- Validate journals during removal without changing files or exposing damaged record text.

- Permit an explicit broker stop after journal failure while keeping pending subscriptions.
  Keep shutdown protection for active deliveries and healthy subscriptions.

- Preserve delivery IDs and known outcomes when result storage fails.
  Report an uncertain idle subscription separately from a saved message acceptance.
- Reject missing CLI values before broker access.
  Support `--option=VALUE` for values that start with `--`.
- Reject invalid journal UTF-8 without replacing characters or removing complete events.
- Keep journal contents out of JSON and unknown-event error messages.

- Add a read-only `broker-status` command with journal and pending-work metrics.
  Do not create local state or start the broker during inspection.
- Add permission-checked cursors to read older message history pages.
- Preserve UTF-8 across hook input chunks and avoid state creation for ignored hooks.
- Ignore inherited Git path variables when a hook identifies its project.
- Return journal body read errors before sending HTTP response headers.
- Classify incomplete or invalid broker responses without repeating the request.
  Reject HTTP redirects without forwarding message bodies.

- Close client HTTP connections to avoid stale sockets after a broker restart.
  Do not resend requests after a lost response.
- Replay journals in chunks and read message bodies on demand.
  Preserve message data and skip identical metadata writes.
- Keep MCP and native RPC connections available after malformed input.
  Clear pending request state when a send fails synchronously.
- Close the journal and listener when broker startup recovery fails.
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
