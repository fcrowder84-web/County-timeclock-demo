function lunchDaySummary(day){return(currentData?.timecard_summary?.days||[]).find(item=>dateOnly(item.work_date)===day)||null}
function lunchRequestForDay(day){return(currentData?.lunch_requests||[]).find(item=>dateOnly(item.work_date_iso||item.work_date)===day&&item.status==="pending")||null}
function lunchStatusHtml(day){
  const info=lunchDaySummary(day);
  if(!info||!currentData?.timecard_summary?.forced_lunch_enabled||num(info.gross_worked_hours)<=0)return"";
  if(info.lunch_waived)return`<div style="margin-top:5px;font-size:.82em"><strong>Lunch waived</strong>${info.lunch_waiver_reason?` — ${esc(info.lunch_waiver_reason)}`:""}</div>`;
  const deduction=num(info.forced_lunch_deduction_hours);
  if(deduction<=0)return`<div style="margin-top:5px;font-size:.82em">Lunch satisfied by clocked break</div>`;
  const pending=lunchRequestForDay(day);
  let action="";
  if(selectedIsSelf()&&currentMode==="employee"){
    if(pending&&has("withdraw_own_pending_request")){
      action=` <button type="button" class="btn lunch-withdraw" data-id="${Number(pending.id)}" style="padding:3px 7px;font-size:.82em">Withdraw request</button>`;
    }else if(pending){
      action='<span style="margin-left:6px">Removal pending</span>';
    }else if(has("request_lunch_waiver")){
      action=` <button type="button" class="btn lunch-request" data-date="${day}" style="padding:3px 7px;font-size:.82em">Request removal</button>`;
    }
  }else if(currentMode==="supervisor"&&!selectedIsSelf()&&has("approve_lunch_waiver")){
    action=` <button type="button" class="btn lunch-waive" data-date="${day}" style="padding:3px 7px;font-size:.82em">Remove lunch</button>`;
  }
  return`<div style="margin-top:5px;font-size:.82em"><strong>Forced Lunch −${deduction.toFixed(2)} hr</strong>${action}</div>`;
}
async function requestLunchWaiver(day){
  const reason=prompt("Reason the forced lunch should be removed for this date:");
  if(!reason)return;
  try{
    await jsonOrError(await apiFetch(`${apiBase}/employee/request-lunch-waiver`,{method:"POST",body:JSON.stringify({work_date:day,reason})}));
    showMessage("Lunch removal request submitted");
    await loadTimecard();
  }catch(err){showMessage(err.message,"error")}
}
async function waiveForcedLunch(day){
  const reason=prompt("Reason for removing the forced lunch for this date:");
  if(!reason)return;
  try{
    await jsonOrError(await apiFetch(`${apiBase}/supervisor/lunch-waiver`,{method:"POST",body:JSON.stringify({employee_id:selectedEmployeeId,work_date:day,reason})}));
    showMessage("Forced lunch removed for this date");
    await loadTimecard();
  }catch(err){showMessage(err.message,"error")}
}
async function reviewLunchRequest(id,status){
  const note=prompt(`Supervisor note for ${status==="approved"?"approval":"denial"} (optional):`)||"";
  try{
    await jsonOrError(await apiFetch(`${apiBase}/supervisor/review-lunch-waiver-request`,{method:"POST",body:JSON.stringify({request_id:Number(id),status,review_note:note})}));
    showMessage(status==="approved"?"Forced lunch removed":"Lunch removal request denied");
    await loadTimecard();
  }catch(err){showMessage(err.message,"error")}
}
async function withdrawPendingItem(type,id){
  const reason=prompt("Reason for withdrawing this pending request (optional):");
  if(reason===null)return;
  try{
    if(type==="leave"){
      await jsonOrError(await apiFetch(`${apiBase}/leave/${Number(id)}`,{method:"DELETE",body:JSON.stringify({reason})}));
    }else if(type==="change"){
      await jsonOrError(await apiFetch(`${apiBase}/employee/withdraw-time-change`,{method:"POST",body:JSON.stringify({request_id:Number(id),reason})}));
    }else if(type==="lunch"){
      await jsonOrError(await apiFetch(`${apiBase}/employee/withdraw-lunch-waiver-request`,{method:"POST",body:JSON.stringify({request_id:Number(id),reason})}));
    }
    showMessage("Pending request withdrawn. History has been preserved.");
    await loadTimecard();
  }catch(err){showMessage(err.message,"error")}
}
function renderTimecard(){
  const data=currentData,employee=data.employee||currentUser,entries=data.entries||[],start=dateOnly(data.pay_period_start||selectedPeriodStart),summary=data.timecard_summary||{weeks:[],period:{},days:[]};
  const summaryDays=new Map((summary.days||[]).map(item=>[dateOnly(item.work_date),item]));
  const days=Array.from({length:14},(_,i)=>{const date=addDays(start,i),dayEntries=entries.filter(e=>dateOnly(e.entry_date_iso||e.clock_in)===date),daySummary=summaryDays.get(date);return{date,entries:dayEntries,worked:daySummary?num(daySummary.total_worked_hours):dailyWorked(dayEntries),forcedLunch:daySummary?num(daySummary.forced_lunch_deduction_hours):0}}),allocated=allocateDailyWork(days);
  const today=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
  let html="";
  days.forEach((d,i)=>{
    const leavePresent=(data.leave_entries||[]).some(l=>dateOnly(l.leave_date_iso||l.leave_date)===d.date&&["pending","approved"].includes(l.status)),work=allocated[d.date]||{regular:0,ot:0},approvedLeave=["holiday","vacation","sick","floating_holiday","other"].reduce((a,t)=>a+approvedLeaveHours(d.date,t),0),dailyTotal=d.worked+approvedLeave;
    const employeeCanModify=currentMode==="employee"&&data.can_edit_entries!==false;
    const elevatedCanModify=currentMode==="supervisor"&&data.can_edit_entries===true;
    const ownTimecard=selectedIsSelf();
    const employeePunchRequestEnabled=ownTimecard&&has("request_punch_correction")&&d.date<=today;
    const supervisorPunchEnabled=!ownTimecard&&elevatedCanModify&&canAddEntries();
    const punchEnabled=employeePunchRequestEnabled||supervisorPunchEnabled;
    const punchTitle=employeePunchRequestEnabled?"Request missing time for this date":supervisorPunchEnabled?"Add punch entry":"Punch request not available for this date";
    const leaveEnabled=(employeeCanModify&&ownTimecard&&has("request_leave"))||(!ownTimecard&&currentMode==="supervisor"&&has("add_employee_leave"));
    html+=`<tr class="${leavePresent?"leave-day":""}"><td class="left"><div class="datecell"><button class="icon-button day-punch" data-date="${d.date}" ${punchEnabled?"":"disabled"} title="${punchTitle}">${punchSvg}</button><button class="icon-button leave day-leave" data-date="${d.date}" ${leaveEnabled?"":"disabled"} title="Add leave">${leaveSvg}</button><span class="date-label"><strong>${esc(dayName(d.date))}</strong> ${esc(localDateLabel(d.date))}${lunchStatusHtml(d.date)}</span></div></td>${punchCells(d.date,d.entries)}<td>${fmt(work.regular+d.forcedLunch)}</td><td>${d.forcedLunch>0?"-"+fmt(d.forcedLunch):""}</td><td>${fmt(work.ot)}</td>${leaveCell(d.date,"holiday")}${leaveCell(d.date,"vacation")}${leaveCell(d.date,"sick")}${leaveCell(d.date,"floating_holiday")}${leaveCell(d.date,"other")}<td><strong>${fmt(dailyTotal)}</strong></td></tr>`;
    if(i===6)html+=totalRow("Week 1 Total",summary.weeks?.[0],"week-total");
    if(i===13)html+=totalRow("Week 2 Total",summary.weeks?.[1],"week-total");
  });
  html+=totalRow("Pay Period Total",summary.period,"period-total");document.getElementById("timeRows").innerHTML=html;
  document.getElementById("employeeNumber").textContent=employee.employee_number||"—";document.getElementById("departmentName").textContent=employee.department_name||employee.department||"—";document.getElementById("timecardStatus").textContent=statusLabel(data.approval);document.getElementById("workedRule").textContent=`${fmt(summary.period?.total_worked_hours)||"0.00"} worked / OT after ${fmt(summary.overtime_threshold_hours)||"40.00"} worked hrs/week`;document.getElementById("periodLabel").textContent=`${localDateLabel(data.pay_period_start)} – ${localDateLabel(data.pay_period_end)}`;document.getElementById("modeLabel").textContent=selectedIsSelf()?"Viewing your own timecard":currentMode==="supervisor"?`Viewing as ${payrollView()?"Payroll / Admin":"Supervisor"}`:"Viewing your own timecard";
  renderSignatures();renderDenied();renderPending();bindRowActions();syncNavButtons();
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
  const addTimeBtn=document.getElementById("addTimeBtn");addTimeBtn.classList.toggle("hidden",!(currentMode==="supervisor"&&!selectedIsSelf()&&currentData.can_edit_entries===true&&canAddEntries()));
  const payrollLink=document.getElementById("payrollLink");payrollLink.classList.toggle("hidden",!payrollView());payrollLink.href=`/payroll.html?employeeId=${encodeURIComponent(selectedEmployeeId)}&periodStart=${encodeURIComponent(selectedPeriodStart||"")}`;
}
function pendingItems(){
  const start=dateOnly(currentData.pay_period_start),end=dateOnly(currentData.pay_period_end);
  const leave=(currentData.leave_entries||[]).filter(l=>l.status==="pending").map(l=>({type:"leave",id:l.id,text:`${localDateLabel(l.leave_date_iso||l.leave_date)} — ${String(l.leave_type).replaceAll("_"," ")} ${num(l.hours).toFixed(2)} hrs`}));
  const changes=(currentData.change_requests||currentData.requests||[]).filter(r=>r.status==="pending").filter(r=>{const d=dateOnly(r.requested_clock_in||r.created_at);return !d||(d>=start&&d<=end)}).map(r=>{
    const missing=!r.time_entry_id;
    const requested=missing&&r.requested_clock_in
      ? `${localDateLabel(r.requested_clock_in)} — ${localDateTime(r.requested_clock_in)} to ${localDateTime(r.requested_clock_out)}`
      : (r.created_at_display?` — ${r.created_at_display}`:"");
    return{type:"change",id:r.id,text:missing?`Missing time request: ${requested}`:`Punch change request${requested}`};
  });
  const lunches=(currentData.lunch_requests||[]).filter(r=>r.status==="pending").filter(r=>{const d=dateOnly(r.work_date_iso||r.work_date);return d>=start&&d<=end}).map(r=>({type:"lunch",id:r.id,text:`${localDateLabel(r.work_date_iso||r.work_date)} — Forced lunch removal: ${r.reason||"No reason provided"}`}));
  return [...leave,...changes,...lunches];
}
function deniedPunchItems(){
  if(!selectedIsSelf())return[];
  return(currentData.change_requests||currentData.requests||[])
    .filter(r=>r.status==="denied"&&!r.employee_acknowledged_at)
    .map(r=>{
      let requested="Punch correction";
      if(!r.time_entry_id&&r.requested_clock_in&&r.requested_clock_out){
        requested=`Missing time: ${localDateTime(r.requested_clock_in)} to ${localDateTime(r.requested_clock_out)}`;
      }else if(!r.time_entry_id&&(r.requested_clock_in||r.requested_clock_out)){
        requested=`Punch: ${localDateTime(r.requested_clock_in||r.requested_clock_out)}`;
      }else if(r.requested_clock_in||r.requested_clock_out){
        const parts=[];
        if(r.requested_clock_in)parts.push(`Clock in ${localDateTime(r.requested_clock_in)}`);
        if(r.requested_clock_out)parts.push(`Clock out ${localDateTime(r.requested_clock_out)}`);
        requested=parts.join(" / ");
      }
      const reviewer=[r.supervisor_first_name,r.supervisor_last_name].filter(Boolean).join(" ");
      const reviewed=r.reviewed_at_display?` — Reviewed ${r.reviewed_at_display}`:"";
      const by=reviewer?` by ${reviewer}`:"";
      return{id:r.id,text:`${requested}${reviewed}${by}`,note:r.supervisor_note||"No denial reason was recorded."};
    });
}
function renderDenied(){
  const panel=document.getElementById("deniedPanel"),list=document.getElementById("deniedList");
  if(!panel||!list)return;
  const requestedDeniedId=Number(new URLSearchParams(location.search).get("deniedRequest")||0)||null;
  const items=deniedPunchItems().sort((a,b)=>Number(b.id===requestedDeniedId)-Number(a.id===requestedDeniedId));
  panel.classList.toggle("show",items.length>0);
  list.innerHTML=items.map(i=>`<div class="pending-item${Number(i.id)===requestedDeniedId?" denied-target":""}" data-denied-id="${Number(i.id)}"><span><strong>Punch Request Denied</strong><br>${esc(i.text)}<span class="denied-note">Supervisor reason: ${esc(i.note)}</span></span><button class="btn btn-danger denied-ack" data-id="${Number(i.id)}">Mark Reviewed</button></div>`).join("");
  list.querySelectorAll(".denied-ack").forEach(b=>b.addEventListener("click",()=>acknowledgeDeniedPunch(b.dataset.id)));
  if(requestedDeniedId&&items.some(i=>Number(i.id)===requestedDeniedId)&&!renderDenied.focused){
    renderDenied.focused=true;
    requestAnimationFrame(()=>panel.scrollIntoView({behavior:"smooth",block:"center"}));
  }
}
async function acknowledgeDeniedPunch(id){
  try{
    await jsonOrError(await apiFetch(`${apiBase}/employee/denied-change-requests/${Number(id)}/acknowledge`,{method:"POST",body:"{}"}));
    showMessage("Denied punch request marked reviewed");
    await loadTimecard();
  }catch(err){showMessage(err.message,"error")}
}

