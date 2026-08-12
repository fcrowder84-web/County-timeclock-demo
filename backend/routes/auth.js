'use strict';
const express=require('express');

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

  router.post('/logout',requireUser,async(req,res)=>{
    const token=getBearerToken(req);
    if(token) sessionStore.destroy(token);
    res.json({message:'Logged out'});
  });

  router.get('/me',requireUser,async(req,res)=>{
    const safeUser={...req.user};
    delete safeUser.pin;
    res.json({
      user:safeUser,
      permissions:req.user.permissions||[],
      app_admin_scope:req.user.app_admin_scope||'own',
      auth_source:req.user.auth_source||'legacy',
    });
  });

  router.post('/auth/portal',async(req,res)=>{
    try{
      const secret=process.env.TIMECLOCK_SSO_SECRET;
      if(!secret||secret.length<32) return res.status(503).json({error:'Employee Portal SSO is not configured'});
      const portalToken=req.body?.token;
      if(!portalToken) return res.status(400).json({error:'Portal token is required'});
      const payload=verifyPortalToken(portalToken,secret,{issuer:portalIssuer,audience:portalAudience});
      const synced=await syncPortalUser(payload);
      if(!synced.permissions.includes('access')&&!synced.permissions.includes('app_admin')) return res.status(403).json({error:'TimeClock access has not been granted'});
      const token=sessionStore.create(synced.user.id,synced.permissions,{app_admin_scope:synced.appAdminScope,auth_source:'portal'});
      const user=await getUserById(synced.user.id);
      delete user.pin;
      await audit(user.id,'portal_sso_login','employee',user.id,{portal_user_id:payload.sub,permission_count:synced.permissions.length});
      return res.json({message:'Employee Portal login successful',token,user,permissions:synced.permissions,app_admin_scope:synced.appAdminScope,auth_source:'portal'});
    }catch(err){
      console.error('Portal login error',err);
      const status=err.name==='TokenExpiredError'||/token|signature|issuer|audience|algorithm/i.test(err.message)?401:500;
      return res.status(status).json({error:status===401?'Employee Portal login link is invalid or expired':'Employee Portal login failed'});
    }
  });

  return router;
}

module.exports={createAuthRouter};
