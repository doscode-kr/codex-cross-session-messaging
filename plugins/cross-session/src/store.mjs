import { openSync, closeSync, writeSync, fsyncSync, ftruncateSync, constants } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CrossSessionError } from './errors.mjs';
import { replayJournal, readJournalEvent, setJournalText } from './journal.mjs';

export class Store {
  constructor(root) {
    this.sessions = new Map();
    this.messages = new Map();
    this.subscriptions = new Map();
    this.leader = null;
    this.failure = null;
    this.closed = false;
    this.reader = location => this.readEvent(location);
    this.path = join(root, 'events.jsonl');
    this.fd = openSync(this.path, constants.O_RDWR | constants.O_CREAT, 0o600);
    try {
      const { end, size } = replayJournal(this.fd, (event, location) => this.apply(event, location));
      this.offset = end;
      if (end < size) { ftruncateSync(this.fd, end); fsyncSync(this.fd); }
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }
  readEvent(location) {
    if (this.closed) throw new CrossSessionError('STORE_CLOSED', 'The message journal is closed.');
    try { return readJournalEvent(this.fd, location); }
    catch (error) { this.failure ??= error; throw error; }
  }
  apply(event, location) {
    switch (event.type) {
      case 'session': this.sessions.set(event.value.id, { ...this.sessions.get(event.value.id), ...event.value }); break;
      case 'leader': this.leader = event.value; break;
      case 'message':
        if (Object.hasOwn(event.value, 'text')) setJournalText(event.value, this.reader, location);
        this.messages.set(event.value.id, event.value);
        break;
      case 'delivery': {
        const message = this.messages.get(event.value.id);
        for (const [key, value] of Object.entries(event.value)) if (key !== 'text') message[key] = value;
        if (Object.hasOwn(event.value, 'text')) setJournalText(message, this.reader, location);
        break;
      }
      case 'ack': Object.assign(this.messages.get(event.value.id), { acknowledgedAt: event.value.at }); break;
      case 'subscription': this.subscriptions.set(event.value.id, event.value); break;
      case 'subscription_done': this.subscriptions.delete(event.value); break;
      default: throw new Error(`Unknown journal event: ${event.type}`);
    }
  }
  unchanged(type, value) {
    switch (type) {
      case 'leader': return this.leader === value;
      case 'session': {
        const previous = this.sessions.get(value.id);
        return previous !== undefined && isDeepStrictEqual(previous, { ...previous, ...value });
      }
      case 'subscription': return isDeepStrictEqual(this.subscriptions.get(value.id), value);
      case 'subscription_done': return !this.subscriptions.has(value);
      case 'ack': return this.messages.has(value.id) && this.messages.get(value.id).acknowledgedAt === value.at;
      case 'delivery': {
        const message = this.messages.get(value.id);
        // A body update is always written. Metadata comparisons must not read it.
        return message !== undefined && !Object.hasOwn(value, 'text') && Object.keys(value).every(key => isDeepStrictEqual(message[key], value[key]));
      }
      default: return false;
    }
  }
  record(type, value) {
    if (this.failure) throw new CrossSessionError('STORE_UNAVAILABLE', 'The message journal had a write failure. Stop the broker and check storage before restarting.');
    if (this.closed) throw new CrossSessionError('STORE_CLOSED', 'The message journal is closed.');
    if (this.unchanged(type, value)) return;
    const event = { type, value, at: new Date().toISOString() };
    const bytes = Buffer.from(JSON.stringify(event) + '\n');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(this.fd, bytes, offset, bytes.length - offset, this.offset + offset);
        if (written === 0) throw new CrossSessionError('STORE_WRITE_FAILED', 'The message journal write made no progress.');
        offset += written;
      }
      fsyncSync(this.fd);
    } catch (error) {
      // The file can contain a partial or complete event that was not applied.
      // Block later writes so they cannot overwrite that event at the old offset.
      this.failure = error;
      throw error;
    }
    const location = { offset: this.offset, length: bytes.length - 1 };
    this.offset += bytes.length;
    this.apply(event, location);
  }
  recover() {
    for (const message of this.messages.values()) {
      if (message.status === 'sending') this.record('delivery', { id: message.id, status: 'uncertain', error: { code: 'BROKER_RESTARTED', message: 'The broker stopped before saving the native result. Do not resend automatically.' } });
    }
  }
  close() { if (!this.closed) { closeSync(this.fd); this.closed = true; } }
}