function renderPending(){
  const items=pendingItems(),panel=document.getElementById("pendingPanel"),list=document.getElementById("pendingList");
  panel.classList.toggle("show",items.length>0);
  document.getElementById("pendingLegend").textContent=items.length?`${items.length} pending item${items.length===1?"":"s"}`:"";
  list.innerHTML=items.map(i=>{
    let actions="";
    if(selectedIsSelf()&&currentMode==="employee"&&has("withdraw_own_pending_request")){
      actions=`<span><button class="btn pending-withdraw" data-type="${i.type}" data-id="${Number(i.id)}">Withdraw</button></span>`;
    }else if(currentMode==="supervisor"){
      if(i.type==="leave"){
        const allowed=selectedIsSelf()?(selfApprovalRoleAllowed()&&has("approve_own_leave")):has("approve_leave");
        if(allowed)actions=`<span><button class="btn pending-leave-review" data-id="${Number(i.id)}" data-status="approved">Approve</button><button class="btn pending-leave-review" data-id="${Number(i.id)}" data-status="denied">Deny</button></span>`;
      }
      if(i.type==="change"){
        const allowed=selectedIsSelf()?(selfApprovalRoleAllowed()&&has("approve_own_punch_corrections")):has("approve_punch_correction");
        if(allowed)actions=`<span><button class="btn pending-change-review" data-id="${Number(i.id)}" data-status="approved">Approve</button><button class="btn pending-change-review" data-id="${Number(i.id)}" data-status="denied">Deny</button></span>`;
      }
      if(i.type==="lunch"){
        const allowed=selectedIsSelf()?(selfApprovalRoleAllowed()&&has("approve_own_lunch_waiver")):has("approve_lunch_waiver");
        if(allowed)actions=`<span><button class="btn pending-lunch-review" data-id="${Number(i.id)}" data-status="approved">Approve</button><button class="btn pending-lunch-review" data-id="${Number(i.id)}" data-status="denied">Deny</button></span>`;
      }
    }
    return`<div class="pending-item"><span>${esc(i.text)}</span>${actions}</div>`;
  }).join("");
  list.querySelectorAll(".pending-leave-review").forEach(b=>b.addEventListener("click",()=>reviewLeave(b.dataset.id,b.dataset.status)));
  list.querySelectorAll(".pending-change-review").forEach(b=>b.addEventListener("click",()=>reviewChange(b.dataset.id,b.dataset.status)));
  list.querySelectorAll(".pending-lunch-review").forEach(b=>b.addEventListener("click",()=>reviewLunchRequest(b.dataset.id,b.dataset.status)));
  list.querySelectorAll(".pending-withdraw").forEach(b=>b.addEventListener("click",()=>withdrawPendingItem(b.dataset.type,b.dataset.id)));
}
function bindRowActions(){
  document.querySelectorAll(".punch").forEach(el=>el.addEventListener("click",ev=>openPunchMenu(ev,Number(el.dataset.entryId),el.dataset.kind)));
  document.querySelectorAll(".day-punch:not(:disabled)").forEach(b=>b.addEventListener("click",()=>selectedIsSelf()?openAddEntry(b.dataset.date):openDayPunchEditor(b.dataset.date)));
  document.querySelectorAll(".day-leave:not(:disabled)").forEach(b=>b.addEventListener("click",()=>openLeave(b.dataset.date)));
  document.querySelectorAll(".leave-entry-action").forEach(b=>b.addEventListener("click",()=>openEditLeave(b.dataset.leaveId)));
  document.querySelectorAll(".lunch-request").forEach(b=>b.addEventListener("click",()=>requestLunchWaiver(b.dataset.date)));
  document.querySelectorAll(".lunch-waive").forEach(b=>b.addEventListener("click",()=>waiveForcedLunch(b.dataset.date)));
  document.querySelectorAll(".lunch-withdraw").forEach(b=>b.addEventListener("click",()=>withdrawPendingItem("lunch",b.dataset.id)));
}
function findEntry(id){return(currentData.entries||[]).find(e=>Number(e.id)===Number(id))}
function openPunchMenu(ev,id,kind){
  const entry=findEntry(id);if(!entry)return;activeEntry={...entry,clickedKind:kind};const menu=document.getElementById("contextMenu");let buttons=[];
  if(selectedIsSelf()&&currentData.can_edit_entries!==false){if(has("request_punch_correction"))buttons.push(["Request Change","request"]);if(has("void_own_unapproved_punch"))buttons.push(["Void Punch","delete"])}
  if(!selectedIsSelf()&&currentMode==="supervisor"&&currentData.can_edit_entries===true&&hasAny(["edit_employee_time","edit_payroll_time"])){buttons.push(["Edit Day Punches","edit-day"])}
  if(!buttons.length)buttons=[["View only","none"]];
  menu.innerHTML=buttons.map(([label,action])=>`<button data-action="${action}">${esc(label)}</button>`).join("");menu.querySelectorAll("button").forEach(b=>b.addEventListener("click",()=>handlePunchAction(b.dataset.action)));const x=Math.min(ev.clientX,innerWidth-180),y=Math.min(ev.clientY+8,innerHeight-160);menu.style.left=x+"px";menu.style.top=y+"px";menu.style.display="block";ev.stopPropagation()
}
function closeMenu(){document.getElementById("contextMenu").style.display="none"}document.addEventListener("click",closeMenu);
function handlePunchAction(action){closeMenu();if(action==="request")openEntryModal("request",activeEntry);if(action==="edit")openEntryModal("edit",activeEntry);if(action==="delete")deleteEntry(activeEntry);if(action==="edit-day"&&activeEntry)openDayPunchEditor(dateOnly(activeEntry.entry_date_iso||activeEntry.clock_in))}
function modal(id,show){document.getElementById(id).classList.toggle("show",show)}document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>modal(b.dataset.close,false)));

