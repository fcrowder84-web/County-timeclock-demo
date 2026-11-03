'use strict';

const { loadExtraHoursSummary } = require('../lib/timecard-extra-approval');

function installTimecardOverrides(router, {
  requireUser, requireAnyPermission, pool, audit, canAccessEmployee, getRequestedPayPeriod,
}) {
  router.post('/supervisor/weekly-cap-extra', requireUser, requireAnyPermission('approve_timecard'), async(req,res) => {
    let client;
    try {
      const employeeId = Number(req.body?.employee_id);
      const weekNumber = Number(req.body?.week_number);
      const value = req.body?.extra_hours;
      const extraHours = Number(value);
      if (!Number.isSafeInteger(employeeId) || employeeId <= 0 || ![1,2].includes(weekNumber)
          || value == null || String(value).trim() === '' || !Number.isFinite(extraHours)
          || extraHours < 0 || Math.abs(extraHours * 100 - Math.round(extraHours * 100)) > 1e-6) {
        return res.status(400).json({ error:'Enter an employee, a week, and valid nonnegative hours (two decimals maximum)' });
      }
      if (!(await canAccessEmployee(req.user, employeeId, ['approve_timecard']))) return res.status(403).json({error:'Access denied'});
      const period = await getRequestedPayPeriod(req);
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE',[employeeId]);
      const approval = await client.query(
        `SELECT status,supervisor_approved_at,payroll_finalized_at FROM pay_period_approvals
          WHERE employee_id=$1 AND pay_period_start=$2::date AND pay_period_end=$3::date
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [employeeId,period.pay_period_start,period.pay_period_end],
      );
      const a=approval.rows[0];
      if (a?.supervisor_approved_at || a?.payroll_finalized_at || (a && !['open','employee_submitted','returned_to_employee'].includes(a.status))) {
        await client.query('ROLLBACK');
        return res.status(409).json({error:'Timecard is locked. Return it for review before changing extra hours.'});
      }
      const {summary} = await loadExtraHoursSummary(client, employeeId, period);
      const week=summary.weeks[weekNumber-1];
      const maxExtra=Number(week.max_cap_extra_hours||0);
      if (week.weekly_hours_cap == null || Math.round(extraHours*100)>Math.round(maxExtra*100)) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error:`Extra hours cannot exceed ${maxExtra.toFixed(2)} worked hours removed by this week's cap`,
          max_extra_hours:maxExtra,
        });
      }
      const prior=await client.query(
        `SELECT extra_hours FROM weekly_cap_extra_hours
           WHERE employee_id=$1 AND pay_period_start=$2::date AND week_number=$3 FOR UPDATE`,
        [employeeId,period.pay_period_start,weekNumber],
      );
      const oldHours=Number(prior.rows[0]?.extra_hours||0);
      if (Math.round(oldHours*100)!==Math.round(extraHours*100)) {
        await client.query(
          `INSERT INTO weekly_cap_extra_hours(employee_id,pay_period_start,week_number,extra_hours,updated_by)
           VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(employee_id,pay_period_start,week_number)
           DO UPDATE SET extra_hours=EXCLUDED.extra_hours,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
          [employeeId,period.pay_period_start,weekNumber,extraHours,req.user.id],
        );
        await client.query(
          `INSERT INTO weekly_cap_extra_hours_audit(employee_id,pay_period_start,week_number,previous_hours,new_hours,changed_by)
            VALUES($1,$2,$3,$4,$5,$6)`,
          [employeeId,period.pay_period_start,weekNumber,oldHours,extraHours,req.user.id],
        );
      }
      await client.query('COMMIT');
      return res.json({message:'Weekly extra hours saved',extra_hours:extraHours,max_extra_hours:maxExtra});
    } catch(err) {
      if (client) await client.query('ROLLBACK').catch(()=>{});
      if (err.statusCode) return res.status(err.statusCode).json({error:err.message});
      console.error(err);
      return res.status(500).json({error:'Unable to save weekly extra hours'});
    } finally { if (client) client.release(); }
  });

  router.post('/supervisor/override-employee-signoff',requireUser,requireAnyPermission('approve_timecard'),async(req,res)=>{
    let client;
    try {
      const employeeId=Number(req.body?.employee_id);
      const reason=String(req.body?.reason||'').trim();
      if (!Number.isSafeInteger(employeeId)||employeeId<=0) return res.status(400).json({error:'Invalid employee'});
      if (!reason || reason.length > 1000) return res.status(400).json({error:'A written reason (1–1000 characters) is required'});
      if (!(await canAccessEmployee(req.user,employeeId,['approve_timecard']))) return res.status(403).json({error:'Access denied'});
      const period=await getRequestedPayPeriod(req);
      client=await pool.connect();
      await client.query('BEGIN');
      await client.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE',[employeeId]);
      const existing=await client.query(
        `SELECT * FROM pay_period_approvals WHERE employee_id=$1
          AND pay_period_start=$2::date AND pay_period_end=$3::date
          ORDER BY id DESC LIMIT 1 FOR UPDATE`,
        [employeeId,period.pay_period_start,period.pay_period_end],
      );
      const a=existing.rows[0];
      if (a?.employee_signed_at) {
        await client.query('ROLLBACK');
        return res.status(409).json({error:'Employee already signed. Use normal supervisor approval.'});
      }
      if (a?.supervisor_approved_at || a?.payroll_finalized_at || (a && !['open','returned_to_employee'].includes(a.status))) {
        await client.query('ROLLBACK');
        return res.status(409).json({error:'Timecard is already approved or not open for supervisor override'});
      }
      const [openPunches,pendingLeave,pendingChanges,pendingLunch]=await Promise.all([
        client.query(`SELECT id FROM time_entries WHERE employee_id=$1 AND deleted_at IS NULL AND clock_in >= $2::date AND clock_in < ($3::date + INTERVAL '1 day') AND clock_out IS NULL`,[employeeId,period.pay_period_start,period.pay_period_end]),
        client.query(`SELECT id FROM leave_entries WHERE employee_id=$1 AND leave_date BETWEEN $2::date AND $3::date AND status='pending'`,[employeeId,period.pay_period_start,period.pay_period_end]),
        client.query(`SELECT tcr.id FROM time_change_requests tcr LEFT JOIN time_entries te ON te.id=tcr.time_entry_id
          WHERE tcr.employee_id=$1 AND tcr.status='pending' AND (tcr.time_entry_id IS NULL OR te.deleted_at IS NULL)
            AND ((te.clock_in >= $2::date AND te.clock_in < ($3::date + INTERVAL '1 day'))
              OR (tcr.requested_clock_in >= $2::date AND tcr.requested_clock_in < ($3::date + INTERVAL '1 day')))`,[employeeId,period.pay_period_start,period.pay_period_end]),
        client.query(`SELECT id FROM forced_lunch_waiver_requests WHERE employee_id=$1 AND work_date BETWEEN $2::date AND $3::date AND status='pending'`,[employeeId,period.pay_period_start,period.pay_period_end]),
      ]);
      if (openPunches.rows.length||pendingLeave.rows.length||pendingChanges.rows.length||pendingLunch.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({error:'Resolve open punches and pending leave, punch and lunch requests before approval'});
      }
      const {summary}=await loadExtraHoursSummary(client,employeeId,period);
      if (summary.period.cap_extra_invalid) {
        await client.query('ROLLBACK');
        return res.status(409).json({error:'Approved weekly extra hours exceed actual worked hours removed by the cap. Correct them before approving.'});
      }
      if (a) await client.query(
        `UPDATE pay_period_approvals SET supervisor_approved_at=NOW(),supervisor_employee_id=$2,
          supervisor_override_reason=$3,status='supervisor_approved'
          WHERE id=$1`,[a.id,req.user.id,reason],
      );
      else await client.query(
        `INSERT INTO pay_period_approvals(employee_id,pay_period_start,pay_period_end,supervisor_approved_at,supervisor_employee_id,supervisor_override_reason,status)
         VALUES($1,$2,$3,NOW(),$4,$5,'supervisor_approved')`,
        [employeeId,period.pay_period_start,period.pay_period_end,req.user.id,reason],
      );
      await client.query('COMMIT');
      await audit(req.user.id,'override_employee_timecard_signoff','employee',employeeId,{...period,reason});
      return res.json({message:'Supervisor approved timecard without employee signature'});
    } catch(err) {
      if (client) await client.query('ROLLBACK').catch(()=>{});
      if (err.statusCode) return res.status(err.statusCode).json({error:err.message});
      console.error(err);
      return res.status(500).json({error:'Unable to override employee signature'});
    } finally {if (client) client.release();}
  });
}

module.exports={installTimecardOverrides};
