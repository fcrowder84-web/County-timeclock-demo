'use strict';
const assert=require('assert');
const crypto=require('crypto');
const {verifyPortalToken}=require('../lib/portal-token');
const {createSessionStore,getBearerToken}=require('../lib/session-store');
const {effectiveEmployeePermissions}=require('../routes/auth');

function sign(payload,secret){
  const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig=crypto.createHmac('sha256',secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

const secret='x'.repeat(40);
const now=2000000000;
const token=sign({iss:'portal',aud:'timeclock',sub:'123',exp:now+60},secret);
const payload=verifyPortalToken(token,secret,{issuer:'portal',audience:'timeclock',now});
assert.strictEqual(payload.sub,'123');
assert.throws(()=>verifyPortalToken(token,secret,{issuer:'wrong',audience:'timeclock',now}),/issuer/);
assert.throws(()=>verifyPortalToken(sign({iss:'portal',aud:'timeclock',exp:now-60},secret),secret,{issuer:'portal',audience:'timeclock',now}),/expired/);

const store=createSessionStore({ttlMs:1000});
const sessionToken=store.create(7,['access','access'],{auth_source:'portal',app_admin_scope:'all'});
assert.strictEqual(store.getActive(sessionToken,Date.now()).employee_id,7);
assert.deepStrictEqual(store.get(sessionToken).permissions,['access']);
assert.strictEqual(store.get(sessionToken).app_admin_scope,'all');
assert.strictEqual(store.getActive(sessionToken,Date.now()+2000),null);
assert.strictEqual(getBearerToken({headers:{authorization:'Bearer abc'}}),'abc');
assert.strictEqual(getBearerToken({headers:{}}),null);
const effective=effectiveEmployeePermissions(['access']);
assert(effective.includes('view_own_time'));
assert(effective.includes('request_punch_correction'));
console.log('auth primitive tests: PASS');
