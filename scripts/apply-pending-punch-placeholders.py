#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def replace(path, old, new, count=None):
    p = ROOT / path
    text = p.read_text()
    found = text.count(old)
    if found == 0:
        if new in text:
            print(f"already patched: {path}")
            return
        raise SystemExit(f"patch target not found in {path}: {old[:80]!r}")
    if count is not None and found != count:
        raise SystemExit(f"unexpected target count in {path}: expected {count}, found {found}")
    p.write_text(text.replace(old, new))
    print(f"patched: {path} ({found} replacement(s))")

# Quick punch: a provisional pending clock-out closes the old interval for punch-state purposes.
replace(
    'backend/routes/quick-punch.js',
    "AND clock_out IS NULL\n            ORDER BY clock_in DESC",
    "AND clock_out IS NULL\n              AND pending_clock_out IS NULL\n            ORDER BY clock_in DESC",
)
replace(
    'backend/routes/quick-punch.js',
    "Your previous open punch must be corrected and approved before you can punch again.",
    "Your previous open punch must have a correction request submitted before you can punch again.",
)

# Employee timecard API: expose pending values and stop provisional hours from growing against NOW().
replace(
    'backend/routes/employee.js',
    "           clock_in,\n           clock_out,\n           to_char(clock_in, 'YYYY-MM-DD') AS entry_date_iso,",
    "           clock_in,\n           clock_out,\n           pending_clock_in,\n           pending_clock_out,\n           to_char(clock_in, 'YYYY-MM-DD') AS entry_date_iso,",
    1,
)
replace(
    'backend/routes/employee.js',
    "           CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out, 'HH12:MI AM') END AS clock_out_display,\n           CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out, 'HH24:MI') END AS clock_out_24,\n           ROUND((EXTRACT(EPOCH FROM (COALESCE(clock_out, NOW()) - clock_in)) / 3600)::numeric, 2) AS hours_worked",
    "           CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out, 'HH12:MI AM') END AS clock_out_display,\n           CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out, 'HH24:MI') END AS clock_out_24,\n           CASE WHEN pending_clock_in IS NULL THEN NULL ELSE to_char(pending_clock_in, 'HH12:MI AM') END AS pending_clock_in_display,\n           CASE WHEN pending_clock_out IS NULL THEN NULL ELSE to_char(pending_clock_out, 'HH12:MI AM') END AS pending_clock_out_display,\n           ROUND((EXTRACT(EPOCH FROM (COALESCE(clock_out, pending_clock_out, NOW()) - COALESCE(clock_in, pending_clock_in))) / 3600)::numeric, 2) AS hours_worked",
    1,
)

# When an employee submits a correction for a genuinely missing endpoint, store it as the provisional placeholder.
old = """        const inserted = await pool.query(\n          `INSERT INTO time_change_requests(\n             employee_id,time_entry_id,requested_clock_in,requested_clock_out,employee_reason,status\n           ) VALUES($1,$2,$3,$4,$5,'pending')\n           RETURNING id`,\n          [req.user.id, entryId, requestedClockIn, requestedClockOut, reason],\n        );"""
new = """        const client = await pool.connect();\n        let inserted;\n        try {\n          await client.query('BEGIN');\n          inserted = await client.query(\n            `INSERT INTO time_change_requests(\n               employee_id,time_entry_id,requested_clock_in,requested_clock_out,employee_reason,status\n             ) VALUES($1,$2,$3,$4,$5,'pending')\n             RETURNING id`,\n            [req.user.id, entryId, requestedClockIn, requestedClockOut, reason],\n          );\n\n          if (entry && entry.clock_out == null && requestedClockOut) {\n            await client.query(\n              `UPDATE time_entries\n                  SET pending_clock_out=$1::timestamp\n                WHERE id=$2 AND employee_id=$3 AND deleted_at IS NULL AND clock_out IS NULL`,\n              [requestedClockOut, entry.id, req.user.id],\n            );\n          }\n          if (entry && entry.clock_in == null && requestedClockIn) {\n            await client.query(\n              `UPDATE time_entries\n                  SET pending_clock_in=$1::timestamp\n                WHERE id=$2 AND employee_id=$3 AND deleted_at IS NULL AND clock_in IS NULL`,\n              [requestedClockIn, entry.id, req.user.id],\n            );\n          }\n          await client.query('COMMIT');\n        } catch (err) {\n          await client.query('ROLLBACK').catch(() => {});\n          throw err;\n        } finally {\n          client.release();\n        }"""
replace('backend/routes/employee.js', old, new, 1)

