import crypto from 'crypto';

export function isAuthorizedManagementKey(providedValue, expectedValue) {
  if (typeof providedValue !== 'string') {
    return false;
  }
  const provided = providedValue.trim();
  const expected = String(expectedValue || '').trim();
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (!expected || /^change[_-]?me/i.test(expected) || providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