function entryModalMessageElement(){
  let box=document.getElementById("entryModalMessage");
  if(box)return box;
  box=document.createElement("div");
  box.id="entryModalMessage";
  box.setAttribute("role","alert");
  box.style.display="none";
  box.style.margin="8px 0 14px";
  box.style.padding="10px 12px";
  box.style.borderRadius="6px";
  const actions=document.querySelector("#entryModal .modal-actions");
  actions?.parentNode?.insertBefore(box,actions);
  return box;
}
function showEntryModalMessage(message,isError=true){
  const box=entryModalMessageElement();
  box.textContent=message||"";
  box.style.display=message?"block":"none";
  box.style.background=isError?"#f8d7da":"#d4edda";
  box.style.color=isError?"#721c24":"#155724";
  box.style.border=`1px solid ${isError?"#f5c6cb":"#c3e6cb"}`;
}
function clearEntryModalMessage(){showEntryModalMessage("",false)}
function entryDateFromIso(v){return dateOnly(v)}
function openEntryModal(mode,entry){
  entryModalMode=mode;activeEntry=entry;clearEntryModalMessage();document.getElementById("entryModalTitle").textContent=mode==="request"?"Request Punch Change":mode==="edit"?"Edit Punch Entry":"Add Punch Entry";const inDate=entry?entryDateFromIso(entry.clock_in):dateOnly(currentData.pay_period_start),outDate=entry?.clock_out?entryDateFromIso(entry.clock_out):inDate;document.getElementById("entryInDate").value=inDate;document.getElementById("entryInTime").value=entry?entryIn24(entry).slice(0,5):"08:00";document.getElementById("entryOutDate").value=outDate;document.getElementById("entryOutTime").value=entry?.clock_out?entryOut24(entry).slice(0,5):"";document.getElementById("entryReason").value="";if(mode==="request"&&entry?.clickedKind==="in"){document.getElementById("entryOutDate").value="";document.getElementById("entryOutTime").value=""}if(mode==="request"&&entry?.clickedKind==="out"){document.getElementById("entryInDate").value="";document.getElementById("entryInTime").value=""}modal("entryModal",true)
}
function openAddEntry(day){
  const employeeRequest=selectedIsSelf();
  entryModalMode=employeeRequest?"request-add":"add";activeEntry=null;clearEntryModalMessage();document.getElementById("entryModalTitle").textContent=employeeRequest?"Request Missing Time":"Add Time for Employee";document.getElementById("entryInDate").value=day;document.getElementById("entryInTime").value="08:00";document.getElementById("entryOutDate").value=day;document.getElementById("entryOutTime").value="";document.getElementById("entryReason").value="";modal("entryModal",true)
}
let dayPunchEditDate=null;
function dayPunchTimes(day){const a=[];(currentData.entries||[]).filter(e=>dateOnly(e.entry_date_iso||e.clock_in)===day).forEach(e=>{if(e.clock_in)a.push(entryIn24(e).slice(0,5));if(e.clock_out)a.push(entryOut24(e).slice(0,5))});return a.sort()}
function readDayPunchTimes(){return Array.from(document.querySelectorAll("#dayPunchRows .day-punch-time")).map(i=>i.value).filter(Boolean).sort()}
function renderDayPunchRows(times){const rows=document.getElementById("dayPunchRows");rows.innerHTML=times.map((t,i)=>`<div class="day-punch-row"><span class="day-punch-number">${i+1}</span><input type="time" step="60" value="${esc(t)}" class="day-punch-time"><button type="button" class="btn btn-danger day-punch-remove" title="Remove punch">−</button></div>`).join("");rows.querySelectorAll(".day-punch-remove").forEach((b,i)=>b.addEventListener("click",()=>{const n=readDayPunchTimes();n.splice(i,1);renderDayPunchRows(n);updateDayPunchPreview()}));rows.querySelectorAll(".day-punch-time").forEach(i=>i.addEventListener("input",updateDayPunchPreview))}
function updateDayPunchPreview(){const t=readDayPunchTimes(),pairs=[];for(let i=0;i<t.length;i+=2)pairs.push(`${t[i]}–${t[i+1]||"OPEN"}`);const today=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"}),warning=t.length%2&&dayPunchEditDate<today?"Past dates must end with complete IN/OUT pairs.":"";document.getElementById("dayPunchPreview").innerHTML=`<strong>Result:</strong> ${pairs.length?pairs.map(esc).join(" | "):"No punches"}${warning?`<div class="day-punch-warning">${esc(warning)}</div>`:""}`}
function openDayPunchEditor(day){dayPunchEditDate=day;document.getElementById("dayPunchModalTitle").textContent=`Edit Day Punches — ${localDateLabel(day)}`;document.getElementById("dayPunchReason").value="";document.getElementById("dayPunchMessage").textContent="";renderDayPunchRows(dayPunchTimes(day));updateDayPunchPreview();modal("dayPunchModal",true)}
document.getElementById("dayPunchAddBtn").addEventListener("click",()=>{const t=readDayPunchTimes();t.push("12:00");renderDayPunchRows(t);updateDayPunchPreview()});
document.getElementById("dayPunchSaveBtn").addEventListener("click",async()=>{const times=readDayPunchTimes(),reason=document.getElementById("dayPunchReason").value.trim(),box=document.getElementById("dayPunchMessage");box.textContent="";box.className="day-punch-message";try{if(!reason)throw new Error("Reason is required");const today=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});if(times.length%2&&dayPunchEditDate<today)throw new Error("Past dates must have complete in/out punch pairs before saving.");const punches=times.map(t=>timestamp(dayPunchEditDate,t));await jsonOrError(await apiFetch(`${apiBase}/supervisor/replace-day-punches`,{method:"POST",body:JSON.stringify({employee_id:selectedEmployeeId,work_date:dayPunchEditDate,punches,reason})}));modal("dayPunchModal",false);showMessage("Day punches updated");await loadTimecard()}catch(err){box.textContent=err.message||"Unable to update day punches";box.className="day-punch-message error"}});

