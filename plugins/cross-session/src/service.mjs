import { randomUUID } from 'node:crypto';
import { resolve, normalize } from 'node:path';
import { CrossSessionError, requireText, errorData } from './errors.mjs';
import { displayStatus } from './native.mjs';

const pendingDelivery = Symbol('pendingDelivery');

function sameFolder(a, b) {
  if (!a || !b) return false;
  const canonical = p => process.platform === 'win32' ? normalize(resolve(p)).toLowerCase() : normalize(resolve(p));
  return canonical(a) === canonical(b);
}
export class MessagingService {
  constructor(store, native) {
    this.store = store; this.native = native; this.live = new Map(); this.serial = Promise.resolve();
    this.deliveries = new Set();
    this.recipients = new Map();
    this.idleChecks = new Map();
    this.refreshing = null;
    this.refreshes = new Set();
    this.refreshGeneration = 0;
    this.liveGeneration = 0;
    this.stopping = false;
  }
  run(action) {
    const result = this.serial.then(action);
    this.serial = result.catch(() => {});
    return result;
  }
  refresh({ persistLeader = true } = {}) {
    this.requireRunning();
    if (!this.refreshing) {
      const generation = ++this.refreshGeneration;
      const collection = (async () => ({ generation, live: new Map((await this.native.list()).map(thread => [thread.id, thread])) }))();
      this.refreshing = collection;
      const finished = () => { if (this.refreshing === collection) this.refreshing = null; };
      collection.then(finished, finished);
    }
    const collection = this.refreshing;
    const refresh = (async () => {
      const { live, generation } = await collection;
      await this.run(() => {
        this.requireRunning();
        if (generation >= this.liveGeneration) { this.live = live; this.liveGeneration = generation; }
        if (persistLeader && this.store.leader && !this.live.has(this.store.leader)) this.store.record('leader', null);
      });
    })();
    this.refreshes.add(refresh);
    const finished = () => this.refreshes.delete(refresh);
    refresh.then(finished, finished);
    return refresh;
  }
  requireRunning() {
    if (this.stopping) throw new CrossSessionError('BROKER_STOPPING', 'The broker is stopping. No new request was accepted.');
  }
  async requestShutdown() {
    return this.run(() => {
      this.requireRunning();
      if (this.store.subscriptions.size && !this.store.failure) throw new CrossSessionError('SUBSCRIPTIONS_ACTIVE', 'Cancel idle subscriptions before stopping the broker.');
      if (this.deliveries.size) throw new CrossSessionError('DELIVERIES_ACTIVE', 'Wait for current message deliveries before stopping the broker.');
      this.stopping = true;
    });
  }
  identity(id) {
    requireText(id, 'session identity', 200);
    const thread = this.live.get(id);
    if (!thread) throw new CrossSessionError('SESSION_NOT_LIVE', 'The caller is not a loaded root session on the shared daemon. Never guess another session ID.');
    const registered = this.store.sessions.get(id);
    return { id, name: registered?.name || thread.name || id, cwd: thread.cwd, permissionMode: registered?.permissionMode ?? 'unknown', role: this.store.leader === id ? 'leader' : 'worker' };
  }
  target(to) {
    requireText(to, 'to', 200);
    if (to === 'leader') {
      if (!this.store.leader) throw new CrossSessionError('NO_LEADER', 'No session has claimed the global leader role.');
      return this.identity(this.store.leader);
    }
    if (this.live.has(to)) return this.identity(to);
    const matches = [...this.live.keys()].map(id => this.identity(id)).filter(peer => peer.name === to);
    if (matches.length !== 1) throw new CrossSessionError(matches.length ? 'AMBIGUOUS_RECIPIENT' : 'RECIPIENT_NOT_FOUND', 'Use an exact live session UUID or a unique registered name.');
    return matches[0];
  }
  async call(method, args = {}, sessionId) {
    await this.refresh({ persistLeader: method !== 'list_idle_notifications' });
    const result = await this.run(() => {
      this.requireRunning();
      if (method === 'doctor') return { scope: 'same-computer', transport: 'immediate-only', daemon: this.native.info, sessionCount: this.live.size, leader: this.store.leader };
      const caller = this.identity(sessionId);
      switch (method) {
        case 'list_agents': {
          const agents = [...this.live.values()].map(thread => ({ ...this.identity(thread.id), status: displayStatus(thread), activeFlags: thread.status?.activeFlags ?? [], pluginRegistered: this.store.sessions.has(thread.id), sameProject: sameFolder(this.store.sessions.get(thread.id)?.projectRoot ?? thread.cwd, this.store.sessions.get(caller.id)?.projectRoot ?? caller.cwd) }));
          agents.sort((a, b) => Number(b.sameProject) - Number(a.sameProject) || a.name.localeCompare(b.name));
          return { self: caller.id, leader: this.store.leader, agents };
        }
        case 'register_session': {
          const name = args.name === undefined ? undefined : requireText(args.name, 'name', 120);
          if (name === 'leader' || (name && [...this.live.keys()].some(id => id !== caller.id && this.identity(id).name === name))) throw new CrossSessionError('NAME_IN_USE', 'Choose a unique name other than leader.');
          const value = { id: caller.id, updatedAt: new Date().toISOString() };
          if (name) value.name = name;
          this.store.record('session', value);
          return this.identity(caller.id);
        }
        case 'claim_leader': {
          if (this.store.leader && this.store.leader !== caller.id) throw new CrossSessionError('LEADER_EXISTS', 'Only one session can be leader in this message environment.', { leader: this.store.leader });
          this.store.record('leader', caller.id);
          return { leader: caller.id };
        }
        case 'release_leader':
        case 'transfer_leader': {
          if (this.store.leader !== caller.id) throw new CrossSessionError('NOT_LEADER', 'Only the current leader can release or transfer the role.');
          const to = method === 'transfer_leader' ? this.target(args.to).id : null;
          this.store.record('leader', to);
          return { leader: to };
        }
        case 'send_message': {
          if (args.notify_when_idle !== undefined && typeof args.notify_when_idle !== 'boolean') throw new CrossSessionError('INVALID_ARGUMENT', 'notify_when_idle must be a boolean.');
          const recipient = this.target(args.to);
          let replyTo;
          if (args.reply_to !== undefined) {
            const original = this.store.messages.get(requireText(args.reply_to, 'reply_to', 200));
            if (!original || original.to.id !== caller.id || original.from.id !== recipient.id) throw new CrossSessionError('INVALID_REPLY', 'A reply must target the sender of a message addressed to this session.');
            replyTo = original.id;
          }
          return this.send(caller, recipient, requireText(args.message, 'message'), { replyTo, notifyIdle: args.notify_when_idle === true });
        }
        case 'reply': {
          const original = this.store.messages.get(requireText(args.message_id, 'message_id', 200));
          if (!original || original.to.id !== caller.id) throw new CrossSessionError('MESSAGE_NOT_FOUND', 'This message is not addressed to the caller.');
          return this.send(caller, this.target(original.from.id), requireText(args.message, 'message'), { replyTo: original.id });
        }
        case 'read_messages': {
          const limit = args.limit ?? 20;
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CrossSessionError('INVALID_ARGUMENT', 'limit must be an integer from 1 to 100.');
          const direction = args.direction ?? 'inbox';
          if (!['inbox', 'outbox', 'both'].includes(direction)) throw new CrossSessionError('INVALID_ARGUMENT', 'direction must be inbox, outbox, or both.');
          let before;
          if (args.before_message_id !== undefined) {
            before = requireText(args.before_message_id, 'before_message_id', 200);
            const anchor = this.store.messages.get(before);
            if (!anchor || ![anchor.from.id, anchor.to.id].includes(caller.id)) throw new CrossSessionError('MESSAGE_NOT_FOUND', 'This history cursor is not available to this session.');
          }
          const messages = [];
          for (const message of this.store.messages.values()) {
            if (message.id === before) break;
            if (((direction !== 'outbox' && message.to.id === caller.id) || (direction !== 'inbox' && message.from.id === caller.id)) &&
                (!args.unacknowledged_only || !message.acknowledgedAt)) {
              messages.push(message);
              if (messages.length > limit + 1) messages.shift();
            }
          }
          const hasOlder = messages.length > limit;
          if (hasOlder) messages.shift();
          return { messages, nextCursor: hasOlder ? messages[0].id : null };
        }
        case 'acknowledge': {
          const message = this.store.messages.get(requireText(args.message_id, 'message_id', 200));
          if (!message || message.to.id !== caller.id) throw new CrossSessionError('MESSAGE_NOT_FOUND', 'Only the recipient can acknowledge this message.');
          if (!message.acknowledgedAt) this.store.record('ack', { id: message.id, at: new Date().toISOString() });
          return { id: message.id, acknowledgedAt: message.acknowledgedAt, taskCompleted: false };
        }
        case 'get_message': {
          const message = this.store.messages.get(requireText(args.message_id, 'message_id', 200));
          if (!message || ![message.from.id, message.to.id].includes(caller.id)) throw new CrossSessionError('MESSAGE_NOT_FOUND', 'Only the sender and recipient can read this message.');
          return message;
        }
        case 'notify_when_idle': {
          const recipient = this.target(args.to);
          if (recipient.id === caller.id) throw new CrossSessionError('SELF_MESSAGE', 'Select another session.');
          const id = randomUUID();
          this.store.record('subscription', { id, from: caller.id, to: recipient.id, sawActive: this.live.get(recipient.id).status.type === 'active' });
          return { subscriptionId: id, to: recipient.id, event: 'next-idle', oneShot: true };
        }
        case 'list_idle_notifications': {
          const limit = args.limit ?? 20;
          if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CrossSessionError('INVALID_ARGUMENT', 'limit must be an integer from 1 to 100.');
          const after = args.after_subscription_id === undefined ? undefined : requireText(args.after_subscription_id, 'after_subscription_id', 200);
          const selected = [];
          for (const sub of this.store.subscriptions.values()) {
            if (sub.from !== caller.id || (after !== undefined && sub.id <= after)) continue;
            let index = selected.findIndex(other => sub.id < other.id);
            if (index < 0) index = selected.length;
            if (selected.length === limit + 1) {
              if (index === selected.length) continue;
              selected.pop();
            }
            selected.splice(index, 0, sub);
          }
          const hasMore = selected.length > limit;
          if (hasMore) selected.pop();
          return {
            subscriptions: selected.map(sub => ({ subscriptionId: sub.id, to: sub.to, ...(sub.messageId ? { messageId: sub.messageId } : {}), event: 'next-idle', oneShot: true })),
            nextCursor: hasMore ? selected.at(-1).id : null
          };
        }
        case 'cancel_idle_notification': {
          const id = requireText(args.subscription_id, 'subscription_id', 200);
          const sub = this.store.subscriptions.get(id);
          if (!sub || sub.from !== caller.id) throw new CrossSessionError('SUBSCRIPTION_NOT_FOUND', 'Only the subscribing session can cancel this subscription.');
          this.store.record('subscription_done', id);
          return { cancelled: id };
        }
        default: throw new CrossSessionError('UNKNOWN_TOOL', `Unknown tool: ${method}`);
      }
    });
    return result?.[pendingDelivery] ?? result;
  }
  send(from, to, text, { replyTo, notifyIdle = false, kind = 'message' } = {}) {
    if (from.id === to.id) throw new CrossSessionError('SELF_MESSAGE', 'Select another session.');
    const message = { id: randomUUID(), kind, from, to, text, createdAt: new Date().toISOString(), status: 'sending', ...(replyTo ? { replyTo } : {}) };
    this.store.record('message', message);
    // Keep each recipient's submissions in order without blocking other peers.
    // This only waits for a native reply, never for the recipient's turn to end.
    const previous = this.recipients.get(to.id) ?? Promise.resolve();
    const delivery = previous.catch(() => {}).then(() => this.deliver(message, notifyIdle));
    this.recipients.set(to.id, delivery);
    this.deliveries.add(delivery);
    const finished = () => {
      this.deliveries.delete(delivery);
      if (this.recipients.get(to.id) === delivery) this.recipients.delete(to.id);
    };
    delivery.then(finished, finished);
    return { [pendingDelivery]: delivery };
  }
  async deliver(message, notifyIdle) {
    let submitted = false, nativeAccepted = false, acceptedSaved = false, delivery, subscriptionId;
    try {
      await this.run(() => {
        if (this.store.failure) throw new CrossSessionError('STORE_UNAVAILABLE', 'The message journal had a read or write failure. Stop the broker and check storage before restarting.');
      });
      submitted = true;
      delivery = await this.native.deliver(message);
      nativeAccepted = true;
      return await this.run(() => {
        this.store.record('delivery', { id: message.id, status: 'accepted', delivery });
        acceptedSaved = true;
        if (notifyIdle) {
          subscriptionId = randomUUID();
          this.store.record('subscription', { id: subscriptionId, from: message.from.id, to: message.to.id, sawActive: true, messageId: message.id, turnId: delivery.turnId });
        }
        return { messageId: message.id, status: 'accepted', delivery, acknowledged: Boolean(message.acknowledgedAt), taskCompleted: false, ...(notifyIdle ? { subscriptionId } : {}) };
      });
    } catch (error) {
      return this.run(() => {
        const storageCode = value => ({ code: value.code ?? 'INTERNAL_ERROR' });
        if (acceptedSaved) throw new CrossSessionError('IDLE_SUBSCRIPTION_UNCERTAIN', 'Codex accepted the message. The broker could not confirm the idle notification subscription. Check the saved message and subscriptions after storage recovery. Do not resend the message.', {
          messageId: message.id, status: 'accepted', delivery, subscriptionId, acknowledged: Boolean(message.acknowledgedAt), taskCompleted: false,
          requestOutcome: 'accepted', idleNotificationOutcome: 'unknown', storageError: storageCode(this.store.failure ?? error), queued: false
        });
        const uncertain = submitted && (nativeAccepted || !['NATIVE_REJECTED', 'RECIPIENT_UNAVAILABLE', 'ACTIVE_TURN_NOT_FOUND', 'DAEMON_REQUIRED', 'CODEX_NOT_FOUND'].includes(error.code));
        let storageError = this.store.failure;
        if (!storageError && (nativeAccepted || !submitted)) storageError = error;
        if (!storageError && this.store.closed) storageError = { code: 'STORE_CLOSED' };
        if (submitted && !storageError) {
          try { this.store.record('delivery', { id: message.id, status: uncertain ? 'uncertain' : 'failed', error: errorData(error) }); }
          catch (failure) { storageError = failure; }
        }
        const code = !submitted ? 'STORE_UNAVAILABLE' : uncertain ? 'DELIVERY_UNCERTAIN' : 'DELIVERY_FAILED';
        const journalError = error === this.store.failure;
        const text = nativeAccepted ? 'Codex accepted the input, but the broker could not save the delivery result. Check message history after storage recovery. Do not resend automatically.' :
          journalError ? 'The message journal failed during delivery. Check message history after storage recovery. Do not resend automatically.' : error.message;
        throw new CrossSessionError(code, text, {
          messageId: message.id, requestOutcome: !submitted ? 'not_submitted' : uncertain ? 'unknown' : 'rejected', queued: false,
          ...(nativeAccepted ? { delivery } : journalError ? {} : { nativeError: errorData(error) }), ...(storageError ? { storageError: storageCode(storageError) } : {})
        });
      });
    }
  }
  async drain() {
    do {
      await this.serial;
      await Promise.allSettled(this.refreshing ? [this.refreshing] : []);
      await Promise.allSettled([...this.refreshes]);
      await Promise.allSettled([...this.idleChecks.values()]);
      await Promise.allSettled([...this.deliveries]);
    } while (this.refreshing || this.refreshes.size || this.idleChecks.size || this.deliveries.size);
  }
  async hook(input, projectRoot) {
    this.requireRunning();
    if (input.agent_id) return {}; // Parent IDs in subagent hooks must not impersonate the root.
    await this.refresh();
    return this.run(() => {
      this.requireRunning();
      const id = input.session_id;
      this.identity(id);
      this.store.record('session', { id, permissionMode: input.permission_mode ?? this.store.sessions.get(id)?.permissionMode ?? 'unknown', ...(projectRoot ? { projectRoot } : {}), updatedAt: new Date().toISOString() });
      if (input.hook_event_name === 'SessionEnd' && this.store.leader === id) this.store.record('leader', null);
      return { sessionId: id, leader: this.store.leader };
    });
  }
  async tick() {
    if (this.stopping || (!this.store.subscriptions.size && !this.store.leader)) return;
    await this.refresh();
    const checks = await this.run(() => {
      const checks = [];
      if (this.stopping) return checks;
      for (const sub of [...this.store.subscriptions.values()]) {
        const target = this.live.get(sub.to);
        if (!target || !this.live.has(sub.from)) { this.store.record('subscription_done', sub.id); continue; }
        if (target.status.type === 'active' && !sub.sawActive) this.store.record('subscription', { ...sub, sawActive: true });
        if (target.status.type === 'idle' && sub.sawActive) {
          let check = this.idleChecks.get(sub.id);
          if (!check) {
            check = this.checkIdle(sub);
            this.idleChecks.set(sub.id, check);
            const finished = () => { if (this.idleChecks.get(sub.id) === check) this.idleChecks.delete(sub.id); };
            check.then(finished, finished);
          }
          checks.push(check);
        }
      }
      return checks;
    });
    await Promise.all(checks);
  }
  async checkIdle(sub) {
    // A turn history query must not hold the state writer or block cancellation.
    if (sub.turnId && !await this.native.turnFinished(sub.to, sub.turnId)) return;
    if (this.stopping || this.store.subscriptions.get(sub.id) !== sub) return;
    const latest = new Map((await this.native.list()).map(thread => [thread.id, thread]));
    const notification = await this.run(() => {
      if (this.stopping || this.store.subscriptions.get(sub.id) !== sub) return;
      if (latest.get(sub.to)?.status.type !== 'idle' || !latest.has(sub.from)) return;
      if (this.live.get(sub.to)?.status.type !== 'idle' || !this.live.has(sub.from)) return;
      // Consume before delivery: one shot, even if delivery is uncertain.
      this.store.record('subscription_done', sub.id);
      return this.send(this.identity(sub.to), this.identity(sub.from), `Session ${sub.to} is idle. This is a status hint, not proof of task completion. Subscription: ${sub.id}`, { kind: 'idle-notification' });
    });
    await notification?.[pendingDelivery];
  }
}
