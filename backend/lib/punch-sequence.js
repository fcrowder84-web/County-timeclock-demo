'use strict';

function parsePunchTimestamp(value) {
  const parsed = new Date(value);
  if (!value || Number.isNaN(parsed.getTime())) {
    const error = new Error('Valid punch date and time are required');
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function sameTimestamp(a, b) {
  return new Date(a).getTime() === new Date(b).getTime();
}

async function insertPunchIntoSequence({
  client,
  employeeId,
  punchAt,
  actorEmployeeId,
  reason,
  ignoreRequestId = null,
}) {
  const parsedPunch = parsePunchTimestamp(punchAt);

  const duplicate = await client.query(
    `SELECT id
       FROM time_entries
      WHERE employee_id=$1
        AND deleted_at IS NULL
        AND (clock_in=$2::timestamp OR clock_out=$2::timestamp)
      LIMIT 1`,
    [employeeId, punchAt],
  );
  if (duplicate.rows.length) {
    const error = new Error('That punch already exists');
    error.statusCode = 409;
    throw error;
  }

  const entriesResult = await client.query(
    `SELECT *
       FROM time_entries
      WHERE employee_id=$1
        AND deleted_at IS NULL
        AND clock_in::date=$2::timestamp::date
      ORDER BY clock_in,id
      FOR UPDATE`,
    [employeeId, punchAt],
  );
  const entries = entriesResult.rows;

  if (entries.length) {
    const entryIds = entries.map((row) => Number(row.id));
    const linkedPending = await client.query(
      `SELECT id
         FROM time_change_requests
        WHERE employee_id=$1
          AND status='pending'
          AND time_entry_id=ANY($2::int[])
          AND ($3::int IS NULL OR id<>$3::int)
        LIMIT 1`,
      [employeeId, entryIds, ignoreRequestId],
    );
    if (linkedPending.rows.length) {
      const error = new Error('Resolve the other pending punch correction on this date before inserting another punch');
      error.statusCode = 409;
      throw error;
    }
  }

  const events = [];
  for (const entry of entries) {
    events.push({ timestamp: entry.clock_in, source_entry_id: Number(entry.id), source_kind: 'clock_in' });
    if (entry.clock_out) {
      events.push({ timestamp: entry.clock_out, source_entry_id: Number(entry.id), source_kind: 'clock_out' });
    }
  }
  events.push({ timestamp: punchAt, source_entry_id: null, source_kind: 'inserted' });
  events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  for (let i = 1; i < events.length; i += 1) {
    if (sameTimestamp(events[i - 1].timestamp, events[i].timestamp)) {
      const error = new Error('That punch already exists');
      error.statusCode = 409;
      throw error;
    }
  }

  const insertedIndex = events.findIndex((event) => event.source_kind === 'inserted');
  const inferredPunchType = insertedIndex % 2 === 0 ? 'clock_in' : 'clock_out';
  const desired = [];
  for (let i = 0; i < events.length; i += 2) {
    desired.push({
      clock_in: events[i].timestamp,
      clock_out: events[i + 1]?.timestamp || null,
    });
  }

  // An existing open row is always the last row. If adding the missing punch
  // makes the event count even, close that row first so the one-open-punch
  // unique index cannot be violated transiently while the day is rebuilt.
  const existingOpenIndex = entries.findIndex((row) => !row.clock_out);
  const updateOrder = [];
  if (existingOpenIndex >= 0) updateOrder.push(existingOpenIndex);
  for (let i = 0; i < entries.length; i += 1) {
    if (i !== existingOpenIndex) updateOrder.push(i);
  }

  for (const i of updateOrder) {
    const oldRow = entries[i];
    const next = desired[i];
    if (!next) continue;
    const changed = !sameTimestamp(oldRow.clock_in, next.clock_in)
      || Boolean(oldRow.clock_out) !== Boolean(next.clock_out)
      || (oldRow.clock_out && next.clock_out && !sameTimestamp(oldRow.clock_out, next.clock_out));
    if (!changed) continue;

    await client.query(
      `INSERT INTO time_entry_audit(
         time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,
         new_clock_in,new_clock_out,reason
       ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [oldRow.id, actorEmployeeId, oldRow.clock_in, oldRow.clock_out, next.clock_in, next.clock_out, reason],
    );
    await client.query(
      `UPDATE time_entries
          SET clock_in=$1,
              clock_out=$2,
              status=CASE WHEN $2::timestamp IS NULL THEN 'open' ELSE 'closed' END
        WHERE id=$3
          AND deleted_at IS NULL`,
      [next.clock_in, next.clock_out, oldRow.id],
    );
  }

  for (let i = entries.length; i < desired.length; i += 1) {
    const next = desired[i];
    const inserted = await client.query(
      `INSERT INTO time_entries(employee_id,clock_in,clock_out,notes,status)
       VALUES($1,$2,$3,$4,CASE WHEN $3::timestamp IS NULL THEN 'open' ELSE 'closed' END)
       RETURNING *`,
      [employeeId, next.clock_in, next.clock_out, reason],
    );
    await client.query(
      `INSERT INTO time_entry_audit(
         time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,
         new_clock_in,new_clock_out,reason
       ) VALUES($1,$2,NULL,NULL,$3,$4,$5)`,
      [inserted.rows[0].id, actorEmployeeId, next.clock_in, next.clock_out, reason],
    );
  }

  const rebuilt = await client.query(
    `SELECT *
       FROM time_entries
      WHERE employee_id=$1
        AND deleted_at IS NULL
        AND clock_in::date=$2::timestamp::date
      ORDER BY clock_in,id`,
    [employeeId, punchAt],
  );

  return {
    inferred_punch_type: inferredPunchType,
    inserted_index: insertedIndex,
    events,
    entries: rebuilt.rows,
  };
}


async function removePunchFromSequence({ client, employeeId, timeEntryId, punchKind, actorEmployeeId, reason }) {
  const targetResult = await client.query(
    `SELECT * FROM time_entries WHERE id=$1 AND employee_id=$2 AND deleted_at IS NULL LIMIT 1 FOR UPDATE`,
    [timeEntryId, employeeId],
  );
  const target = targetResult.rows[0] || null;
  if (!target) { const error=new Error('Time entry not found'); error.statusCode=404; throw error; }
  const removeAt = punchKind === 'out' ? target.clock_out : target.clock_in;
  if (!removeAt) { const error=new Error('Selected punch does not exist'); error.statusCode=409; throw error; }

  const entriesResult = await client.query(
    `SELECT * FROM time_entries WHERE employee_id=$1 AND deleted_at IS NULL AND clock_in::date=$2::timestamp::date ORDER BY clock_in,id FOR UPDATE`,
    [employeeId, removeAt],
  );
  const entries=entriesResult.rows;
  const events=[];
  for (const entry of entries) {
    events.push({timestamp:entry.clock_in,source_entry_id:Number(entry.id),source_kind:'in'});
    if(entry.clock_out) events.push({timestamp:entry.clock_out,source_entry_id:Number(entry.id),source_kind:'out'});
  }
  const removeIndex=events.findIndex((event)=>Number(event.source_entry_id)===Number(timeEntryId)&&event.source_kind===punchKind&&sameTimestamp(event.timestamp,removeAt));
  if(removeIndex<0){const error=new Error('Punch could not be located in the day sequence');error.statusCode=409;throw error;}
  events.splice(removeIndex,1);
  events.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const desired=[];
  for(let i=0;i<events.length;i+=2) desired.push({clock_in:events[i].timestamp,clock_out:events[i+1]?.timestamp||null});

  // Retire surplus rows before rebuilding so an old open row cannot collide
  // with the one-open-punch unique index during the transaction.
  for(let i=desired.length;i<entries.length;i+=1){
    const oldRow=entries[i];
    await client.query(
      `INSERT INTO time_entry_audit(time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,new_clock_in,new_clock_out,reason) VALUES($1,$2,$3,$4,NULL,NULL,$5)`,
      [oldRow.id,actorEmployeeId,oldRow.clock_in,oldRow.clock_out,reason],
    );
    await client.query(
      `UPDATE time_entries SET deleted_at=NOW(),deleted_by_employee_id=$2,deletion_reason=$3 WHERE id=$1 AND deleted_at IS NULL`,
      [oldRow.id,actorEmployeeId,reason],
    );
  }
  for(let i=0;i<desired.length;i+=1){
    const oldRow=entries[i],next=desired[i];
    const changed=!sameTimestamp(oldRow.clock_in,next.clock_in)||Boolean(oldRow.clock_out)!==Boolean(next.clock_out)||(oldRow.clock_out&&next.clock_out&&!sameTimestamp(oldRow.clock_out,next.clock_out));
    if(!changed) continue;
    await client.query(
      `INSERT INTO time_entry_audit(time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,new_clock_in,new_clock_out,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [oldRow.id,actorEmployeeId,oldRow.clock_in,oldRow.clock_out,next.clock_in,next.clock_out,reason],
    );
    await client.query(
      `UPDATE time_entries SET clock_in=$1,clock_out=$2,status=CASE WHEN $2::timestamp IS NULL THEN 'open' ELSE 'closed' END WHERE id=$3 AND deleted_at IS NULL`,
      [next.clock_in,next.clock_out,oldRow.id],
    );
  }
  const rebuilt=await client.query(
    `SELECT * FROM time_entries WHERE employee_id=$1 AND deleted_at IS NULL AND clock_in::date=$2::timestamp::date ORDER BY clock_in,id`,
    [employeeId,removeAt],
  );
  return {removed_timestamp:removeAt,entries:rebuilt.rows};
}


async function replaceDayPunchSequence({ client, employeeId, workDate, punches, actorEmployeeId, reason }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(workDate || '')) || !Array.isArray(punches)) { const e=new Error('Valid work date and punch list are required'); e.statusCode=400; throw e; }
  const events=punches.map((v)=>({raw:String(v),date:parsePunchTimestamp(v)})).sort((a,b)=>a.date-b.date);
  for(let i=0;i<events.length;i+=1){ if(!events[i].raw.startsWith(workDate+' ')){const e=new Error('All punches must be on the selected work date');e.statusCode=400;throw e;} if(i&&events[i].date.getTime()===events[i-1].date.getTime()){const e=new Error('Duplicate punch times are not allowed');e.statusCode=409;throw e;} }
  const old=(await client.query(`SELECT * FROM time_entries WHERE employee_id=$1 AND deleted_at IS NULL AND clock_in::date=$2::date ORDER BY clock_in,id FOR UPDATE`,[employeeId,workDate])).rows;
  if(old.length){const pending=await client.query(`SELECT id FROM time_change_requests WHERE employee_id=$1 AND status='pending' AND time_entry_id=ANY($2::int[]) LIMIT 1`,[employeeId,old.map(r=>Number(r.id))]);if(pending.rows.length){const e=new Error('Resolve pending punch corrections on this date before editing the day');e.statusCode=409;throw e;}}
  for(const row of old){await client.query(`INSERT INTO time_entry_audit(time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,new_clock_in,new_clock_out,reason) VALUES($1,$2,$3,$4,NULL,NULL,$5)`,[row.id,actorEmployeeId,row.clock_in,row.clock_out,reason]);await client.query(`UPDATE time_entries SET deleted_at=NOW(),deleted_by_employee_id=$2,deletion_reason=$3 WHERE id=$1 AND deleted_at IS NULL`,[row.id,actorEmployeeId,reason]);}
  const created=[];for(let i=0;i<events.length;i+=2){const ci=events[i].date,co=events[i+1]?.date||null;const row=(await client.query(`INSERT INTO time_entries(employee_id,clock_in,clock_out,notes,status) VALUES($1,$2,$3,$4,CASE WHEN $3::timestamp IS NULL THEN 'open' ELSE 'closed' END) RETURNING *`,[employeeId,ci,co,reason])).rows[0];created.push(row);await client.query(`INSERT INTO time_entry_audit(time_entry_id,changed_by_employee_id,old_clock_in,old_clock_out,new_clock_in,new_clock_out,reason) VALUES($1,$2,NULL,NULL,$3,$4,$5)`,[row.id,actorEmployeeId,row.clock_in,row.clock_out,reason]);}
  return {entries:created,punch_count:events.length};
}

module.exports = { insertPunchIntoSequence, removePunchFromSequence, replaceDayPunchSequence, parsePunchTimestamp };