function defaultAddEntryDate(){const start=dateOnly(currentData?.pay_period_start||selectedPeriodStart),end=dateOnly(currentData?.pay_period_end),today=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});return start&&end&&today>=start&&today<=end?today:start}
document.getElementById("addTimeBtn").addEventListener("click",()=>openAddEntry(defaultAddEntryDate()));
function timestamp(date,time){return date&&time?`${date} ${time}:00`:null}
document.getElementById("entrySubmitBtn").addEventListener("click",async()=>{
  // Single-punch modes are handled exclusively by timecard-single-punch.js.
  if(entryModalMode==="add-punch"||entryModalMode==="request-punch")return;
  const inDate=document.getElementById("entryInDate").value,inTime=document.getElementById("entryInTime").value,outDate=document.getElementById("entryOutDate").value,outTime=document.getElementById("entryOutTime").value,reason=document.getElementById("entryReason").value.trim();
  clearEntryModalMessage();
  try{
    if(entryModalMode==="request"){
      if(!reason)throw new Error("Reason is required");const body={time_entry_id:activeEntry.id,employee_reason:reason,requested_clock_in:timestamp(inDate,inTime),requested_clock_out:timestamp(outDate,outTime)};if(!body.requested_clock_in&&!body.requested_clock_out)throw new Error("Select a clock in time, clock out time, or both");await jsonOrError(await apiFetch(`${apiBase}/employee/request-time-change`,{method:"POST",body:JSON.stringify(body)}));showMessage("Time change request submitted")
    }else if(entryModalMode==="request-add"){
      if(!inDate||!inTime)throw new Error("Clock in date and time are required");
      if(!outDate||!outTime)throw new Error("Clock out date and time are required");
      if(!reason)throw new Error("Reason is required");
      const body={time_entry_id:null,employee_reason:reason,requested_clock_in:timestamp(inDate,inTime),requested_clock_out:timestamp(outDate,outTime)};
      await jsonOrError(await apiFetch(`${apiBase}/employee/request-time-change`,{method:"POST",body:JSON.stringify(body)}));
      showMessage("Missing time request submitted to your supervisor")
    }else if(entryModalMode==="edit"){
      if(!reason)throw new Error("Reason is required");const body={time_entry_id:activeEntry.id,new_clock_in:timestamp(inDate,inTime),new_clock_out:timestamp(outDate,outTime),reason};await jsonOrError(await apiFetch(`${apiBase}/supervisor/edit-time-entry`,{method:"POST",body:JSON.stringify(body)}));showMessage("Time entry updated")
    }else if(entryModalMode==="add"){
      if(!reason)throw new Error("Reason is required");const body={employee_id:selectedEmployeeId,clock_in:timestamp(inDate,inTime),clock_out:timestamp(outDate,outTime),reason};await jsonOrError(await apiFetch(`${apiBase}/supervisor/add-time-entry`,{method:"POST",body:JSON.stringify(body)}));showMessage("Time entry added")
    }
    modal("entryModal",false);await loadTimecard()
  }catch(err){showEntryModalMessage(err.message||"Unable to save punch request",true)}
});
async function deleteEntry(entry){
  const kind=entry?.clickedKind==="out"?"out":"in";
  const label=kind==="out"?"clock-out":"clock-in";
  const reason=prompt(`Reason for voiding this ${label} punch:`);
  if(!reason)return;
  try{
    const data=await jsonOrError(await apiFetch(`${apiBase}/delete-punch`,{method:"POST",body:JSON.stringify({time_entry_id:entry.id,punch_kind:kind,reason})}));
    showMessage(data.message||"Punch voided. Original record remains in the audit trail.");
    await loadTimecard();
  }catch(err){showMessage(err.message,"error")}
}
function openLeave(day){
  leaveModalMode="add";activeLeave=null;
  document.getElementById("leaveModalTitle").textContent="Add Leave";
  document.getElementById("leaveDate").value=day;
  document.getElementById("leaveType").value="vacation";
  document.getElementById("leaveHours").value="8";
  document.getElementById("leaveNote").value="";
  document.getElementById("leaveSubmitBtn").textContent="Submit Leave";
  document.getElementById("leaveVoidBtn").classList.add("hidden");
  modal("leaveModal",true)
}
function openEditLeave(id){
  const entry=(currentData.leave_entries||[]).find(l=>Number(l.id)===Number(id));
  if(!entry||entry.status!=="approved"){showMessage("Only approved leave can be edited directly.","warning");return}
  leaveModalMode="edit";activeLeave=entry;
  document.getElementById("leaveModalTitle").textContent="Edit Leave";
  document.getElementById("leaveDate").value=dateOnly(entry.leave_date_iso||entry.leave_date);
  document.getElementById("leaveType").value=entry.leave_type;
  document.getElementById("leaveHours").value=Number(entry.hours||0);
  document.getElementById("leaveNote").value=entry.note||"";
  document.getElementById("leaveSubmitBtn").textContent="Save Changes";
  document.getElementById("leaveVoidBtn").classList.remove("hidden");
  modal("leaveModal",true)
}
document.getElementById("leaveSubmitBtn").addEventListener("click",()=>submitLeave(false,null));
document.getElementById("leaveVoidBtn").addEventListener("click",()=>voidActiveLeave());
async function submitLeave(override,existingReason){
  const date=document.getElementById("leaveDate").value,type=document.getElementById("leaveType").value,hours=Number(document.getElementById("leaveHours").value),note=document.getElementById("leaveNote").value.trim();
  if(leaveModalMode==="edit"){
    if(!activeLeave)return;
    let reason=existingReason;
    if(!reason){
      const entered=prompt("Reason for editing this leave entry:");
      if(entered===null)return;
      reason=entered.trim();
      if(!reason){showMessage("A reason is required when editing leave.","error");return}
    }
    const body={leave_date:date,leave_type:type,hours,note,reason};
    if(override){body.override_daily_hours=true;body.override_reason=prompt("Reason for exceeding the normal daily paid-hours warning:")||""}
    try{
      await jsonOrError(await apiFetch(`${apiBase}/leave/${Number(activeLeave.id)}`,{method:"PATCH",body:JSON.stringify(body)}));
      modal("leaveModal",false);showMessage("Leave entry updated. Audit history preserved.");await loadTimecard()
    }catch(err){
      if(err.status===409&&err.data?.requires_confirmation&&!override){
        if(confirm(`${err.message}\n\nSave this management correction anyway?`))return submitLeave(true,reason)
      }
      showMessage(err.message,"error")
    }
    return;
  }
  const body={employee_id:selectedEmployeeId,start_date:date,end_date:date,leave_type:type,hours,note};
  if(override){body.override_daily_hours=true;body.override_reason=prompt("Reason for exceeding the normal daily paid-hours warning:")||""}
  try{
    await jsonOrError(await apiFetch(`${apiBase}/leave`,{method:"POST",body:JSON.stringify(body)}));
    modal("leaveModal",false);
    showMessage(selectedIsSelf()&&currentMode==="employee"?"Leave submitted for approval":"Leave added");
    await loadTimecard()
  }catch(err){
    if(err.status===409&&err.data?.requires_confirmation&&!override){
      if(confirm(`${err.message}\n\nSubmit anyway for supervisor review?`))return submitLeave(true,null)
    }
    showMessage(err.message,"error")
  }
}
async function voidActiveLeave(){
  if(!activeLeave)return;
  const entered=prompt("Reason for voiding this leave entry:");
  if(entered===null)return;
  const reason=entered.trim();
  if(!reason){showMessage("A reason is required when voiding leave.","error");return}
  if(!confirm("Void this leave entry? The original record will remain in the audit history."))return;
  try{
    await jsonOrError(await apiFetch(`${apiBase}/leave/${Number(activeLeave.id)}`,{method:"DELETE",body:JSON.stringify({reason})}));
    modal("leaveModal",false);
    showMessage("Leave entry voided. Original record remains in the audit history.");
    await loadTimecard()
  }catch(err){showMessage(err.message,"error")}
}
async function reviewLeave(id,status){const note=status==="denied"?(prompt("Reason for denying leave:")||""):"";try{await jsonOrError(await apiFetch(`${apiBase}/leave/${id}/review`,{method:"POST",body:JSON.stringify({status,review_note:note})}));showMessage(`Leave ${status}`);await loadTimecard()}catch(err){showMessage(err.message,"error")}}
async function reviewChange(id,status){
  let note="";
  if(status==="denied"){
    const entered=prompt("Reason for denying this punch request (required):");
    if(entered===null)return;
    note=entered.trim();
    if(!note){showMessage("A reason is required when denying a punch request","error");return}
    if(note.length>1000){showMessage("Denial reason must be 1000 characters or less","error");return}
  }else{
    const entered=prompt("Supervisor note for approval (optional):");
    if(entered===null)return;
    note=entered.trim();
  }
  const path=status==="approved"?"approve-change-request":"deny-change-request";
  try{
    await jsonOrError(await apiFetch(`${apiBase}/supervisor/${path}`,{method:"POST",body:JSON.stringify({request_id:Number(id),supervisor_note:note})}));
    showMessage(`Change request ${status}`);
    await loadTimecard();
  }catch(err){showMessage(err.message,"error")}
}

