'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchPortalAuthorization } = require('../lib/portal-authorization');

test('TimeClock revalidates authorization directly over the LAN with its API key', async () => {
  let called;
  const result = await fetchPortalAuthorization({
    directoryUrl: 'http://192.168.10.26:3000/api/internal/timeclock/directory',
    apiKey: 'test-timeclock-directory-key-at-least-32-characters',
    portalUserId: '42',
    fetchImpl: async (url, options) => {
      called = { url: String(url), options };
      if (!called.url.startsWith('http://192.168.10.26:3000/')) throw new Error('External DNS unavailable');
      return { ok: true, json: async () => ({ portal_user_id: '42', timeclock_access: true }) };
    }
  });
  assert.equal(result.timeclock_access, true);
  assert.equal(called.url, 'http://192.168.10.26:3000/api/internal/timeclock/authorization/42');
  assert.equal(called.options.headers['x-internal-api-key'], 'test-timeclock-directory-key-at-least-32-characters');
});
