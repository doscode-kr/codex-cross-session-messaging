import { CrossSessionError } from './errors.mjs';

const flags = new Set(['notify_when_idle', 'unacknowledged_only', 'detail']);

export function parseCliArgs(tokens, sessionId) {
  const args = Object.create(null);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('--') || token === '--') throw new CrossSessionError('INVALID_ARGUMENT', 'Each argument must be a named option that starts with --.');
    const separator = token.indexOf('=');
    const option = separator < 0 ? token : token.slice(0, separator);
    const key = option.slice(2).replaceAll('-', '_');
    let value;
    if (flags.has(key)) {
      if (separator < 0) value = true;
      else {
        const text = token.slice(separator + 1);
        if (!['true', 'false'].includes(text)) throw new CrossSessionError('INVALID_ARGUMENT', `${option} must be true or false.`);
        value = text === 'true';
      }
    } else {
      value = separator < 0 ? tokens[i + 1] : token.slice(separator + 1);
      if (value === undefined || value === '' || (separator < 0 && value.startsWith('--'))) throw new CrossSessionError('INVALID_ARGUMENT', `${option} requires a value. Use ${option}=VALUE for a value that starts with --.`);
      if (separator < 0) i++;
    }
    if (key === 'session') sessionId = value;
    else args[key] = ['limit', 'expected_revision'].includes(key) ? Number(value) : value;
  }
  return { args, sessionId };
}
