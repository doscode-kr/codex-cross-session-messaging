# Design

[한국어](DESIGN.ko.md)

## Scope

The plugin connects independent Codex CLI sessions on one computer.
Windows and macOS use the same Node.js implementation.
The plugin does not require a project task system.

## Connection

The request path is:

`Codex session → MCP tool → local broker → byte proxy → shared Codex daemon → recipient session`

The broker also writes a local JSONL journal.
It reads the running daemon socket with `codex app-server daemon version`.
It connects to that socket through `codex app-server proxy`.
The `ws` dependency handles WebSocket framing over the byte proxy.
Message delivery does not start a separate model executor.

## Session chaining

[Session chaining](CHAINING.md) keeps each session's work across compaction.
It starts automatically after transcript UUID and project verification.
The store uses `session-continuity-v1` beside the message journal.
State and checkpoints contain the same session UUID and real project boundary.
Restore checks both values and never reads another session's checkpoint.
The first observed request, recent records, and structured work report stay separate.
Restored records are past data within the current user request and permissions.

PreCompact and Stop save current records. SessionEnd saves and marks the session closed.
SessionStart restores the same session's records and reads current AGENTS files separately.
Clear resets the context range and does not bring old work back.
Storage uses an exclusive lock, bounded records, and atomic replacement.
The old `chaining-v1` namespace remains untouched and is not a restore source.
Legacy link and launch calls fail before changing state.
Chaining errors do not disable message delivery.

## Immediate delivery

A busy recipient receives `turn/steer` with the expected current turn ID.
An idle recipient receives `turn/start`.
The implementation reads the recipient state before delivery.
It retries once only for specific explicit rejections before input acceptance.
It does not retry a timeout.
It does not use a queue or interrupt after a failed delivery.
It does not override the recipient model or permissions.

The peer body is `untrusted` additional context.
Its envelope contains the message ID and an explicit peer authority boundary.
Normal delivery does not add a second lookup notice.
An idle start uses an empty input array; a busy steer uses one empty text input.
The busy form can leave an empty user message in host history.
If the first RPC explicitly rejects these inputs or additional context before acceptance, the second RPC can contain an ID lookup notice only.
The recipient then reads the saved body through `get_message`.
The total limit remains two delivery RPCs, including an active-turn correction or notice fallback.
Timeouts and unknown errors do not use that fallback.
Target acceptance does not prove body display.
Sender permission information is descriptive.
It does not grant the recipient new permissions.

## Session identity

MCP calls use Codex session metadata for caller identity.
When that metadata is absent, the MCP process uses `CODEX_THREAD_ID`.
A call fails if neither provides an identity.
The plugin does not infer the caller from a recent session, working directory, or parent PID.
Recipients must be loaded independent root sessions in the shared daemon.
Subagent sessions are excluded.

The `SessionStart` hook records project and permission information.
Git worktrees use their common Git directory for project matching.
Messages to other projects are allowed.

## Broker and journal

Each message directory selects a broker instance and local port.
The broker binds the port before it opens the journal.
A concurrent broker that loses the port race must not write the journal.
The random token and directory instance identifier prevent accidental cross-instance requests.
The broker listens only on loopback.
Each client request closes its HTTP connection after the response.
The client does not reuse connections that the previous broker closed.
It adds connection work without retrying requests whose responses were lost.

The broker serializes leader changes and message records.
Broker state checks and journal changes use the same serial operation path.
Waiting for a Codex delivery response does not occupy that path.
Session list queries also run outside that path.
Concurrent requests share one pending daemon list query.
Each request applies its session state update through the serial operation path.
Normal requests can save removal of a leader that is no longer loaded.
`list_idle_notifications`, `get_work_state`, and `set_work_state` omit that leader journal update.
A later request queries the daemon again; the broker does not keep a timed status cache.
Calls still need a successful session list query to check the caller identity.
Submissions to the same recipient stay in order until each Codex response arrives.
A slow delivery response for one recipient does not block delivery to another recipient.
The broker waits for the delivery response, not for the recipient's turn to finish.
An accepted delivery can still need a later result reply.
It permits one leader per message environment.
Only the current leader can release or transfer the role.
The normal default environment is shared across projects for the same Codex user settings.

Each journal append is synchronized to disk.
Startup reads complete journal lines in chunks instead of loading the complete file.
The store keeps message metadata in memory and reads bodies from their journal locations when needed.
Message history keeps at most the requested number of matching messages before it reads their bodies.
Identical metadata updates do not append another event.
The store removes an incomplete final line only after it validates all preceding complete events.
Invalid complete events stop startup without changing the journal.
An interrupted send without a saved delivery result becomes `uncertain`.
The journal is a record, not a future delivery queue.
Original message data does not expire automatically.
An optional full UUID `request_id` becomes the new message ID for a send or reply.
The broker compares its stored caller, exact recipient, body, reply reference, and notification option before reusing a result.
It checks the existing ID before resolving a live recipient.
Concurrent duplicates share the pending delivery result.
Accepted, failed, and uncertain records do not submit another target input for that ID.
The host's `clientUserMessageId` alone does not prevent another turn.
The journal supplies this protection without suppressing message queries or explicit acknowledgments.
Disk space, metadata memory, and replay work still grow with stored data.
See [OPERATIONS.md](OPERATIONS.md) for storage behavior and recovery limits.

Broker shutdown also uses the serial operation path.
With a healthy journal, outstanding idle notification subscriptions prevent shutdown with `SUBSCRIPTIONS_ACTIVE`.
After a recorded journal read or write failure, an explicit stop preserves those subscriptions and permits shutdown.
Delivery responses still in progress prevent shutdown with `DELIVERIES_ACTIVE`.
Once shutdown is accepted, the broker rejects new requests with `BROKER_STOPPING`.
These checks protect delivery records before the broker closes its journal.
Resource closure waits for pending session queries and idle checks as well as deliveries.
If journal recovery fails during startup, the broker closes the journal and releases the listener.

## Work state

Optional work reports use a separate, bounded `work-state-v1.json` file.
Each update checks the caller's revision and atomically replaces that file.
New work requires fixed checklist items with server-generated IDs.
An attempt start saves its number before execution.
Each item permits one initial attempt and three retries.
The current running attempt accepts one result.
Unfinished items prevent replacement of the work and overall completion.
Version 1 files remain readable; successful writes use schema version 2 in the same file.
The API validates reported evidence fields, not their truth.
Continuation eligibility exists only in broker memory.
Restart restores summaries without restoring eligibility.
The Stop hook uses a fixed prompt and permits at most one extra continuation when enabled.
See [work state and Stop limits](CONTINUATION.md) for the full contract.

## Idle notifications

The broker checks subscribed sessions approximately once per second.
It sends one notification after an observed active-to-idle transition.
A notification attached to a send also checks the delivered turn's end state.
That check avoids treating the previous idle state as completion of a new turn.
Turn history queries run outside the serial state update path.
A slow history query does not block other messages or subscription cancellation.
Overlapping checks of one subscription share the pending query.
Before sending, the broker checks the current session state and the same subscription again.
Cancellation or shutdown prevents a late check from sending a notification.
The broker consumes the subscription before notification delivery.
It does not resend an uncertain notification automatically.
A subscription made while the target is idle waits for a later active-to-idle transition.
An idle notification is not task completion evidence.

## Data boundary

The broker stores message bodies and session metadata locally.
It also stores optional work summaries locally.
Codex can send peer context to its configured model provider.
Work-state tool results can also enter provider requests.
Local storage does not establish that message content remains on the computer.
See [SECURITY.md](../SECURITY.md) for privacy limits.
