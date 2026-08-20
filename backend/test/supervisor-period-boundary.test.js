'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { transform } = require('../scripts/fix-supervisor-period-boundary');

const file = path.resolve(__dirname, '..', 'routes', 'supervisor.js');
const source = fs.readFileSync(file, 'utf8');
const result = source.includes('const periodBoundary = await client.query(') ? source : transform(source);

assert(result.includes("$1::timestamp >= $2::date"));
assert(result.includes("$1::timestamp < ($3::date + INTERVAL '1 day')"));
assert(result.includes('[newClockIn, approval.pay_period_start, approval.pay_period_end]'));
assert(!result.includes('String(approval.pay_period_start).slice(0,10)'));
assert(!result.includes('String(approval.pay_period_end).slice(0,10)'));

console.log('supervisor period boundary tests: PASS');
