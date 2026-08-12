'use strict';
const crypto=require('crypto');
const {unique}=require('./permissions');

function createSessionStore({ttlMs}){
  const sessions=new Map();
  function generateToken(){return crypto.randomBytes(32).toString('hex');}
  function create(employeeId,permissions,options={}){
    const token=generateToken();
    sessions.set(token,{employee_id:employeeId,permissions:unique(permissions),app_admin_scope:options.app_admin_scope==='all'?'all':'own',auth_source:options.auth_source||'legacy',expires_at:Date.now()+ttlMs});
    return token;
  }
  function get(token){return token?sessions.get(token)||null:null;}
  function destroy(token){return token?sessions.delete(token):false;}
  function getActive(token,now=Date.now()){
    const session=get(token);
    if(!session) return null;
    if(session.expires_at<=now){destroy(token);return null;}
    return session;
  }
  return {create,get,getActive,destroy,size:()=>sessions.size};
}

function getBearerToken(req){
  const authHeader=req?.headers?.authorization||'';
  return authHeader.startsWith('Bearer ')?authHeader.substring(7):null;
}

module.exports={createSessionStore,getBearerToken};
