import { test } from 'node:test';
import assert from 'node:assert/strict';

const expected = [{ key: 'base64-client-key', userId: 'client-app', tier: 'standard' }];
process.env.USERS_JSON = '';
process.env.USERS_JSON_BASE64 = Buffer.from(JSON.stringify(expected), 'utf8').toString('base64');

const { config } = await import('../src/config.mjs');

test('USERS_JSON_BASE64 supports JSON caller directories in secret managers', () => {
  assert.deepEqual(config.users, expected);
});
