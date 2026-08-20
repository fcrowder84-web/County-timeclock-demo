function renderTimecard(){
  const data=currentData,employee=data.employee||currentUser,entries=data.entries||[],start=dateOnly(data.pay_period_start||selectedPeriodStart),summary=data.timecard_summary||{weeks:[],period:{}};
  const days=Array.from({length:14},(_,i)=>{const date=addDays(start,i),dayEntries=entries.filter(e=>dateOnly(e.entry_date_iso||e.clock_in)===date);return{date,entries:dayEntries,worked:dailyWorked(dayEntries)}}),allocated=allocateDailyWork(days);
  let html="";
  days.forEach((d,i)=>{
    const leavePresent=(data.leave_entries||[]).some(l=>dateOnly(l.leave_date_iso||l.leave_date)===d.date&&l.status!=="denied"),work=allocated[d.date]||{regular:0,ot:0},approvedLeave=["holiday","vacation","sick","floating_holiday","other"].reduce((a,t)=>a+approvedLeaveHours(d.date,t),0),dailyTotal=d.worked+approvedLeave;
    const employeeCanModify=currentMode==="employee"&&data.can_edit_entries!==false;
    const elevatedCanModify=currentMode==="supervisor"&&data.can_edit_entries===true;
    const punchEnabled=elevatedCanModify&&canAddEntries();
    const leaveEnabled=(employeeCanModify&&selectedIsSelf())||elevatedCanModify;
    html+=`<tr class="${leavePresent?"leave-day":""}"><td class="left"><div class="datecell"><button class="icon-button day-punch" data-date="${d.date}" ${punchEnabled?"":"disabled"} title="${punchEnabled?"Add punch entry":"Select an existing punch for available actions"}">${punchSvg}</button><button class="icon-button leave day-leave" data-date="${d.date}" ${leaveEnabled?"":"disabled"} title="Add leave">${leaveSvg}</button><span class="date-label"><strong>${esc(dayName(d.date))}</strong> ${esc(localDateLabel(d.date))}</span></div></td>${punchCells(d.date,d.entries)}<td>${fmt(work.regular)}</td><td>${fmt(work.ot)}</td>${leaveCell(d.date,"holiday")}${leaveCell(d.date,"vacation")}${leaveCell(d.date,"sick")}${leaveCell(d.date,"floating_holiday")}${leaveCell(d.date,"other")}<td><strong>${fmt(dailyTotal)}</strong></td></tr>`;
    if(i===6)html+=totalRow("Week 1 Total",summary.weeks?.[0],"week-total");
    if(i===13)html+=totalRow("Week 2 Total",summary.weeks?.[1],"week-total");
  });
  html+=totalRow("Pay Period Total",summary.period,"period-total");document.getElementById("timeRows").innerHTML=html;
  document.getElementById("employeeNumber").textContent=employee.employee_number||"—";document.getElementById("departmentName").textContent=employee.department_name||employee.department||"—";document.getElementById("timecardStatus").textContent=statusLabel(data.approval);document.getElementById("workedRule").textContent=`${fmt(summary.period?.total_worked_hours)||"0.00"} worked / OT after ${fmt(summary.overtime_threshold_hours)||"40.00"} worked hrs/week`;document.getElementById("periodLabel").textContent=`${localDateLabel(data.pay_period_start)} – ${localDateLabel(data.pay_period_end)}`;document.getElementById("modeLabel").textContent=currentMode==="supervisor"?`Viewing as ${payrollView()?"Payroll / Admin":"Supervisor"}`:"Viewing your own timecard";
  renderSignatures();renderPending();bindRowActions();syncNavButtons();
}
function statusLabel(a){if(!a)return"In Progress";return({open:"In Progress",employee_submitted:"Employee Submitted",returned_to_employee:"Returned to Employee",supervisor_approved:"Supervisor Approved",payroll_finalized:"Payroll Finalized"})[a.status]||String(a.status||"In Progress").replaceAll("_"," ")}
function renderSignatures(){
  const a=currentData.approval,e=currentData.employee||currentUser;
  document.getElementById("employeeSignature").textContent=a?.employee_signed_at?`${e.first_name} ${e.last_name} — ${localDateTime(a.employee_signed_at)}`:"Not signed";
  document.getElementById("supervisorSignature").textContent=a?.supervisor_approved_at?`${a.supervisor_first_name&&a.supervisor_last_name?`${a.supervisor_first_name} ${a.supervisor_last_name} — `:""}${localDateTime(a.supervisor_approved_at)}`:(a?.employee_signed_at?"Waiting for supervisor":"Waiting for employee");
  document.getElementById("payrollSignature").textContent=a?.payroll_finalized_at?`${a.payroll_first_name&&a.payroll_last_name?`${a.payroll_first_name} ${a.payroll_last_name} — `:""}${localDateTime(a.payroll_finalized_at)}`:"Not finalized";
  const empBtn=document.getElementById("employeeSignBtn");empBtn.classList.toggle("hidden",!(currentMode==="employee"&&selectedIsSelf()&&has("submit_timecard")&&currentData.can_edit_entries!==false));
  const supBtn=document.getElementById("supervisorSignBtn");supBtn.classList.toggle("hidden",!(currentMode==="supervisor"&&has("approve_timecard")&&a?.status==="employee_submitted"&&!a?.supervisor_approved_at));
  const ret=document.getElementById("returnBtn");ret.classList.toggle("hidden",!(currentMode==="supervisor"&&canReturn()&&a));
  const payrollLink=document.getElementById("payrollLink");payrollLink.classList.toggle("hidden",!payrollView());payrollLink.href=`/payroll.html?employeeId=${encodeURIComponent(selectedEmployeeId)}&periodStart=${encodeURIComponent(selectedPeriodStart||"")}`;
}
function pendingItems(){
  const start=dateOnly(currentData.pay_period_start),end=dateOnly(currentData.pay_period_end);
  const leave=(currentData.leave_entries||[]).filter(l=>l.status==="pending").map(l=>({type:"leave",id:l.id,text:`${localDateLabel(l.leave_date_iso||l.leave_date)} — ${String(l.leave_type).replaceAll("_"," ")} ${num(l.hours).toFixed(2)} hrs`}));
  const changes=(currentData.change_requests||currentData.requests||[]).filter(r=>r.status==="pending").filter(r=>{const d=dateOnly(r.requested_clock_in||r.created_at);return !d||(d>=start&&d<=end)}).map(r=>({type:"change",id:r.id,text:`Punch change request${r.created_at_display?` — ${r.created_at_display}`:""}`}));
  return [...leave,...changes];
}
function renderPending(){
  const items=pendingItems(),panel=document.getElementById("pendingPanel"),list=document.getElementById("pendingList");panel.classList.toggle("show",items.length>0);document.getElementById("pendingLegend").textContent=items.length?`${items.length} pending item${items.length===1?"":"s"}`:"";
  list.innerHTML=items.map(i=>`<div class="pending-item"><span>${esc(i.text)}</span>${currentMode==="supervisor"?(i.type==="leave"&&hasAny(["approve_timecard","edit_employee_time","edit_payroll_time","app_admin"])?`<span><button class="btn pending-leave-review" data-id="${Number(i.id)}" data-status="approved">Approve</button><button class="btn pending-leave-review" data-id="${Number(i.id)}" data-status="denied">Deny</button></span>`:i.type==="change"&&has("approve_punch_correction")?`<span><button class="btn pending-change-review" data-id="${Number(i.id)}" data-status="approved">Approve</button><button class="btn pending-change-review" data-id="${Number(i.id)}" data-status="denied">Deny</button></span>`:""):""}</div>`).join("");
  list.querySelectorAll(".pending-leave-review").forEach(b=>b.addEventListener("click",()=>reviewLeave(b.dataset.id,b.dataset.status)));
  list.querySelectorAll(".pending-change-review").forEach(b=>b.addEventListener("click",()=>reviewChange(b.dataset.id,b.dataset.status)));
}
function bindRowActions(){
  document.querySelectorAll(".punch").forEach(el=>el.addEventListener("click",ev=>openPunchMenu(ev,Number(el.dataset.entryId),el.dataset.kind)));
  document.querySelectorAll(".day-punch:not(:disabled)").forEach(b=>b.addEventListener("click",()=>openAddEntry(b.dataset.date)));
  document.querySelectorAll(".day-leave:not(:disabled)").forEach(b=>b.addEventListener("click",()=>openLeave(b.dataset.date)));
}
function findEntry(id){return(currentData.entries||[]).find(e=>Number(e.id)===Number(id))}
function openPunchMenu(ev,id,kind){
  const entry=findEntry(id);if(!entry)return;activeEntry={...entry,clickedKind:kind};const menu=document.getElementById("contextMenu");let buttons=[];
  if(currentMode==="employee"&&selectedIsSelf()&&currentData.can_edit_entries!==false){if(has("request_punch_correction"))buttons.push(["Request Change","request"]);buttons.push(["Delete Punch","delete"])}
  if(currentMode==="supervisor"&&currentData.can_edit_entries===true){if(hasAny(["edit_employee_time","edit_payroll_time"]))buttons.push(["Edit","edit"]);buttons.push(["Delete","delete"])}
  if(!buttons.length)buttons=[["View only","none"]];
  menu.innerHTML=buttons.map(([label,action])=>`<button data-action="${action}">${esc(label)}</button>`).join("");menu.querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>handlePunchAction(b.dataset.action)));const x=Math.min(ev.clientX,innerWidth-180),y=Math.min(ev.clientY+8,innerHeight-160);menu.style.left=x+"px";menu.style.top=y+"px";menu.style.display="block";ev.stopPropagation()
}
function closeMenu(){document.getElementById("contextMenu").style.display="none"}document.addEventListener("click",closeMenu);
function handlePunchAction(action){closeMenu();if(action==="request")openEntryModal("request",activeEntry);if(action==="edit")openEntryModal("edit",activeEntry);if(action==="delete")deleteEntry(activeEntry)}
function modal(id,show){document.getElementById(id).classList.toggle("show",show)}document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>modal(b.dataset.close,false)));

