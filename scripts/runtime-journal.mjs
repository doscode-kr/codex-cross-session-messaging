import { openSync, closeSync } from 'node:fs';
import { replayJournal } from '../plugins/cross-session/src/journal.mjs';

const types = new Set(['session', 'leader', 'message', 'delivery', 'ack', 'subscription', 'subscription_done']);
const failure = () => new Error('The runtime journal could not be validated. Keep the runtime files and inspect storage before removal.');

export function validateRuntimeJournal(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
    // Validation never truncates a torn tail or changes journal events.
    replayJournal(fd, event => {
      if (!event || !types.has(event.type)) throw failure();
    });
  } catch { throw failure(); }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { throw failure(); }
    }
  }
}
