export class CrossSessionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
export function requireText(value, name, max = 16000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new CrossSessionError('INVALID_ARGUMENT', `${name} must be a nonempty string of at most ${max} characters.`);
  }
  return value;
}
export function errorData(error) {
  return { code: error.code ?? 'INTERNAL_ERROR', message: error.message, ...error.details };
}
