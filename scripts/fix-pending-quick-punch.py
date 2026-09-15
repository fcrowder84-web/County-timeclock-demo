#!/usr/bin/env python3
from pathlib import Path

p = Path(__file__).resolve().parents[1] / 'backend/routes/quick-punch.js'
text = p.read_text()

old_status = """              AND clock_out IS NULL
            ORDER BY clock_in DESC"""
new_status = """              AND clock_out IS NULL
              AND pending_clock_out IS NULL
            ORDER BY clock_in DESC"""

old_action = """          WHERE employee_id=$1 AND deleted_at IS NULL AND clock_out IS NULL
          ORDER BY clock_in DESC LIMIT 1"""
new_action = """          WHERE employee_id=$1
            AND deleted_at IS NULL
            AND clock_out IS NULL
            AND pending_clock_out IS NULL
          ORDER BY clock_in DESC LIMIT 1"""

if old_status in text:
    text = text.replace(old_status, new_status, 1)
elif new_status not in text:
    raise SystemExit('quick-status open-punch query target not found')

count = text.count(old_action)
if count:
    text = text.replace(old_action, new_action)
elif text.count('AND pending_clock_out IS NULL') < 3:
    raise SystemExit('clock-in/clock-out open-punch query targets not found')

text = text.replace(
    'Your previous open punch must be corrected and approved before you can punch again.',
    'Your previous open punch must have a correction request submitted before you can punch again.',
)

p.write_text(text)
print('Fixed quick-status, clock-in, and clock-out to ignore provisionally closed punches.')
