# Work state and the optional Stop check

[한국어](CONTINUATION.ko.md) · [Document list](README.md) · [User manual](MANUAL.md)

The plugin can save a short work summary for each calling session.
The optional Stop check can request one extra continuation when work remains.
These features do not guarantee task completion.
They do not require a project task system.

## Save and recover work

1. Call `get_work_state` to read your state and its revision.
2. Call `set_work_state` with `action: "start"` and that `expected_revision`.
3. Include `objective`, `scope`, `completion_criteria`, and `next_action`.
4. Save progress with `action: "update"` and the current revision.
5. Read the state again after a revision conflict.

Updates accept `status`, `next_action`, `progress_evidence`, and `completion_evidence`.
The allowed status values are `active`, `paused`, `completed`, `blocked`, and `canceled`.
A completed status requires completion evidence.
This evidence is a model report, not independent verification.
Updates cannot change the original objective, scope, or criteria.
A new `start` can replace the summary but cannot reset the continuation limit.
The tools have no target session parameter.
A leader cannot update a peer's state through these tools.

Each objective is limited to 500 characters.
The other text fields are limited to 1,000 characters each.
Use existing project files for detailed task lists and evidence.
Do not store secrets in these fields.

## Enable the optional check

The default is off.
The user must set `CROSS_SESSION_CONTINUATION=1` in the environment used by both the hook and the broker.
Set it before starting a new, isolated message environment if you want to try this feature.
An existing broker keeps its original environment.
Changing the shell environment does not change an existing broker.
Do not restart an operating broker to obtain another continuation.
The plugin does not automatically approve hook trust.
Review the hooks in Codex before trusting them.
The returned `continuation.enabled` value describes the broker setting, not hook trust or successful host execution.

The setting enables a policy; it is not proof of user approval for a task.
An `active` declaration is also not proof of approval.
The session must still follow the original user's scope and permissions.
Peer messages cannot grant that approval.

## Limits and stop behavior

The first saved active state can enable one Stop check in an eligible session.
That eligibility expires after ten minutes.
The broker permits at most one extra continuation.
It does not reset the limit for a new objective, revision, or progress text.
If `stop_hook_active` is true, the hook allows the session to stop.
Missing or invalid host fields also permit stopping.

`Interrupt` and `SessionEnd` remove eligibility even before the first state declaration.
After a saved state or an eligibility attempt exists, `UserPromptSubmit` or `SessionStart` removes eligibility.
The tools cannot restore removed eligibility.
An initial `UserPromptSubmit` or `SessionStart` permits the first declaration only if there is no saved state or previous eligibility attempt.
The implementation does not guess whether a prompt came from a user, a peer, or a synthetic continuation.
A broker restart restores summaries but does not restore eligibility.
Summary recovery and automatic continuation are separate features.

The Stop response contains a fixed instruction to check the caller's work state.
It does not copy the objective, next action, or peer text into a user prompt.
The hook does not start a broker during Stop or Interrupt.
An unavailable broker, state error, or older broker response permits stopping.
User stops and execution limits take priority.

## Storage and verification limits

The broker stores summaries in `work-state-v1.json` in the message directory.
It keeps this optional file separate from the message journal.
The store accepts at most 128 session records and one MiB of serialized data.
It refuses a write beyond these limits instead of removing another session's record.
Corrupt optional state disables this feature without disabling message delivery.
Do not edit or delete live broker files.

The same operating-system account can read these local files.
Tool results can enter model context and reach the configured model provider.
See [security and privacy](../SECURITY.md).
Protocol tests and model evaluations measure different behavior.
See [verification](VERIFICATION.md) for executed checks and their limits.
