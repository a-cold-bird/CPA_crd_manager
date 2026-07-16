import assert from 'node:assert/strict';
import test from 'node:test';

import { isAuthorizedManagementKey } from './managementAuth.js';

test('management authentication fails closed for missing and placeholder keys', () => {
  assert.equal(isAuthorizedManagementKey('', ''), false);
  assert.equal(isAuthorizedManagementKey('CHANGE_ME', 'CHANGE_ME'), false);
  assert.equal(isAuthorizedManagementKey('CHANGE_ME_TO_A_STRONG_SECRET', 'CHANGE_ME_TO_A_STRONG_SECRET'), false);
});

test('management authentication accepts only the exact configured key', () => {
  assert.equal(isAuthorizedManagementKey('strong-local-key', 'strong-local-key'), true);
  assert.equal(isAuthorizedManagementKey('wrong-local-key!', 'strong-local-key'), false);
});