function entryDateFromIso(v){return dateOnly(v)}
function openEntryModal(mode,entry){
  entryModalMode=mode;activeEntry=entry;document.getElementById("entryModalTitle").textContent=mode==="request"?"Request Punch Change":mode==="edit"?"Edit Punch Entry":"Add Punch Entry";const inDate=entry?entryDateFromIso(entry.clock_in):dateOnly(currentData.pay_period_start),outDate=entry?.clock_out?entryDateFromIso(entry.clock_out):inDate;document.getElementById("entryInDate").value=inDate;document.getElementById("entryInTime").value=entry?entryIn24(entry).slice(0,5):"08:00";document.getElementById("entryOutDate").value=outDate;document.getElementById("entryOutTime").value=entry?.clock_out?entryOut24(entry).slice(0,5):"";document.getElementById("entryReason").value="";if(mode==="request"&&entry?.clickedKind==="in"){document.getElementById("entryOutDate").value="";document.getElementById("entryOutTime").value=""}if(mode==="request"&&entry?.clickedKind==="out"){document.getElementById("entryInDate").value="";document.getElementById("entryInTime").value=""}modal("entryModal",true)
}
function openAddEntry(day){entryModalMode="add";activeEntry=null;document.getElementById("entryModalTitle").textContent="Add Punch Entry";document.getElementById("entryInDate").value=day;document.getElementById("entryInTime").value="08:00";document.getElementById("entryOutDate").value=day;document.getElementById("entryOutTime").value="";document.getElementById("entryReason").value="";modal("entryModal",true)}
function timestamp(date,time){return date&&time?`${date} ${time}:00`:null}
document.getElementById("entrySubmitBtn").addEventListener("click",async()=>{
  const inDate=document.getElementById("entryInDate").value,inTime=document.getElementById("entryInTime").value,outDate=document.getElementById("entryOutDate").value,outTime=document.getElementById("entryOutTime").value,reason=document.getElementById("entryReason").value.trim();
  try{
    if(entryModalMode==="request"){
      if(!reason)throw new Error("Reason is required");const body={time_entry_id:activeEntry.id,employee_reason:reason,requested_clock_in:timestamp(inDate,inTime),requested_clock_out:timestamp(outDate,outTime)};if(!body.requested_clock_in&&!body.requested_clock_out)throw new Error("Select a clock in time, clock out time, or both");await jsonOrError(await apiFetch(`${apiBase}/employee/request-time-change`,{method:"POST",body:JSON.stringify(body)}));showMessage("Time change request submitted")
    }else if(entryModalMode==="edit"){
      if(!reason)throw new Error("Reason is required");const body={time_entry_id:activeEntry.id,new_clock_in:timestamp(inDate,inTime),new_clock_out:timestamp(outDate,outTime),reason};await jsonOrError(await apiFetch(`${apiBase}/supervisor/edit-time-entry`,{method:"POST",body:JSON.stringify(body)}));showMessage("Time entry updated")
    }else if(entryModalMode==="add"){
      if(!reason)throw new Error("Reason is required");const body={employee_id:selectedEmployeeId,clock_in:timestamp(inDate,inTime),clock_out:timestamp(outDate,outTime),reason};await jsonOrError(await apiFetch(`${apiBase}/supervisor/add-time-entry`,{method:"POST",body:JSON.stringify(body)}));showMessage("Time entry added")
    }
    modal("entryModal",false);await loadTimecard()
  }catch(err){showMessage(err.message,"error")}
});
async function deleteEntry(entry){
  const reason=prompt("Reason for deleting this punch entry:");if(!reason)return;try{await jsonOrError(await apiFetch(`${apiBase}/delete-punch`,{method:"POST",body:JSON.stringify({time_entry_id:entry.id,reason})}));showMessage("Punch deleted. Original record remains in the audit trail.");await loadTimecard()}catch(err){showMessage(err.message,"error")}
}
function openLeave(day){document.getElementById("leaveDate").value=day;document.getElementById("leaveType").value="vacation";document.getElementById("leaveHours").value="8";document.getElementById("leaveNote").value="";modal("leaveModal",true)}
document.getElementById("leaveSubmitBtn").addEventListener("click",()=>submitLeave(false));
async function submitLeave(override){
  const date=document.getElementById("leaveDate").value,type=document.getElementById("leaveType").value,hours=Number(document.getElementById("leaveHours").value),note=document.getElementById("leaveNote").value.trim();const body={employee_id:selectedEmployeeId,start_date:date,end_date:date,leave_type:type,hours,note};if(override){body.override_daily_hours=true;body.override_reason=prompt("Reason for exceeding the normal daily paid-hours warning:")||""}
  try{await jsonOrError(await apiFetch(`${apiBase}/leave`,{method:"POST",body:JSON.stringify(body)}));modal("leaveModal",false);showMessage(selectedIsSelf()&&currentMode==="employee"?"Leave submitted for approval":"Leave added");await loadTimecard()}catch(err){if(err.status===409&&err.data?.requires_confirmation&&!override){if(confirm(`${err.message}\n\nSubmit anyway for supervisor review?`))return submitLeave(true)}showMessage(err.message,"error")}
}
async function reviewLeave(id,status){const note=status==="denied"?(prompt("Reason for denying leave:")||""):"";try{await jsonOrError(await apiFetch(`${apiBase}/leave/${id}/review`,{method:"POST",body:JSON.stringify({status,review_note:note})}));showMessage(`Leave ${status}`);await loadTimecard()}catch(err){showMessage(err.message,"error")}}
async function reviewChange(id,status){const note=prompt(`Supervisor note for ${status==="approved"?"approval":"denial"} (optional):`)||"";const path=status==="approved"?"approve-change-request":"deny-change-request";try{await jsonOrError(await apiFetch(`${apiBase}/supervisor/${path}`,{method:"POST",body:JSON.stringify({request_id:Number(id),supervisor_note:note})}));showMessage(`Change request ${status}`);await loadTimecard()}catch(err){showMessage(err.message,"error")}}

