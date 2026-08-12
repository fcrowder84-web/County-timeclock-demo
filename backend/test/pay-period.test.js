'use strict';
const assert=require('assert');
const {formatDateOnly,resolvePayPeriod,shiftDate}=require('../lib/pay-period');

assert.strictEqual(formatDateOnly('2026-08-12'),'2026-08-12');
assert.strictEqual(shiftDate('2026-08-12',1),'2026-08-13');
assert.strictEqual(shiftDate('2026-08-01',-1),'2026-07-31');

const current=resolvePayPeriod({anchorDate:'2026-07-27',periodDays:14,targetDate:'2026-08-12'});
assert.deepStrictEqual(current,{pay_period_start:'2026-08-10',pay_period_end:'2026-08-23',period_days:14});
const previous=resolvePayPeriod({anchorDate:'2026-07-27',periodDays:14,targetDate:'2026-08-09'});
assert.deepStrictEqual(previous,{pay_period_start:'2026-07-27',pay_period_end:'2026-08-09',period_days:14});
const explicit=resolvePayPeriod({anchorDate:'2026-07-27',periodDays:14,targetDate:'2026-08-12',requestedStart:'2026-08-10'});
assert.strictEqual(explicit.pay_period_end,'2026-08-23');
assert.throws(()=>resolvePayPeriod({anchorDate:'2026-07-27',periodDays:14,targetDate:'2026-08-12',requestedStart:'2026-08-11'}),/configured schedule/);
assert.throws(()=>resolvePayPeriod({anchorDate:'bad',periodDays:14,targetDate:'2026-08-12'}),/Invalid pay period/);
console.log('pay-period tests: PASS');
