import { openSync, closeSync, readFileSync, writeSync, fsyncSync, ftruncateSync, constants } from 'node:fs';
import { join } from 'node:path';
import { CrossSessionError } from './errors.mjs';

export class Store {
  constructor(root) {
    this.sessions = new Map();
    this.messages = new Map();
    this.subscriptions = new Map();
    this.leader = null;
    this.failure = null;
    this.path = join(root, 'events.jsonl');
    this.fd = openSync(this.path, constants.O_RDWR | constants.O_CREAT, 0o600);
    try {
      const raw = readFileSync(this.path);
      // A crashed append can leave one incomplete final line. Retain all complete events.
      const end = raw.lastIndexOf(10) + 1;
      this.offset = end;
      if (end < raw.length) ftruncateSync(this.fd, end);
      for (const line of raw.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) this.apply(JSON.parse(line));
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
  }
  apply(event) {
    switch (event.type) {
      case 'session': this.sessions.set(event.value.id, { ...this.sessions.get(event.value.id), ...event.value }); break;
      case 'leader': this.leader = event.value; break;
      case 'message': this.messages.set(event.value.id, event.value); break;
      case 'delivery': Object.assign(this.messages.get(event.value.id), event.value); break;
      case 'ack': Object.assign(this.messages.get(event.value.id), { acknowledgedAt: event.value.at }); break;
      case 'subscription': this.subscriptions.set(event.value.id, event.value); break;
      case 'subscription_done': this.subscriptions.delete(event.value); break;
      default: throw new Error(`Unknown journal event: ${event.type}`);
    }
  }
  record(type, value) {
    if (this.failure) throw new CrossSessionError('STORE_UNAVAILABLE', 'The message journal had a write failure. Stop the broker and check storage before restarting.');
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
    this.offset += bytes.length;
    this.apply(event);
  }
  recover() {
    for (const message of this.messages.values()) {
      if (message.status === 'sending') this.record('delivery', { id: message.id, status: 'uncertain', error: { code: 'BROKER_RESTARTED', message: 'The broker stopped before saving the native result. Do not resend automatically.' } });
    }
  }
  close() { closeSync(this.fd); }
}
