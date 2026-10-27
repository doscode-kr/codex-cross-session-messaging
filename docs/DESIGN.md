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
The `chain launch` command is disabled because the shared daemon cannot receive its child-only ticket.

## Session chaining

[Session chaining](CHAINING.md) keeps a separate local store beside the message journal.
Its MCP tools use the same caller metadata and live-session checks as message tools.
Local CLI and hook processes use the same exclusive storage lock.
Bindings use complete lowercase UUIDs and pin an immutable source checkpoint.
The checkpoint copies the validated work-state report without changing its owner or continuation policy.
Automatic transcript and Git records stay separate from that report.
All restored content is untrusted data within the current user's scope.

A launch ticket has one owner and a ten-minute first-use limit.
The stored index contains only its hash.
Ticket storage and claims are implemented, but the CLI transport remains unsupported.
Unlink compares the expected chain and checkpoint before saving a tombstone.
Relink requires that tombstone's exact ID.
Optional chaining errors do not disable message delivery.

## Immediate delivery

A busy recipient receives `turn/steer` with the expected current turn ID.
An idle recipient receives `turn/start`.
The implementation reads the recipient state before delivery.
It retries once only for specific explicit rejections before input acceptance.
It does not retry a timeout.
It does not use a queue or interrupt after a failed delivery.
It does not override the recipient model or permissions.

The peer body is `untrusted` additional context.
The turn input contains the message ID and handling instructions.
The input also provides a short display label for Codex clients that show text placeholders.
The complete notice remains in the model input.
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
