'use strict';
const express=require('express');
const {createMobilePairingStore}=require('../lib/mobile-pairing');

function effectiveEmployeePermissions(permissions){
  const list=[...(permissions||[])];
  if((list.includes('access')||list.includes('app_admin'))&&!list.includes('view_own_time')){
    list.push('view_own_time');
  }
  if(list.includes('view_own_time')&&!list.includes('request_punch_correction')){
    list.push('request_punch_correction');
  }
  return [...new Set(list)];
}

function requestAddress(req){
  const forwarded=String(req.headers?.['x-forwarded-for']||'').split(',')[0].trim();
  return forwarded||String(req.headers?.['x-real-ip']||req.ip||req.socket?.remoteAddress||'unknown');
}

function createAuthRouter({
  requireUser,
  sessionStore,
  getBearerToken,
  verifyPortalToken,
  portalIssuer,
  portalAudience,
  syncPortalUser,
  getUserById,
  audit,
}){
  const router=express.Router();
  const mobilePairing=createMobilePairingStore();

  router.post('/logout',requireUser,async(req,res)=>{
    const token=getBearerToken(req);
    if(token) sessionStore.destroy(token);
    res.json({message:'Logged out'});
  });

  router.get('/me',requireUser,async(req,res)=>{
    const safeUser={...req.user};
    delete safeUser.pin;
    const permissions=effectiveEmployeePermissions(req.user.permissions||[]);
    res.json({
      user:safeUser,
      permissions,
      app_admin_scope:req.user.app_admin_scope||'own',
      auth_source:req.user.auth_source||'legacy',
    });
  });

  router.post('/auth/mobile-code',requireUser,async(req,res)=>{
    try{
      const permissions=effectiveEmployeePermissions(req.user.permissions||[]);
      if(!permissions.includes('access')&&!permissions.includes('app_admin')){
        return res.status(403).json({error:'TimeClock access has not been granted'});
      }
      const issued=mobilePairing.issue({
        employee_id:req.user.id,
        permissions,
        app_admin_scope:req.user.app_admin_scope||'own',
        auth_source:req.user.auth_source||'portal',
      });
      await audit(req.user.id,'generate_mobile_pairing_code','employee',req.user.id,{
        expires_at:new Date(issued.expires_at).toISOString(),
      });
      return res.json({
        code:issued.code,
        expires_at:new Date(issued.expires_at).toISOString(),
        expires_in_seconds:300,
      });
    }catch(err){
      console.error('Generate mobile pairing code error',err);
      return res.status(500).json({error:'Unable to generate mobile login code'});
    }
  });

  router.post('/auth/mobile-code/redeem',async(req,res)=>{
    try{
      const paired=mobilePairing.redeem(req.body?.code,requestAddress(req));
      const user=await getUserById(paired.employee_id);
      if(!user||!user.active||user.is_active===false){
        return res.status(403).json({error:'This employee account is not active'});
      }
      const permissions=effectiveEmployeePermissions(paired.permissions||[]);
      if(!permissions.includes('access')&&!permissions.includes('app_admin')){
        return res.status(403).json({error:'TimeClock access has not been granted'});
      }
      const token=sessionStore.create(user.id,permissions,{
        app_admin_scope:paired.app_admin_scope,
        auth_source:paired.auth_source,
      });
      const safeUser={...user};
      delete safeUser.pin;
      await audit(user.id,'redeem_mobile_pairing_code','employee',user.id,{
        source_ip:requestAddress(req),
        permission_count:permissions.length,
      });
      return res.json({
        message:'Phone connected to TimeClock',
        token,
        user:safeUser,
        permissions,
      });
    }catch(err){
      if(err.statusCode){
        return res.status(err.statusCode).json({error:err.message,code:err.code});
      }
      console.error('Redeem mobile pairing code error',err);
      return res.status(500).json({error:'Unable to connect phone to TimeClock'});
    }
  });

  router.post('/auth/portal',async(req,res)=>{
    try{
      const secret=process.env.TIMECLOCK_SSO_SECRET;
      if(!secret||secret.length<32) return res.status(503).json({error:'Employee Portal SSO is not configured'});
      const portalToken=req.body?.token;
      if(!portalToken) return res.status(400).json({error:'Portal token is required'});
      const payload=verifyPortalToken(portalToken,secret,{issuer:portalIssuer,audience:portalAudience});
      const synced=await syncPortalUser(payload);
      const permissions=effectiveEmployeePermissions(synced.permissions);
      if(!permissions.includes('access')&&!permissions.includes('app_admin')) return res.status(403).json({error:'TimeClock access has not been granted'});
      const token=sessionStore.create(synced.user.id,permissions,{app_admin_scope:synced.appAdminScope,auth_source:'portal'});
      const user=await getUserById(synced.user.id);
      delete user.pin;
      await audit(user.id,'portal_sso_login','employee',user.id,{portal_user_id:payload.sub,permission_count:permissions.length});
      return res.json({message:'Employee Portal login successful',token,user,permissions,app_admin_scope:synced.appAdminScope,auth_source:'portal'});
    }catch(err){
      console.error('Portal login error',err);
      const status=err.name==='TokenExpiredError'||/token|signature|issuer|audience|algorithm/i.test(err.message)?401:500;
      return res.status(status).json({error:status===401?'Employee Portal login link is invalid or expired':'Employee Portal login failed'});
    }
  });

  return router;
}

module.exports={createAuthRouter,effectiveEmployeePermissions,requestAddress};