# Approval promotes provisional values into the approved columns and clears the placeholders.
replace(
    'backend/routes/supervisor.js',
    "                SET clock_in=$1,\n                    clock_out=$2,\n                    status=CASE WHEN $2::timestamp IS NULL THEN 'open' ELSE 'closed' END",
    "                SET clock_in=$1,\n                    clock_out=$2,\n                    pending_clock_in=NULL,\n                    pending_clock_out=NULL,\n                    status=CASE WHEN $2::timestamp IS NULL THEN 'open' ELSE 'closed' END",
    1,
)

# Supervisor timecard API also exposes provisional values and uses them for provisional duration.
replace(
    'backend/routes/supervisor.js',
    "               id,clock_in,clock_out,\n               to_char(clock_in,'YYYY-MM-DD') AS entry_date_iso,",
    "               id,clock_in,clock_out,pending_clock_in,pending_clock_out,\n               to_char(clock_in,'YYYY-MM-DD') AS entry_date_iso,",
    1,
)
replace(
    'backend/routes/supervisor.js',
    "               CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out,'HH12:MI AM') END AS clock_out_time,\n               CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out,'HH24:MI') END AS clock_out_time_24,\n               CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out,'YYYY-MM-DD') END AS clock_out_date_iso,\n               ROUND((EXTRACT(EPOCH FROM (COALESCE(clock_out,NOW())-clock_in))/3600)::numeric,2) AS hours_worked",
    "               CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out,'HH12:MI AM') END AS clock_out_time,\n               CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out,'HH24:MI') END AS clock_out_time_24,\n               CASE WHEN clock_out IS NULL THEN NULL ELSE to_char(clock_out,'YYYY-MM-DD') END AS clock_out_date_iso,\n               CASE WHEN pending_clock_in IS NULL THEN NULL ELSE to_char(pending_clock_in,'HH12:MI AM') END AS pending_clock_in_time,\n               CASE WHEN pending_clock_out IS NULL THEN NULL ELSE to_char(pending_clock_out,'HH12:MI AM') END AS pending_clock_out_time,\n               ROUND((EXTRACT(EPOCH FROM (COALESCE(clock_out,pending_clock_out,NOW())-COALESCE(clock_in,pending_clock_in)))/3600)::numeric,2) AS hours_worked",
    1,
)

# Employee UI: A = Awaiting Approval, shown in red.
replace(
    'frontend/employee.html',
    "                        <td>${entry.clock_in_display}</td>\n                        <td>\n    ${\n                    entry.clock_out_display\n                    || '<span style=\"color:red;font-weight:bold;\">MISSED CLOCK OUT</span>'\n    }\n</td>",
    "                        <td>${entry.pending_clock_in_display ? `<span style=\"color:#c0392b;font-weight:bold;\" title=\"Awaiting supervisor approval\">A${entry.pending_clock_in_display}</span>` : entry.clock_in_display}</td>\n                        <td>\n    ${\n                    entry.pending_clock_out_display\n                    ? `<span style=\"color:#c0392b;font-weight:bold;\" title=\"Awaiting supervisor approval\">A${entry.pending_clock_out_display}</span>`\n                    : (entry.clock_out_display || '<span style=\"color:red;font-weight:bold;\">MISSED CLOCK OUT</span>')\n    }\n</td>",
    1,
)

print('Pending punch placeholder patch complete.')
