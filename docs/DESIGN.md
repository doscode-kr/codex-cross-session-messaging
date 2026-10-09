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
The plugin does not start a separate model executor.

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

The broker serializes leader changes and message records.
Broker state checks and journal changes use the same serial operation path.
Waiting for a Codex delivery response does not occupy that path.
Submissions to the same recipient stay in order until each Codex response arrives.
A slow delivery response for one recipient does not block delivery to another recipient.
The broker waits for the delivery response, not for the recipient's turn to finish.
An accepted delivery can still need a later result reply.
It permits one leader per message environment.
Only the current leader can release or transfer the role.
The normal default environment is shared across projects for the same Codex user settings.

Each journal append is synchronized to disk.
On startup, the store truncates an incomplete final line.
An interrupted send without a saved delivery result becomes `uncertain`.
The journal is a record, not a future delivery queue.

Broker shutdown also uses the serial operation path.
Outstanding idle notification subscriptions prevent shutdown with `SUBSCRIPTIONS_ACTIVE`.
Delivery responses still in progress prevent shutdown with `DELIVERIES_ACTIVE`.
Once shutdown is accepted, the broker rejects new requests with `BROKER_STOPPING`.
These checks protect delivery records before the broker closes its journal.

## Idle notifications

The broker checks subscribed sessions approximately once per second.
It sends one notification after an observed active-to-idle transition.
A notification attached to a send also checks the delivered turn's end state.
That check avoids treating the previous idle state as completion of a new turn.
The broker consumes the subscription before notification delivery.
It does not resend an uncertain notification automatically.
A subscription made while the target is idle waits for a later active-to-idle transition.
An idle notification is not task completion evidence.

## Data boundary

The broker stores message bodies and session metadata locally.
Codex can send peer context to its configured model provider.
Local storage does not establish that message content remains on the computer.
See [SECURITY.md](../SECURITY.md) for privacy limits.
