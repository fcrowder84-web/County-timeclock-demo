'use strict';

// The caller owns the employee/directory transaction. Organizational assignment
// never changes application roles, permission checkboxes, or supervisor links.
async function syncOrganizationalDepartmentHead(client,employeeId,departmentId,isHead){
  if(typeof isHead!=='boolean'){
    throw new Error('Portal is_department_head must be a boolean');
  }
  if(!employeeId||!departmentId) throw new Error('Department Head sync requires an employee and department');

  // Serialize replacements for the department before touching its unique active
  // head relationship. A failure rolls back with the employee and cap history.
  await client.query('SELECT id FROM departments WHERE id=$1 FOR UPDATE',[departmentId]);
  await client.query(
    `UPDATE department_heads SET active=FALSE
      WHERE employee_id=$1 AND active=TRUE
        AND (department_id<>$2 OR $3::boolean=FALSE)`,
    [employeeId,departmentId,isHead],
  );
  if(!isHead) return;
  await client.query(
    `UPDATE department_heads SET active=FALSE
      WHERE department_id=$1 AND employee_id<>$2 AND active=TRUE`,
    [departmentId,employeeId],
  );
  await client.query(
    `INSERT INTO department_heads(department_id,employee_id,active,assigned_by,assigned_at)
     VALUES($1,$2,TRUE,NULL,NOW())
     ON CONFLICT(department_id,employee_id)
     DO UPDATE SET active=TRUE,assigned_by=NULL,assigned_at=NOW()
       WHERE department_heads.active=FALSE`,
    [departmentId,employeeId],
  );
}

module.exports={syncOrganizationalDepartmentHead};
