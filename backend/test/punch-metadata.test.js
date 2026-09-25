'use strict';
const assert=require('assert');
const {getRequestIp,normalizeLocation,normalizeClientSource,punchLocationGate}=require('../lib/punch-metadata');
(async()=>{
assert.strictEqual(getRequestIp({headers:{'cf-connecting-ip':'203.0.113.8'},socket:{remoteAddress:'172.18.0.2'}}),'203.0.113.8');
assert.strictEqual(getRequestIp({headers:{'x-forwarded-for':'198.51.100.4, 172.18.0.3'},socket:{remoteAddress:'172.18.0.2'}}),'198.51.100.4');
assert.strictEqual(getRequestIp({headers:{},socket:{remoteAddress:'::ffff:192.0.2.5'}}),'192.0.2.5');
assert.deepStrictEqual(normalizeLocation({location_status:'captured',latitude:33.77,longitude:-81.93,accuracy_meters:8.5}),{location_status:'captured',latitude:33.77,longitude:-81.93,accuracy_meters:8.5});
assert.deepStrictEqual(normalizeLocation({location_status:'captured',latitude:999,longitude:-81.93,accuracy_meters:8.5}),{location_status:'error',latitude:null,longitude:null,accuracy_meters:null});
assert.deepStrictEqual(normalizeLocation({location_status:'denied'}),{location_status:'denied',latitude:null,longitude:null,accuracy_meters:null});
assert.strictEqual(normalizeClientSource('mobile_pwa'),'mobile_pwa');
assert.strictEqual(normalizeClientSource('bad source!'),'web');
assert.strictEqual((await punchLocationGate({headers:{'cf-connecting-ip':'64.139.245.9'},body:{location_status:'denied'}})).allowed,true);
assert.strictEqual((await punchLocationGate({headers:{'cf-connecting-ip':'192.0.2.25'},body:{location_status:'denied'}})).allowed,false);
assert.strictEqual((await punchLocationGate({headers:{'cf-connecting-ip':'192.0.2.25'},body:{location_status:'captured',latitude:33.77,longitude:-81.93,accuracy_meters:12}})).allowed,true);
const pool={query:async()=>({rows:[{value:JSON.stringify([{name:'Test network',ip:'203.0.113.77'}])}]})};
assert.strictEqual((await punchLocationGate({headers:{'cf-connecting-ip':'203.0.113.77'},body:{location_status:'denied'}},pool)).allowed,true);
console.log('punch-metadata tests: PASS');
})().catch(err=>{console.error(err);process.exit(1)});
