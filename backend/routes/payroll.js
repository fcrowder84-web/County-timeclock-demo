'use strict';

const express = require('express');

function createPayrollRouter({ requireUser, requireAnyPermission, pool, getRequestedPayPeriod }) {
  const router = express.Router();

  router.get(
    '/payroll/department-summary',
    requireUser,
    requireAnyPermission('view_payroll_records', 'view_payroll_reports'),
    async (req, res) => {
      try {
        const period = await getRequestedPayPeriod(req);
        const result = await pool.query(
          `SELECT
             d.name AS department,
             e.id,
             e.first_name,
             e.last_name,
             e.role,
             ppa.status,
             ppa.employee_signed_at,
             ppa.supervisor_approved_at
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
               SELECT 1
               FROM time_entries period_te
               WHERE period_te.employee_id=e.id
                 AND period_te.deleted_at IS NULL
                 AND period_te.clock_in >= $1::date
                 AND period_te.clock_in < ($2::date + INTERVAL '1 day')
             )
           )
           ORDER BY d.name,e.last_name`,
          [period.pay_period_start, period.pay_period_end],
        );
        return res.json(result.rows);
      } catch (err) {
        console.error(err);
        return res.status(err.statusCode || 500).json({ error: err.message || 'Payroll summary error' });
      }
    },
  );

  router.get(
    '/payroll/export-current-period',
    requireUser,
    requireAnyPermission('export_payroll'),
    async (req, res) => {
      try {
        const period = await getRequestedPayPeriod(req);
        const result = await pool.query(
          `SELECT
             e.employee_number,
             e.first_name,
             e.last_name,
             d.name AS department,
             to_char(te.clock_in,'MM/DD/YYYY') AS work_date,
             to_char(te.clock_in,'HH12:MI AM') AS clock_in,
             CASE WHEN te.clock_out IS NULL THEN '' ELSE to_char(te.clock_out,'HH12:MI AM') END AS clock_out,
             ROUND((EXTRACT(EPOCH FROM (COALESCE(te.clock_out,NOW())-te.clock_in))/3600)::numeric,2) AS hours_worked,
             COALESCE(ppa.status,'pending') AS timecard_status
           FROM time_entries te
           JOIN employees e ON e.id=te.employee_id
           LEFT JOIN departments d ON d.id=e.department_id
           LEFT JOIN pay_period_approvals ppa
             ON ppa.employee_id=e.id
            AND ppa.pay_period_start=$1::date
            AND ppa.pay_period_end=$2::date
           WHERE te.deleted_at IS NULL
             AND te.clock_in >= $1::date
             AND te.clock_in < ($2::date + INTERVAL '1 day')
           ORDER BY d.name,e.last_name,te.clock_in`,
          [period.pay_period_start, period.pay_period_end],
        );
        return res.json(result.rows);
      } catch (err) {
        console.error(err);
        return res.status(err.statusCode || 500).json({ error: err.message || 'Payroll export error' });
      }
    },
  );

  router.get(
    '/payroll/print-timecards',
    requireUser,
    requireAnyPermission('view_payroll_records', 'view_payroll_reports', 'export_payroll'),
    async (req, res) => {
      try {
        const period = await getRequestedPayPeriod(req);
        const result = await pool.query(
          `SELECT
             e.id AS employee_id,
             e.employee_number,
             e.first_name,
             e.last_name,
             d.name AS department,
             ppa.status AS approval_status,
             ppa.employee_signed_at,
             ppa.supervisor_approved_at,
             te.id AS time_entry_id,
             to_char(te.clock_in,'MM/DD/YYYY') AS work_date,
             to_char(te.clock_in,'HH12:MI AM') AS clock_in,
             CASE WHEN te.clock_out IS NULL THEN '' ELSE to_char(te.clock_out,'HH12:MI AM') END AS clock_out,
             ROUND((EXTRACT(EPOCH FROM (COALESCE(te.clock_out,NOW())-te.clock_in))/3600)::numeric,2) AS hours_worked
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
           WHERE (
             e.active=TRUE
             OR ppa.id IS NOT NULL
             OR EXISTS (
               SELECT 1
               FROM time_entries period_te
               WHERE period_te.employee_id=e.id
                 AND period_te.deleted_at IS NULL
                 AND period_te.clock_in >= $1::date
                 AND period_te.clock_in < ($2::date + INTERVAL '1 day')
             )
           )
           ORDER BY d.name,e.last_name,e.first_name,te.clock_in`,
          [period.pay_period_start, period.pay_period_end],
        );
        return res.json({
          pay_period_start: period.pay_period_start,
          pay_period_end: period.pay_period_end,
          rows: result.rows,
        });
      } catch (err) {
        console.error(err);
        return res.status(err.statusCode || 500).json({ error: err.message || 'Print timecards error' });
      }
    },
  );

  return router;
}

module.exports = { createPayrollRouter };
