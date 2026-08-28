'use strict';

const assert = require('assert');
const { createMobilePairingStore } = require('../lib/mobile-pairing');

let clock = 1000;
const store = createMobilePairingStore({
  ttlMs: 300000,
  maxAttempts: 3,
  attemptWindowMs: 600000,
  now: () => clock,
});

const issued = store.issue({ employee_id: 2, permissions: ['access'], app_admin_scope: 'own', auth_source: 'portal' });
assert.match(issued.code, /^\d{6}$/);
assert.strictEqual(store.size(), 1);

const redeemed = store.redeem(issued.code, 'ip-a');
assert.strictEqual(redeemed.employee_id, 2);
assert.deepStrictEqual(redeemed.permissions, ['access']);
assert.strictEqual(store.size(), 0);
assert.throws(() => store.redeem(issued.code, 'ip-a'), /invalid or has expired/i);

const first = store.issue({ employee_id: 3, permissions: ['access'] });
const second = store.issue({ employee_id: 3, permissions: ['access'] });
assert.notStrictEqual(first.code, second.code);
assert.throws(() => store.redeem(first.code, 'ip-b'), /invalid or has expired/i);
assert.strictEqual(store.redeem(second.code, 'ip-c').employee_id, 3);

const expiring = store.issue({ employee_id: 4, permissions: ['access'] });
clock += 300001;
assert.throws(() => store.redeem(expiring.code, 'ip-d'), /invalid or has expired/i);

for (let i = 0; i < 3; i += 1) {
  assert.throws(() => store.redeem('000000', 'ip-rate'), /invalid or has expired/i);
}
assert.throws(() => store.redeem('000000', 'ip-rate'), /too many incorrect code attempts/i);

console.log('mobile pairing tests: PASS');