document.getElementById("employeeSignBtn").addEventListener("click",async()=>{if(!confirm("Sign and submit this timecard to your supervisor?"))return;try{await jsonOrError(await apiFetch(`${apiBase}/submit-timecard`,{method:"POST",body:"{}"}));showMessage("Timecard submitted");await loadTimecard()}catch(err){showMessage(err.message,"error")}});
document.getElementById("supervisorSignBtn").addEventListener("click",async()=>{if(!confirm("Approve and sign this employee timecard?"))return;try{await jsonOrError(await apiFetch(`${apiBase}/supervisor/approve-timecard`,{method:"POST",body:JSON.stringify({employee_id:selectedEmployeeId})}));showMessage("Timecard approved");await loadTimecard()}catch(err){showMessage(err.message,"error")}});
document.getElementById("returnBtn").addEventListener("click",async()=>{const note=prompt("Reason for returning this timecard:");if(note===null)return;const target=payrollView()&&currentData.approval?.status==="supervisor_approved"&&confirm("Return to supervisor review instead of returning all the way to the employee?\n\nOK = Supervisor, Cancel = Employee")?"supervisor":"employee";try{await jsonOrError(await apiFetch(`${apiBase}/supervisor/return-timecard`,{method:"POST",body:JSON.stringify({employee_id:selectedEmployeeId,supervisor_note:note,target_stage:target})}));showMessage(target==="supervisor"?"Returned to supervisor review":"Returned to employee");await loadTimecard()}catch(err){showMessage(err.message,"error")}});

