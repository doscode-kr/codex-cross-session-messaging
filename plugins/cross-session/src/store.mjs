import { openSync, closeSync, readFileSync, writeSync, fsyncSync, ftruncateSync, constants } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(root) {
    this.sessions = new Map();
    this.messages = new Map();
    this.subscriptions = new Map();
    this.leader = null;
    this.path = join(root, 'events.jsonl');
    this.fd = openSync(this.path, constants.O_RDWR | constants.O_CREAT, 0o600);
    const raw = readFileSync(this.path);
    // A crashed append can leave one incomplete final line. Retain all complete events.
    const end = raw.lastIndexOf(10) + 1;
    this.offset = end;
    if (end < raw.length) ftruncateSync(this.fd, end);
    for (const line of raw.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) this.apply(JSON.parse(line));
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
    const event = { type, value, at: new Date().toISOString() };
    const bytes = Buffer.from(JSON.stringify(event) + '\n');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset, bytes.length - offset, this.offset + offset);
    fsyncSync(this.fd);
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
