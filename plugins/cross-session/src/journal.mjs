import { fstatSync, readSync } from 'node:fs';
import { CrossSessionError } from './errors.mjs';

const chunkSize = 64 * 1024;

function readFailure() {
  return new CrossSessionError('STORE_READ_FAILED', 'The message journal could not be read completely.');
}

export function replayJournal(fd, apply) {
  const size = fstatSync(fd).size;
  const buffer = Buffer.allocUnsafe(chunkSize);
  let position = 0, lineStart = 0, fragments = [], fragmentBytes = 0;
  while (position < size) {
    const length = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
    if (!length) throw readFailure();
    let start = 0;
    while (start < length) {
      const newline = buffer.indexOf(10, start);
      if (newline < 0 || newline >= length) break;
      const fragment = buffer.subarray(start, newline);
      const line = fragments.length ? Buffer.concat([...fragments, fragment], fragmentBytes + fragment.length) : fragment;
      if (line.length) apply(JSON.parse(line.toString('utf8')), { offset: lineStart, length: position + newline - lineStart });
      start = newline + 1;
      lineStart = position + start;
      fragments = [];
      fragmentBytes = 0;
    }
    if (start < length) {
      const fragment = Buffer.from(buffer.subarray(start, length));
      fragments.push(fragment);
      fragmentBytes += fragment.length;
    }
    position += length;
  }
  // The caller repairs a torn tail only after every complete event was checked.
  return { end: lineStart, size };
}

export function readJournalEvent(fd, { offset, length }) {
  const buffer = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, offset + read);
    if (!count) throw readFailure();
    read += count;
  }
  return JSON.parse(buffer.toString('utf8'));
}

export function setJournalText(message, reader, location) {
  // Capture only the reader and byte location. Do not retain or cache the body.
  Object.defineProperty(message, 'text', {
    enumerable: true, configurable: true,
    get() { return reader(location).value.text; }
  });
}
