'use strict';

const express=require('express');
const {normalizeIp,defaultTrustedNetworks}=require('../lib/punch-metadata');

function createSettingsRouter({requireUser,requireAnyPermission,pool,audit}){
  const router=express.Router();
  const admin=requireAnyPermission('app_admin');

  async function getJson(key,fallback){
    const result=await pool.query('SELECT value FROM settings WHERE key=$1 LIMIT 1',[key]);
    if(!result.rows.length||!result.rows[0].value)return fallback;
    try{const parsed=JSON.parse(result.rows[0].value);return parsed;}catch(_){return fallback;}
  }
  async function putJson(key,value){
    await pool.query(`INSERT INTO settings(key,value) VALUES($1,$2)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[key,JSON.stringify(value)]);
  }
  router.get('/admin/settings/location',requireUser,admin,async(req,res)=>{
    try{
      const networks=await getJson('trusted_networks',defaultTrustedNetworks());
      const geofences=await getJson('geofences',[]);
      const enforcement=await getJson('geofence_enforcement',false);
      res.json({trusted_networks:networks,geofences:Array.isArray(geofences)?geofences:[],geofence_enforcement:enforcement===true});
    }catch(err){console.error(err);res.status(500).json({error:'Unable to load location settings'});}
  });
  router.post('/admin/settings/location-toggles',requireUser,admin,async(req,res)=>{\n    try{\n      const key=req.body?.key;\n      if(!['trusted_network_enforcement','geofence_enforcement'].includes(key))return res.status(400).json({error:'Invalid location setting'});\n      const enabled=req.body?.enabled===true;\n      if(key==='geofence_enforcement'&&enabled){const geofences=await getJson('geofences',[]);if(!Array.isArray(geofences)||!geofences.some(g=>g&&g.enabled!==false))return res.status(409).json({error:'Add at least one enabled geofence before turning on geofence enforcement'});}\n      await putJson(key,enabled);\n      await audit(req.user.id,key+'_changed','settings',key,{enabled});\n      res.json({key,enabled});\n    }catch(err){console.error(err);res.status(500).json({error:'Unable to update location setting'});}\n  });\n  router.post('/admin/settings/trusted-networks',requireUser,admin,async(req,res)=>{
    try{
      const name=String(req.body?.name||'').trim();
      const ip=normalizeIp(req.body?.ip);
      if(!name)return res.status(400).json({error:'Network name is required'});
      if(!ip)return res.status(400).json({error:'A valid IP address is required'});
      const networks=await getJson('trusted_networks',defaultTrustedNetworks());
      if(networks.some(item=>normalizeIp(item.ip)===ip))return res.status(409).json({error:'That IP address is already trusted'});
      networks.push({name:name.slice(0,100),ip});
      await putJson('trusted_networks',networks);
      await audit(req.user.id,'trusted_network_added','settings',ip,{name,ip});
      res.json({trusted_networks:networks});
    }catch(err){console.error(err);res.status(500).json({error:'Unable to add trusted network'});}
  });
  router.delete('/admin/settings/trusted-networks/:ip',requireUser,admin,async(req,res)=>{
    try{
      const ip=normalizeIp(decodeURIComponent(req.params.ip));
      if(!ip)return res.status(400).json({error:'Valid IP address is required'});
      const networks=await getJson('trusted_networks',defaultTrustedNetworks());
      const removed=networks.find(item=>normalizeIp(item.ip)===ip);
      if(!removed)return res.status(404).json({error:'Trusted network not found'});
      const updated=networks.filter(item=>normalizeIp(item.ip)!==ip);
      await putJson('trusted_networks',updated);
      await audit(req.user.id,'trusted_network_removed','settings',ip,{name:removed.name,ip});
      res.json({trusted_networks:updated});
    }catch(err){console.error(err);res.status(500).json({error:'Unable to remove trusted network'});}
  });
  router.post('/admin/settings/geofences',requireUser,admin,async(req,res)=>{
    try{
      const name=String(req.body?.name||'').trim();
      const latitude=Number(req.body?.latitude),longitude=Number(req.body?.longitude),radiusFeet=Number(req.body?.radius_feet);
      if(!name)return res.status(400).json({error:'Geofence name is required'});
      if(!Number.isFinite(latitude)||latitude<-90||latitude>90||!Number.isFinite(longitude)||longitude<-180||longitude>180)return res.status(400).json({error:'Valid latitude and longitude are required'});
      if(!Number.isFinite(radiusFeet)||radiusFeet<25||radiusFeet>10000)return res.status(400).json({error:'Radius must be between 25 and 10,000 feet'});
      const geofences=await getJson('geofences',[]);
      const item={id:Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8),name:name.slice(0,100),latitude,longitude,radius_feet:Math.round(radiusFeet),enabled:true};
      geofences.push(item);await putJson('geofences',geofences);
      await audit(req.user.id,'geofence_added','settings',item.id,item);
      res.json({geofences});
    }catch(err){console.error(err);res.status(500).json({error:'Unable to add geofence'});}
  });
  router.delete('/admin/settings/geofences/:id',requireUser,admin,async(req,res)=>{
    try{
      const geofences=await getJson('geofences',[]),removed=geofences.find(item=>item.id===req.params.id);
      if(!removed)return res.status(404).json({error:'Geofence not found'});
      const updated=geofences.filter(item=>item.id!==req.params.id);await putJson('geofences',updated);
      await audit(req.user.id,'geofence_removed','settings',removed.id,removed);
      res.json({geofences:updated});
    }catch(err){console.error(err);res.status(500).json({error:'Unable to remove geofence'});}
  });
  return router;
}
module.exports={createSettingsRouter};
