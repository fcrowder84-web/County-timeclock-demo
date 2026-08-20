'use strict';
const express=require('express');
const {recordPunchMetadata}=require('../lib/punch-metadata');

function createQuickPunchRouter({requireUser,requireAnyPermission,pool,audit}){
  const router=express.Router();
  const canPunch=requireAnyPermission('clock_in_out');

  async function captureMetadata(req,timeEntryId,punchType){
    try{
      return await recordPunchMetadata({
        pool,
        req,
        employeeId:req.user.id,
        timeEntryId,
        punchType,
      });
    }catch(err){
      // Location/network collection is audit-only for now and must never block a valid punch.
      console.error('Punch metadata capture error',err);
      return null;
    }
  }

  router.get('/quick-status',requireUser,canPunch,async(req,res)=>{
    try{
      const result=await pool.query(`SELECT id, clock_in, clock_out FROM time_entries WHERE employee_id=$1 ORDER BY clock_in DESC LIMIT 1`,[req.user.id]);
      const latest=result.rows[0]||null;
      const clockedIn=Boolean(latest&&!latest.clock_out);
      return res.json({
        clocked_in:clockedIn,
        next_action:clockedIn?'clock_out':'clock_in',
        last_punch_type:latest?(latest.clock_out?'clock_out':'clock_in'):null,
        last_punch_at:latest?(latest.clock_out||latest.clock_in):null,
      });
    }catch(err){console.error(err);return res.status(500).json({error:'Quick punch status error'});}
  });

  router.post('/clock-in',requireUser,canPunch,async(req,res)=>{
    try{
      const openEntry=await pool.query(`SELECT id FROM time_entries WHERE employee_id=$1 AND clock_out IS NULL LIMIT 1`,[req.user.id]);
      if(openEntry.rows.length) return res.status(400).json({error:'You are already clocked in'});
      const result=await pool.query(`INSERT INTO time_entries(employee_id,clock_in,status) VALUES($1,NOW(),'open') RETURNING *`,[req.user.id]);
      const metadata=await captureMetadata(req,result.rows[0].id,'clock_in');
      await audit(req.user.id,'clock_in','time_entry',result.rows[0].id,metadata);
      return res.json({message:`${req.user.first_name} clocked in successfully`,entry:result.rows[0],metadata_recorded:Boolean(metadata)});
    }catch(err){console.error(err);return res.status(500).json({error:'Clock-in error'});}
  });

  router.post('/clock-out',requireUser,canPunch,async(req,res)=>{
    try{
      const result=await pool.query(`UPDATE time_entries SET clock_out=NOW(),status='closed' WHERE id=(SELECT id FROM time_entries WHERE employee_id=$1 AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1) RETURNING *`,[req.user.id]);
      if(!result.rows.length) return res.status(400).json({error:'You are not currently clocked in'});
      const metadata=await captureMetadata(req,result.rows[0].id,'clock_out');
      await audit(req.user.id,'clock_out','time_entry',result.rows[0].id,metadata);
      return res.json({message:`${req.user.first_name} clocked out successfully`,entry:result.rows[0],metadata_recorded:Boolean(metadata)});
    }catch(err){console.error(err);return res.status(500).json({error:'Clock-out error'});}
  });

  return router;
}

module.exports={createQuickPunchRouter};