document.getElementById("employeeSignBtn").addEventListener("click",async()=>{if(!confirm("Sign and submit this timecard to your supervisor?"))return;try{await jsonOrError(await apiFetch(`${apiBase}/submit-timecard`,{method:"POST",body:"{}"}));showMessage("Timecard submitted");await loadTimecard()}catch(err){showMessage(err.message,"error")}});
document.getElementById("supervisorSignBtn").addEventListener("click",async()=>{if(!confirm("Approve and sign this employee timecard?"))return;try{await jsonOrError(await apiFetch(`${apiBase}/supervisor/approve-timecard`,{method:"POST",body:JSON.stringify({employee_id:selectedEmployeeId})}));showMessage("Timecard approved");await loadTimecard()}catch(err){showMessage(err.message,"error")}});
document.getElementById("returnBtn").addEventListener("click",async()=>{const note=prompt("Reason for returning this timecard:");if(note===null)return;const target=payrollView()&&currentData.approval?.status==="supervisor_approved"&&confirm("Return to supervisor review instead of returning all the way to the employee?\n\nOK = Supervisor, Cancel = Employee")?"supervisor":"employee";try{await jsonOrError(await apiFetch(`${apiBase}/supervisor/return-timecard`,{method:"POST",body:JSON.stringify({employee_id:selectedEmployeeId,supervisor_note:note,target_stage:target})}));showMessage(target==="supervisor"?"Returned to supervisor review":"Returned to employee");await loadTimecard()}catch(err){showMessage(err.message,"error")}});

