'use strict';
const crypto=require('crypto');

function decodeBase64UrlJson(value){
  return JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
}

function verifyPortalToken(token,secret,{issuer,audience,clockTolerance=5,now=Math.floor(Date.now()/1000)}={}){
  if(!secret||secret.length<32) throw new Error('Portal SSO secret is not configured');
  const parts=String(token||'').split('.');
  if(parts.length!==3) throw new Error('Invalid portal token');
  const [encodedHeader,encodedPayload,encodedSignature]=parts;
  const header=decodeBase64UrlJson(encodedHeader);
  if(header.alg!=='HS256') throw new Error('Unsupported portal token algorithm');
  const signingInput=`${encodedHeader}.${encodedPayload}`;
  const expected=crypto.createHmac('sha256',secret).update(signingInput).digest();
  const actual=Buffer.from(encodedSignature,'base64url');
  if(actual.length!==expected.length||!crypto.timingSafeEqual(actual,expected)) throw new Error('Invalid portal token signature');
  const payload=decodeBase64UrlJson(encodedPayload);
  if(issuer&&payload.iss!==issuer) throw new Error('Invalid portal token issuer');
  if(audience&&payload.aud!==audience) throw new Error('Invalid portal token audience');
  if(!payload.exp||payload.exp<now-clockTolerance){const err=new Error('Portal token expired');err.name='TokenExpiredError';throw err;}
  if(payload.nbf&&payload.nbf>now+clockTolerance) throw new Error('Portal token is not active');
  return payload;
}

module.exports={decodeBase64UrlJson,verifyPortalToken};
