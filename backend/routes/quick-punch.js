'use strict';
const express=require('express');
const {recordPunchMetadata}=require('../lib/punch-metadata');

function createQuickPunchRouter({requireUser,requireAnyPermission,pool,audit}){
  const router=express.Router();
  const canPunch=requireAnyPermission('clock_in_out');

  function permissionSet(user){
    return new Set(Array.isArray(user?.permissions)?user.permissions:[]);
  }

  async function canDeleteEntry(user,entry){
    if(Number(user.id)===Number(entry.employee_id))return true;
    const permissions=permissionSet(user);
    if(permissions.has('view_all_timeclock_records')||permissions.has('edit_payroll_time'))return true;
    if(permissions.has('app_admin')&&user.app_admin_scope==='all')return true;
    if(!permissions.has('edit_employee_time')&&!permissions.has('app_admin'))return false;

    const scope=await pool.query(
      `SELECT 1 FROM employees target WHERE target.id=$1 AND (target.department_id=$2 OR EXISTS(SELECT 1 FROM supervisor_employee_assignments sea WHERE sea.employee_id=target.id AND sea.supervisor_employee_id=$3 AND sea.active=TRUE) OR EXISTS(SELECT 1 FROM department_heads dh WHERE dh.employee_id=$3 AND dh.department_id=target.department_id AND dh.active=TRUE)) LIMIT 1`,
      [entry.employee_id,user.department_id,user.id],
    );
    return scope.rows.length>0;
  }

  async function captureMetadata(req,timeEntryId,punchType){
    try{return await recordPunchMetadata({pool,req,employeeId:req.user.id,timeEntryId,punchType});}
    catch(err){console.error('Punch metadata capture error',err);return null;}
  }

  router.get('/quick-status',requireUser,canPunch,async(req,res)=>{
    try{
      const [openResult,lastResult]=await Promise.all([
        pool.query(`SELECT id,clock_in FROM time_entries WHERE employee_id=$1 AND deleted_at IS NULL AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`,[req.user.id]),
        pool.query(`SELECT clock_in,clock_out FROM time_entries WHERE employee_id=$1 AND deleted_at IS NULL ORDER BY GREATEST(clock_in,COALESCE(clock_out,clock_in)) DESC LIMIT 1`,[req.user.id]),
      ]);
      const openEntry=openResult.rows[0]||null,latest=lastResult.rows[0]||null,clockedIn=Boolean(openEntry);
      return res.json({clocked_in:clockedIn,next_action:clockedIn?'clock_out':'clock_in',current_clock_in:openEntry?.clock_in||null,last_punch_type:latest?(latest.clock_out?'clock_out':'clock_in'):null,last_punch_at:latest?(latest.clock_out||latest.clock_in):null});
    }catch(err){console.error(err);return res.status(500).json({error:'Quick punch status error'});}
  });

  router.get('/my-punches',requireUser,async(req,res)=>{
    try{
      const result=await pool.query(`SELECT id,clock_in,clock_out,status,to_char(clock_in,'MM/DD/YYYY HH12:MI AM') AS clock_in_display,CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out,'MM/DD/YYYY HH12:MI AM') END AS clock_out_display,ROUND((EXTRACT(EPOCH FROM (COALESCE(clock_out,NOW())-clock_in))/3600)::numeric,2) AS hours_worked FROM time_entries WHERE employee_id=$1 AND deleted_at IS NULL AND clock_in>=NOW()-INTERVAL '90 days' ORDER BY clock_in DESC LIMIT 100`,[req.user.id]);
      return res.json({entries:result.rows});
    }catch(err){console.error(err);return res.status(500).json({error:'Unable to load punches'});}
  });

  router.post('/delete-punch',requireUser,async(req,res)=>{
    const entryId=Number(req.body?.time_entry_id),reason=String(req.body?.reason||'').trim();
    if(!Number.isInteger(entryId)||entryId<=0)return res.status(400).json({error:'Valid time entry is required'});
    if(reason.length<3)return res.status(400).json({error:'Deletion reason is required'});
    if(reason.length>500)return res.status(400).json({error:'Deletion reason must be 500 characters or less'});
    try{
      const entryResult=await pool.query(`SELECT * FROM time_entries WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,[entryId]);
      if(!entryResult.rows.length)return res.status(404).json({error:'Time entry not found'});
      const entry=entryResult.rows[0];
      if(!(await canDeleteEntry(req.user,entry)))return res.status(403).json({error:'You cannot delete this employee\'s punch'});
      const approvalResult=await pool.query(`SELECT id,status,employee_signed_at,supervisor_approved_at,payroll_finalized_at FROM pay_period_approvals WHERE employee_id=$1 AND $2::timestamp>=pay_period_start AND $2::timestamp<(pay_period_end+INTERVAL '1 day') ORDER BY id DESC LIMIT 1`,[entry.employee_id,entry.clock_in]);
      const approval=approvalResult.rows[0]||null;
      const deleted=await pool.query(`UPDATE time_entries SET deleted_at=NOW(),deleted_by_employee_id=$2,deletion_reason=$3 WHERE id=$1 AND deleted_at IS NULL RETURNING id`,[entry.id,req.user.id,reason]);
      if(!deleted.rows.length)return res.status(409).json({error:'Punch was already deleted or could not be deleted'});
      if(approval)await pool.query(`UPDATE pay_period_approvals SET employee_signed_at=NULL,supervisor_approved_at=NULL,supervisor_employee_id=NULL,payroll_finalized_at=NULL,payroll_finalized_by=NULL,status='open' WHERE id=$1`,[approval.id]);
      await audit(req.user.id,'delete_time_entry','time_entry',entry.id,{employee_id:entry.employee_id,original_clock_in:entry.clock_in,original_clock_out:entry.clock_out,original_status:entry.status,reason,approval_reopened:Boolean(approval),previous_approval_status:approval?.status||null,soft_delete:true});
      return res.json({message:'Punch deleted. The original record remains in the audit trail.'});
    }catch(err){console.error(err);return res.status(500).json({error:'Delete punch error'});}
  });

  router.post('/clock-in',requireUser,canPunch,async(req,res)=>{
    try{
      const openEntry=await pool.query(`SELECT id FROM time_entries WHERE employee_id=$1 AND deleted_at IS NULL AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1`,[req.user.id]);
      if(openEntry.rows.length)return res.status(400).json({error:'You are already clocked in'});
      const result=await pool.query(`INSERT INTO time_entries(employee_id,clock_in,status) VALUES($1,NOW(),'open') RETURNING *`,[req.user.id]);
      const metadata=await captureMetadata(req,result.rows[0].id,'clock_in');await audit(req.user.id,'clock_in','time_entry',result.rows[0].id,metadata);
      return res.json({message:`${req.user.first_name} clocked in successfully`,entry:result.rows[0],metadata_recorded:Boolean(metadata)});
    }catch(err){console.error(err);return res.status(500).json({error:'Clock-in error'});}
  });

  router.post('/clock-out',requireUser,canPunch,async(req,res)=>{
    try{
      const result=await pool.query(`UPDATE time_entries SET clock_out=NOW(),status='closed' WHERE id=(SELECT id FROM time_entries WHERE employee_id=$1 AND deleted_at IS NULL AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1) RETURNING *`,[req.user.id]);
      if(!result.rows.length)return res.status(400).json({error:'You are not currently clocked in'});
      const metadata=await captureMetadata(req,result.rows[0].id,'clock_out');await audit(req.user.id,'clock_out','time_entry',result.rows[0].id,metadata);
      return res.json({message:`${req.user.first_name} clocked out successfully`,entry:result.rows[0],metadata_recorded:Boolean(metadata)});
    }catch(err){console.error(err);return res.status(500).json({error:'Clock-out error'});}
  });
  return router;
}
module.exports={createQuickPunchRouter};