async function refreshQuickPunch(){
  const btn=document.getElementById("quickPunchBtn");
  if(!selectedIsSelf()||!has("clock_in_out")){btn.classList.add("hidden");return}
  try{
    const s=await jsonOrError(await apiFetch(`${apiBase}/quick-status`));
    btn.classList.remove("hidden");
    btn.dataset.action=s.next_action;
    btn.dataset.entryId=s.current_entry_id||"";
    btn.dataset.locked=s.timecard_locked?"1":"0";
    if(s.timecard_locked){
      btn.dataset.stale="0";
      btn.disabled=true;
      btn.textContent="Timecard Signed — Punching Locked";
      btn.title="Your supervisor must return the timecard before you can punch again.";
      return;
    }
    btn.disabled=false;
    btn.title="";
    const stale=Boolean(s.requires_correction)||(s.current_clock_in&&(dateOnly(s.current_clock_in)<new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"})||Date.now()-new Date(s.current_clock_in).getTime()>=23*3600000));
    btn.dataset.stale=stale?"1":"0";
    btn.textContent=stale?"Correct Missing Punch":(s.next_action==="clock_out"?"Click Here to Clock Out":"Click Here to Clock In")
  }catch(_){btn.classList.add("hidden")}
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
  const btn=document.getElementById("quickPunchBtn");
  if(btn.dataset.locked==="1"){showMessage("This timecard is signed and locked. Your supervisor must return it before you can punch again.","warning");return}
  if(btn.dataset.stale==="1"){const open=(currentData.entries||[]).find(e=>!e.clock_out);if(open){activeEntry={...open,clickedKind:"out"};openEntryModal("request",activeEntry);showEntryModalMessage("This older open punch must be corrected and approved before another normal punch.",false);return}showMessage("Open the missing punch on the timecard and request a correction.","warning");return}
  const action=btn.dataset.action;if(!action)return;
  btn.disabled=true;const prior=btn.textContent;btn.textContent="Getting current location…";
  try{
    const location=await freshLocation();
    const data=await jsonOrError(await apiFetch(`${apiBase}/${action==="clock_out"?"clock-out":"clock-in"}`,{method:"POST",body:JSON.stringify({...location,client_source:"timecard_web"})}));
    showMessage(data.message||"Punch recorded");await loadTimecard()
  }catch(err){
    if(err.data?.code==="STALE_OPEN_PUNCH"){await loadTimecard();showMessage(err.message,"warning")}
    else if(err.data?.code==="TIMECARD_LOCKED"){await loadTimecard();showMessage(err.message,"warning")}
    else showMessage(err.message,"error")
  }finally{
    if(btn.dataset.locked!=="1")btn.disabled=false;
    if(!currentData)btn.textContent=prior
  }
});
document.getElementById("logoutBtn")?.addEventListener("click",()=>location.href="/global-logout.html");
init().then(()=>{
  const params=new URLSearchParams(location.search);
  if(params.get("addEntry")==="1"&&currentMode==="supervisor"&&!selectedIsSelf()&&currentData?.can_edit_entries===true&&canAddEntries()){
    openAddEntry(defaultAddEntryDate());
    const url=new URL(location.href);url.searchParams.delete("addEntry");history.replaceState({},"",url);
  }
});
