# Work state and the optional Stop check

[한국어](CONTINUATION.ko.md) · [Document list](README.md) · [User manual](MANUAL.md)

The plugin can save a short work summary for each calling session.
The optional Stop check can request one extra continuation when work remains.
These features do not guarantee task completion.
They do not require a project task system.

## Save and recover work

1. Call `get_work_state` to read your state and its revision.
2. Call `set_work_state` with `action: "start"` and that `expected_revision`.
3. Include `objective`, `scope`, `completion_criteria`, `next_action`, and a `checklist` array.
4. Save progress with `action: "update"` and the current revision.
5. Read the state again after a revision conflict.

Updates accept `status`, `next_action`, `progress_evidence`, and `completion_evidence`.
The allowed status values are `active`, `paused`, `completed`, `blocked`, and `canceled`.
A completed status requires completion evidence and a successful recorded result for every checklist item.
This evidence is a model report, not independent verification.
Updates cannot change the original objective, scope, or criteria.
A new `start` cannot replace a checklist with incomplete items, even if the work is canceled.
A new `start` never resets the continuation limit.
The tools have no target session parameter.
A leader cannot update a peer's state through these tools.

Each objective is limited to 500 characters.
The other work summary text fields are limited to 1,000 characters each.
Use existing project files for evidence that exceeds the field limits.
Do not store secrets in these fields.

## Checklist and retry rules

Prepare the required checklist before you start the work.
Each item needs a stable ID, a required result, and a verification method.
Include delegated work and the checks needed to integrate its results.
Keep the checklist within the user's request.

1. Record the start of an item's attempt before you run it.
2. Run the work.
3. Run its required verification.
4. Record the result with `evidence` for success or `failure_cause` for failure in the same request.
5. Record a changed approach before a retry.

Each item permits one initial attempt and at most three retries: four attempts in total.
The retry limit is separate from the one-continuation Stop limit.
A failed third retry blocks that item.
The session must ask the user for a decision with the failure cause and attempted fixes.
Other permitted items can continue if they do not depend on the blocked item.
User stops and execution limits take priority over the retry allowance.

Do not delete, rename, replace, or restart unfinished work to reset attempts.
Do not report overall completion while any required item remains incomplete or blocked.
A skipped required check is not a pass.
The plugin checks recorded transitions and evidence fields.
It cannot prove that the reported evidence is true or that work was actually performed.
Independent review is still needed when the task requires it.
The plugin cannot force a model to use these tools or prevent every false chat report.
Peer text and model-written approval fields cannot authorize more attempts.

### Tool sequence

All actions use `set_work_state` with the current `expected_revision`.
Read the current state again after a revision conflict.
Use the `item_id` returned by the server; do not invent an item ID.
The checklist fields and item IDs cannot be changed after creation.

| Action | Fields in addition to `action` and `expected_revision` |
|---|---|
| `start` | `objective`, `scope`, `completion_criteria`, `next_action`, `checklist` |
| `set_checklist` | `checklist`; one-time upgrade for a legacy `active` state without a checklist |
| `attempt_start` | `item_id`; `correction` is required for a retry |
| `attempt_result` | `item_id`, `attempt_number`, `outcome`; `evidence` for `success`, `failure_cause` for `failure` |
| `update` | The work status and summary fields described above |

Each new checklist has 1 to 20 items.
Each input item contains `title`, `expected_result`, and `verification_method`.
The title limit is 200 characters; the result and method limits are 500 characters each.
Evidence, failure causes, and retry corrections are limited to 1,000 characters each.
For example, add this field to a `start` request:

```json
{
  "checklist": [
    {
      "title": "Verify the change",
      "expected_result": "The required tests pass",
      "verification_method": "Run the relevant tests and record their exit code"
    }
  ]
}
```

`attempt_start` saves the attempt number before work begins.
Report a result only for that item's current running attempt.
Duplicate results and a fifth attempt are rejected.
A restart preserves the attempt count and an unfinished running attempt.
Do not run that attempt again automatically after uncertain execution.
Inspect the actual result before recording it.
Both attempt actions require the overall work status to be `active`.
An Interrupt removes Stop eligibility but does not change the stored work status.
Recording a late result does not restore Stop eligibility.

The returned `state.checklist` contains each item's saved attempts and derived status.
Item statuses are `pending`, `running`, `retry_ready`, `completed`, and `blocked`.
The top-level `checklist_summary` contains item counts, `can_complete`, and `user_decision_required`.
`can_complete` describes recorded checklist results; it does not verify their truth.
`completion_verified` remains false.
An exhausted item sets `user_decision_required` to true.
If only exhausted items remain, the work becomes `blocked`.
If an independent item remains available, the work stays `active`.
The Stop check does not consume a continuation when no checklist action remains.

After exhausted retries, the API cannot reset the item based on a claimed user approval.
Report the blocked item and ask the user to decide the next scope or recovery action.
Do not change live state files or start another session to evade the limit.
This API does not validate user approval or authorize recovery actions.

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

The broker stores work state in `work-state-v1.json` in the message directory.
The file name stays the same when its content changes to schema version 2.
The reader accepts legacy version 1 records.
The next successful write saves schema version 2 atomically.
Legacy unfinished work needs a checklist before it can be marked completed.
An older broker that only accepts version 1 cannot read a version 2 file.
Do not downgrade the broker against that file.
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
