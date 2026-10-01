'use strict';

const express = require('express');
const { summarizeTimecard } = require('../lib/timecard-summary');

function positiveInt(value,label='employee'){
  const parsed=Number(value);
  if(!Number.isInteger(parsed)||parsed<=0){
    const error=new Error(`Valid ${label} is required`);
    error.statusCode=400;
    throw error;
  }
  return parsed;
}

async function filterRowsByScope(rows,employeeIdKey,user,permissionKey,canAccessEmployee){
  const allowed=new Map();
  const visible=[];
  for(const row of rows){
    const employeeId=Number(row[employeeIdKey]);
    if(!allowed.has(employeeId)){
      allowed.set(employeeId,await canAccessEmployee(user,employeeId,[permissionKey]));
    }
    if(allowed.get(employeeId)) visible.push(row);
  }
  return visible;
}

async function finalizationState(db,employeeId,period,{lock=false}={}){
  const approvalResult=await db.query(
    `SELECT *
       FROM pay_period_approvals
      WHERE employee_id=$1
        AND pay_period_start=$2::date
        AND pay_period_end=$3::date
      ORDER BY id DESC
      LIMIT 1
      ${lock?'FOR UPDATE':''}`,
    [employeeId,period.pay_period_start,period.pay_period_end],
  );
  const approval=approvalResult.rows[0]||null;
  const blockers=[];

  if(!approval){
    blockers.push('Timecard has not been submitted');
  }else{
    if(!approval.employee_signed_at) blockers.push('Employee has not submitted the timecard');
    if(!approval.supervisor_approved_at) blockers.push('Supervisor approval is missing');
    if(!['supervisor_approved','payroll_finalized'].includes(approval.status)){
      blockers.push(`Timecard status is ${approval.status}`);
    }
  }

  const [openPunches,pendingChanges,pendingLeave,pendingLunch]=await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS count
         FROM time_entries
        WHERE employee_id=$1
          AND deleted_at IS NULL
          AND clock_in >= $2::date
          AND clock_in < ($3::date + INTERVAL '1 day')
          AND clock_out IS NULL`,
      [employeeId,period.pay_period_start,period.pay_period_end],
    ),
    db.query(
      `SELECT COUNT(*)::int AS count
         FROM time_change_requests tcr
         LEFT JOIN time_entries te ON te.id=tcr.time_entry_id
        WHERE tcr.employee_id=$1
          AND tcr.status='pending'
          AND (
            (tcr.requested_clock_in >= $2::date AND tcr.requested_clock_in < ($3::date + INTERVAL '1 day'))
            OR (tcr.requested_clock_out >= $2::date AND tcr.requested_clock_out < ($3::date + INTERVAL '1 day'))
            OR (te.clock_in >= $2::date AND te.clock_in < ($3::date + INTERVAL '1 day'))
          )`,
      [employeeId,period.pay_period_start,period.pay_period_end],
    ),
    db.query(
      `SELECT COUNT(*)::int AS count
         FROM leave_entries
        WHERE employee_id=$1
          AND leave_date BETWEEN $2::date AND $3::date
          AND status='pending'`,
      [employeeId,period.pay_period_start,period.pay_period_end],
    ),
    db.query(
      `SELECT COUNT(*)::int AS count
         FROM forced_lunch_waiver_requests
        WHERE employee_id=$1
          AND work_date BETWEEN $2::date AND $3::date
          AND status='pending'`,
      [employeeId,period.pay_period_start,period.pay_period_end],
    ),
  ]);

  if(Number(openPunches.rows[0]?.count||0)>0) blockers.push('Open punch remains in the pay period');
  if(Number(pendingChanges.rows[0]?.count||0)>0) blockers.push('Pending punch correction remains');
  if(Number(pendingLeave.rows[0]?.count||0)>0) blockers.push('Pending leave request remains');
  if(Number(pendingLunch.rows[0]?.count||0)>0) blockers.push('Pending lunch-waiver request remains');

  return {approval,blockers};
}

function createPayrollRouter({
  requireUser,
  requireAnyPermission,
  pool,
  audit,
  canAccessEmployee,
  getRequestedPayPeriod,
}) {
  const router = express.Router();

  router.get(
    '/payroll/department-summary',
    requireUser,
    requireAnyPermission('view_payroll_records'),
    async (req,res)=>{
      try{
        const period=await getRequestedPayPeriod(req);
        const result=await pool.query(
          `SELECT
             d.name AS department,
             e.id,
             e.first_name,
             e.last_name,
             e.role,
             e.weekly_hours_cap,
             ppa.status,
             ppa.employee_signed_at,
             ppa.supervisor_approved_at,
             ppa.payroll_finalized_at
           FROM employees e
           LEFT JOIN departments d ON d.id=e.department_id
           LEFT JOIN pay_period_approvals ppa
             ON ppa.employee_id=e.id
            AND ppa.pay_period_start=$1::date
            AND ppa.pay_period_end=$2::date
           WHERE (
             e.active=TRUE
             OR ppa.id IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM time_entries period_te
                WHERE period_te.employee_id=e.id
                  AND period_te.deleted_at IS NULL
                  AND period_te.clock_in >= $1::date
                  AND period_te.clock_in < ($2::date + INTERVAL '1 day')
             )
             OR EXISTS (
               SELECT 1 FROM leave_entries period_leave
                WHERE period_leave.employee_id=e.id
                  AND period_leave.leave_date BETWEEN $1::date AND $2::date
                  AND period_leave.status IN ('pending','approved')
             )
           )
           ORDER BY d.name,e.last_name,e.first_name`,
          [period.pay_period_start,period.pay_period_end],
        );
        return res.json(await filterRowsByScope(
          result.rows,'id',req.user,'view_payroll_records',canAccessEmployee,
        ));
      }catch(err){
        console.error(err);
        return res.status(err.statusCode||500).json({error:err.message||'Payroll summary error'});
      }
    },
  );

  router.get(
    '/payroll/export-current-period',
    requireUser,
    requireAnyPermission('export_payroll'),
    async (req,res)=>{
      try{
        const period=await getRequestedPayPeriod(req);
        const result=await pool.query(
          `SELECT
             e.id AS employee_id,
             e.employee_number,
             e.first_name,
             e.last_name,
             e.weekly_hours_cap,
             d.name AS department,
             COALESCE(ppa.status,'pending') AS timecard_status,
             te.id AS time_entry_id,
             to_char(te.clock_in,'MM/DD/YYYY') AS work_date,
             to_char(te.clock_in,'YYYY-MM-DD') AS work_date_iso,
             te.clock_in AS clock_in_raw,
             te.clock_out AS clock_out_raw,
             to_char(te.clock_in,'HH12:MI AM') AS clock_in,
             CASE WHEN te.clock_out IS NULL THEN '' ELSE to_char(te.clock_out,'HH12:MI AM') END AS clock_out,
             ROUND((EXTRACT(EPOCH FROM (COALESCE(te.clock_out,NOW())-te.clock_in))/3600)::numeric,2) AS hours_worked,
             COALESCE(lunch_setting.enabled,FALSE) AS forced_lunch_enabled,
             COALESCE(lunch_setting.minutes,0) AS forced_lunch_minutes,
             EXISTS(
               SELECT 1 FROM forced_lunch_waivers flw
                WHERE flw.employee_id=e.id
                  AND flw.work_date=te.clock_in::date
                  AND flw.active=TRUE
             ) AS lunch_waived
           FROM employees e
           LEFT JOIN departments d ON d.id=e.department_id
           LEFT JOIN pay_period_approvals ppa
             ON ppa.employee_id=e.id
            AND ppa.pay_period_start=$1::date
            AND ppa.pay_period_end=$2::date
           LEFT JOIN time_entries te
             ON te.employee_id=e.id
            AND te.deleted_at IS NULL
            AND te.clock_in >= $1::date
            AND te.clock_in < ($2::date + INTERVAL '1 day')
           LEFT JOIN LATERAL (
             SELECT flsh.enabled,flsh.minutes
               FROM forced_lunch_setting_history flsh
              WHERE flsh.employee_id=e.id
                AND flsh.effective_date <= te.clock_in::date
              ORDER BY flsh.effective_date DESC
              LIMIT 1
           ) lunch_setting ON TRUE
           WHERE (
             e.active=TRUE
             OR ppa.id IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM time_entries period_te
                WHERE period_te.employee_id=e.id
                  AND period_te.deleted_at IS NULL
                  AND period_te.clock_in >= $1::date
                  AND period_te.clock_in < ($2::date + INTERVAL '1 day')
             )
             OR EXISTS (
               SELECT 1 FROM leave_entries period_leave
                WHERE period_leave.employee_id=e.id
                  AND period_leave.leave_date BETWEEN $1::date AND $2::date
                  AND period_leave.status IN ('pending','approved')
             )
           )
           ORDER BY d.name,e.last_name,e.first_name,te.clock_in`,
          [period.pay_period_start,period.pay_period_end],
        );
        const rows=await filterRowsByScope(
          result.rows,'employee_id',req.user,'export_payroll',canAccessEmployee,
        );
        const employeeIds=[...new Set(rows.map(row=>Number(row.employee_id)).filter(Number.isInteger))];
        let leaveRows=[];
        let lunchSettings=[];
        let lunchWaivers=[];
        if(employeeIds.length){
          const [leaveResult,lunchSettingsResult,lunchWaiversResult]=await Promise.all([
            pool.query(
              `SELECT employee_id,to_char(leave_date,'YYYY-MM-DD') AS leave_date_iso,
                      leave_type,quarter_hours,status
                 FROM leave_entries
                WHERE employee_id=ANY($1::int[])
                  AND leave_date BETWEEN $2::date AND $3::date
                  AND status IN ('pending','approved')
                ORDER BY employee_id,leave_date,id`,
              [employeeIds,period.pay_period_start,period.pay_period_end],
            ),
            pool.query(
              `SELECT employee_id,to_char(effective_date,'YYYY-MM-DD') AS effective_date_iso,
                      enabled,minutes
                 FROM forced_lunch_setting_history
                WHERE employee_id=ANY($1::int[])
                  AND effective_date <= $2::date
                ORDER BY employee_id,effective_date,id`,
              [employeeIds,period.pay_period_end],
            ),
            pool.query(
              `SELECT employee_id,to_char(work_date,'YYYY-MM-DD') AS work_date_iso,
                      active,reason,source,waived_by_employee_id
                 FROM forced_lunch_waivers
                WHERE employee_id=ANY($1::int[])
                  AND work_date BETWEEN $2::date AND $3::date
                  AND active=TRUE
                ORDER BY employee_id,work_date,id`,
              [employeeIds,period.pay_period_start,period.pay_period_end],
            ),
          ]);
          leaveRows=leaveResult.rows;
          lunchSettings=lunchSettingsResult.rows;
          lunchWaivers=lunchWaiversResult.rows;
        }

        const summaries={};
        for(const employeeId of employeeIds){
          const employeeEntries=rows
            .filter(row=>Number(row.employee_id)===employeeId&&row.time_entry_id)
            .map(row=>({
              clock_in:row.clock_in_raw,
              clock_out:row.clock_out_raw,
              work_date:row.work_date_iso,
              hours_worked:row.hours_worked,
            }));
          const employeeRow=rows.find(row=>Number(row.employee_id)===employeeId);
          summaries[employeeId]=summarizeTimecard({
            entries:employeeEntries,
            leaveEntries:leaveRows.filter(row=>Number(row.employee_id)===employeeId),
            payPeriodStart:period.pay_period_start,
            forcedLunchSettings:lunchSettings.filter(row=>Number(row.employee_id)===employeeId),
            lunchWaivers:lunchWaivers.filter(row=>Number(row.employee_id)===employeeId),
            weeklyHoursCap:employeeRow?.weekly_hours_cap,
          });
        }

        return res.json({
          pay_period_start:period.pay_period_start,
          pay_period_end:period.pay_period_end,
          rows,
          leave_entries:leaveRows,
          timecard_summaries:summaries,
        });
      }catch(err){
        console.error(err);
        return res.status(err.statusCode||500).json({error:err.message||'Payroll export error'});
      }
    },
  );

  router.get(
    '/payroll/print-timecards',
    requireUser,
    requireAnyPermission('view_payroll_records'),
    async (req,res)=>{
      try{
        const period=await getRequestedPayPeriod(req);
        const result=await pool.query(
          `SELECT
             e.id AS employee_id,
             e.employee_number,
             e.first_name,
             e.last_name,
             e.weekly_hours_cap,
             d.name AS department,
             ppa.status AS approval_status,
             ppa.employee_signed_at,
             ppa.supervisor_approved_at,
             ppa.payroll_finalized_at,
             te.id AS time_entry_id,
             to_char(te.clock_in,'MM/DD/YYYY') AS work_date,
             to_char(te.clock_in,'YYYY-MM-DD') AS work_date_iso,
             te.clock_in AS clock_in_raw,
             te.clock_out AS clock_out_raw,
             to_char(te.clock_in,'HH12:MI AM') AS clock_in,
             CASE WHEN te.clock_out IS NULL THEN '' ELSE to_char(te.clock_out,'HH12:MI AM') END AS clock_out,
             ROUND((EXTRACT(EPOCH FROM (COALESCE(te.clock_out,NOW())-te.clock_in))/3600)::numeric,2) AS hours_worked,
             COALESCE(lunch_setting.enabled,FALSE) AS forced_lunch_enabled,
             COALESCE(lunch_setting.minutes,0) AS forced_lunch_minutes,
             EXISTS(
               SELECT 1 FROM forced_lunch_waivers flw
                WHERE flw.employee_id=e.id
                  AND flw.work_date=te.clock_in::date
                  AND flw.active=TRUE
             ) AS lunch_waived
           FROM employees e
           LEFT JOIN departments d ON d.id=e.department_id
           LEFT JOIN pay_period_approvals ppa
             ON ppa.employee_id=e.id
            AND ppa.pay_period_start=$1::date
            AND ppa.pay_period_end=$2::date
           LEFT JOIN time_entries te
             ON te.employee_id=e.id
            AND te.deleted_at IS NULL
            AND te.clock_in >= $1::date
            AND te.clock_in < ($2::date + INTERVAL '1 day')
           LEFT JOIN LATERAL (
             SELECT flsh.enabled,flsh.minutes
               FROM forced_lunch_setting_history flsh
              WHERE flsh.employee_id=e.id
                AND flsh.effective_date <= te.clock_in::date
              ORDER BY flsh.effective_date DESC
              LIMIT 1
           ) lunch_setting ON TRUE
           WHERE (
             e.active=TRUE
             OR ppa.id IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM time_entries period_te
                WHERE period_te.employee_id=e.id
                  AND period_te.deleted_at IS NULL
                  AND period_te.clock_in >= $1::date
                  AND period_te.clock_in < ($2::date + INTERVAL '1 day')
             )
           )
           ORDER BY d.name,e.last_name,e.first_name,te.clock_in`,
          [period.pay_period_start,period.pay_period_end],
        );
        const rows=await filterRowsByScope(
          result.rows,'employee_id',req.user,'view_payroll_records',canAccessEmployee,
        );
        const employeeIds=[...new Set(rows.map(row=>Number(row.employee_id)).filter(Number.isInteger))];
        let leaveRows=[];
        let lunchSettings=[];
        let lunchWaivers=[];
        if(employeeIds.length){
          const [leaveResult,lunchSettingsResult,lunchWaiversResult]=await Promise.all([
            pool.query(
              `SELECT employee_id,to_char(leave_date,'YYYY-MM-DD') AS leave_date_iso,
                      leave_type,quarter_hours,status
                 FROM leave_entries
                WHERE employee_id=ANY($1::int[])
                  AND leave_date BETWEEN $2::date AND $3::date
                  AND status IN ('pending','approved')
                ORDER BY employee_id,leave_date,id`,
              [employeeIds,period.pay_period_start,period.pay_period_end],
            ),
            pool.query(
              `SELECT employee_id,to_char(effective_date,'YYYY-MM-DD') AS effective_date_iso,
                      enabled,minutes
                 FROM forced_lunch_setting_history
                WHERE employee_id=ANY($1::int[])
                  AND effective_date <= $2::date
                ORDER BY employee_id,effective_date,id`,
              [employeeIds,period.pay_period_end],
            ),
            pool.query(
              `SELECT employee_id,to_char(work_date,'YYYY-MM-DD') AS work_date_iso,
                      active,reason,source,waived_by_employee_id
                 FROM forced_lunch_waivers
                WHERE employee_id=ANY($1::int[])
                  AND work_date BETWEEN $2::date AND $3::date
                  AND active=TRUE
                ORDER BY employee_id,work_date,id`,
              [employeeIds,period.pay_period_start,period.pay_period_end],
            ),
          ]);
          leaveRows=leaveResult.rows;
          lunchSettings=lunchSettingsResult.rows;
          lunchWaivers=lunchWaiversResult.rows;
        }

        const summaries={};
        for(const employeeId of employeeIds){
          const employeeEntries=rows
            .filter(row=>Number(row.employee_id)===employeeId&&row.time_entry_id)
            .map(row=>({
              clock_in:row.clock_in_raw,
              clock_out:row.clock_out_raw,
              work_date:row.work_date_iso,
              hours_worked:row.hours_worked,
            }));
          const employeeRow=rows.find(row=>Number(row.employee_id)===employeeId);
          summaries[employeeId]=summarizeTimecard({
            entries:employeeEntries,
            leaveEntries:leaveRows.filter(row=>Number(row.employee_id)===employeeId),
            payPeriodStart:period.pay_period_start,
            forcedLunchSettings:lunchSettings.filter(row=>Number(row.employee_id)===employeeId),
            lunchWaivers:lunchWaivers.filter(row=>Number(row.employee_id)===employeeId),
            weeklyHoursCap:employeeRow?.weekly_hours_cap,
          });
        }

        return res.json({
          pay_period_start:period.pay_period_start,
          pay_period_end:period.pay_period_end,
          rows,
          leave_entries:leaveRows,
          timecard_summaries:summaries,
        });
      }catch(err){
        console.error(err);
        return res.status(err.statusCode||500).json({error:err.message||'Print timecards error'});
      }
    },
  );

  router.post(
    '/payroll/finalize-timecard',
    requireUser,
    requireAnyPermission('finalize_timecard'),
    async (req,res)=>{
      let client=null;
      try{
        const employeeId=positiveInt(req.body?.employee_id);
        if(!(await canAccessEmployee(req.user,employeeId,['finalize_timecard']))){
          return res.status(403).json({error:'Access denied'});
        }
        const period=await getRequestedPayPeriod(req);
        client=await pool.connect();
        await client.query('BEGIN');
        const state=await finalizationState(client,employeeId,period,{lock:true});
        if(state.approval?.payroll_finalized_at||state.approval?.status==='payroll_finalized'){
          await client.query('ROLLBACK');
          return res.json({message:'Timecard is already payroll finalized',approval:state.approval});
        }
        if(state.blockers.length){
          await client.query('ROLLBACK');
          return res.status(409).json({
            error:'Timecard is not ready for payroll finalization',
            blockers:state.blockers,
          });
        }
        const updated=await client.query(
          `UPDATE pay_period_approvals
              SET payroll_finalized_at=NOW(),
                  payroll_finalized_by=$1,
                  status='payroll_finalized'
            WHERE id=$2
            RETURNING *`,
          [req.user.id,state.approval.id],
        );
        await client.query('COMMIT');
        await audit(req.user.id,'finalize_timecard','employee',employeeId,{
          pay_period_start:period.pay_period_start,
          pay_period_end:period.pay_period_end,
          approval_id:state.approval.id,
        });
        return res.json({message:'Timecard payroll finalized',approval:updated.rows[0]});
      }catch(err){
        if(client) await client.query('ROLLBACK').catch(()=>{});
        if(err.statusCode) return res.status(err.statusCode).json({error:err.message});
        console.error(err);
        return res.status(500).json({error:'Timecard finalization failed'});
      }finally{
        if(client) client.release();
      }
    },
  );

  router.post(
    '/payroll/finalize-pay-period',
    requireUser,
    requireAnyPermission('finalize_pay_period'),
    async (req,res)=>{
      let client=null;
      try{
        const period=await getRequestedPayPeriod(req);
        client=await pool.connect();
        await client.query('BEGIN');
        const employees=await client.query(
          `SELECT DISTINCT e.id,e.first_name,e.last_name
             FROM employees e
             LEFT JOIN pay_period_approvals ppa
               ON ppa.employee_id=e.id
              AND ppa.pay_period_start=$1::date
              AND ppa.pay_period_end=$2::date
            WHERE e.active=TRUE
               OR ppa.id IS NOT NULL
               OR EXISTS (
                 SELECT 1 FROM time_entries te
                  WHERE te.employee_id=e.id
                    AND te.deleted_at IS NULL
                    AND te.clock_in >= $1::date
                    AND te.clock_in < ($2::date + INTERVAL '1 day')
               )
               OR EXISTS (
                 SELECT 1 FROM leave_entries le
                  WHERE le.employee_id=e.id
                    AND le.leave_date BETWEEN $1::date AND $2::date
                    AND le.status IN ('pending','approved')
               )
            ORDER BY e.last_name,e.first_name,e.id`,
          [period.pay_period_start,period.pay_period_end],
        );

        const authorized=[];
        for(const employee of employees.rows){
          if(await canAccessEmployee(req.user,employee.id,['finalize_pay_period'])) authorized.push(employee);
        }
        if(!authorized.length){
          await client.query('ROLLBACK');
          return res.status(403).json({error:'No employees are within your finalization scope'});
        }

        const blockers=[];
        const ready=[];
        for(const employee of authorized){
          const state=await finalizationState(client,employee.id,period,{lock:true});
          if(state.approval?.payroll_finalized_at||state.approval?.status==='payroll_finalized'){
            continue;
          }
          if(state.blockers.length){
            blockers.push({
              employee_id:employee.id,
              employee:`${employee.first_name} ${employee.last_name}`,
              blockers:state.blockers,
            });
          }else{
            ready.push({employee,approval:state.approval});
          }
        }

        if(blockers.length){
          await client.query('ROLLBACK');
          return res.status(409).json({
            error:'Pay period cannot be finalized until every employee in scope is ready',
            blockers,
          });
        }

        if(ready.length){
          await client.query(
            `UPDATE pay_period_approvals
                SET payroll_finalized_at=NOW(),
                    payroll_finalized_by=$1,
                    status='payroll_finalized'
              WHERE id = ANY($2::int[])`,
            [req.user.id,ready.map(item=>item.approval.id)],
          );
        }
        await client.query('COMMIT');
        await audit(req.user.id,'finalize_pay_period','pay_period',period.pay_period_start,{
          pay_period_start:period.pay_period_start,
          pay_period_end:period.pay_period_end,
          finalized_employee_ids:ready.map(item=>item.employee.id),
          already_finalized_count:authorized.length-ready.length,
        });
        return res.json({
          message:ready.length
            ? `${ready.length} timecard${ready.length===1?'':'s'} payroll finalized`
            : 'All timecards in scope were already payroll finalized',
          finalized_count:ready.length,
          scoped_employee_count:authorized.length,
        });
      }catch(err){
        if(client) await client.query('ROLLBACK').catch(()=>{});
        if(err.statusCode) return res.status(err.statusCode).json({error:err.message});
        console.error(err);
        return res.status(500).json({error:'Pay-period finalization failed'});
      }finally{
        if(client) client.release();
      }
    },
  );

  return router;
}

module.exports={createPayrollRouter,finalizationState};