async function refreshQuickPunch(){
  const btn=document.getElementById("quickPunchBtn");if(!selectedIsSelf()||!has("clock_in_out")){btn.classList.add("hidden");return}try{const s=await jsonOrError(await apiFetch(`${apiBase}/quick-status`));btn.classList.remove("hidden");btn.dataset.action=s.next_action;btn.dataset.entryId=s.current_entry_id||"";const stale=Boolean(s.requires_correction)||(s.current_clock_in&&(dateOnly(s.current_clock_in)<new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"})||Date.now()-new Date(s.current_clock_in).getTime()>=23*3600000));btn.dataset.stale=stale?"1":"0";btn.textContent=stale?"Correct Missing Punch":(s.next_action==="clock_out"?"Click Here to Clock Out":"Click Here to Clock In")}catch(_){btn.classList.add("hidden")}
}
function freshLocation(){
  return new Promise(resolve=>{
    if(!navigator.geolocation){resolve({location_status:"unavailable"});return}
    navigator.geolocation.getCurrentPosition(
      pos=>resolve({location_status:"captured",latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracy_meters:pos.coords.accuracy}),
      err=>resolve({location_status:err.code===1?"denied":err.code===3?"timeout":"error"}),
      {enableHighAccuracy:true,maximumAge:0,timeout:12000}
    )
  })
}
document.getElementById("quickPunchBtn").addEventListener("click",async()=>{
  const btn=document.getElementById("quickPunchBtn");if(btn.dataset.stale==="1"){const open=(currentData.entries||[]).find(e=>!e.clock_out);if(open){activeEntry={...open,clickedKind:"out"};openEntryModal("request",activeEntry);showMessage("This older open punch must be corrected and approved before another normal punch.","warning");return}showMessage("Open the missing punch on the timecard and request a correction.","warning");return}
  const action=btn.dataset.action;if(!action)return;
  btn.disabled=true;const prior=btn.textContent;btn.textContent="Getting current location…";
  try{
    const location=await freshLocation();
    const data=await jsonOrError(await apiFetch(`${apiBase}/${action==="clock_out"?"clock-out":"clock-in"}`,{method:"POST",body:JSON.stringify({...location,client_source:"timecard_web"})}));
    showMessage(data.message||"Punch recorded");await loadTimecard()
  }catch(err){
    if(err.data?.code==="STALE_OPEN_PUNCH"){await loadTimecard();showMessage(err.message,"warning")}
    else showMessage(err.message,"error")
  }finally{btn.disabled=false;if(!currentData)btn.textContent=prior}
});
document.getElementById("logoutBtn").addEventListener("click",()=>location.href="/global-logout.html");
init();
