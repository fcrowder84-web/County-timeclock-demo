"use strict";
const apiBase="/api";
const qs=new URLSearchParams(location.search);
let currentUser=null,currentPermissions=new Set(),periods=[],employees=[],selectedPeriodStart=qs.get("periodStart")||null,selectedEmployeeId=Number(qs.get("employeeId")||0)||null,currentData=null,currentMode="employee",activeEntry=null,entryModalMode=null;

const punchSvg='<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>';
const leaveSvg='<svg viewBox="0 0 24 24"><rect x="4" y="6" width="16" height="14" rx="1"/><path d="M8 4v4M16 4v4M4 10h16"/><path d="M9 14h6"/></svg>';

function token(){return localStorage.getItem("timeclock_token")}
function has(key){return currentPermissions.has("app_admin")||currentPermissions.has(key)}
function hasAny(keys){return keys.some(has)}
function esc(v){return SafeHtml.escape(v)}
function num(v){const n=Number(v||0);return Number.isFinite(n)?n:0}
function fmt(v){return num(v)?num(v).toFixed(2):""}
function dateOnly(v){return v?String(v).slice(0,10):""}
function localDateLabel(v){if(!v)return"";return new Date(dateOnly(v)+"T12:00:00").toLocaleDateString()}
function localDateTime(v){if(!v)return"";const d=new Date(v);return Number.isNaN(d.getTime())?String(v):d.toLocaleString()}
function addDays(s,n){const d=new Date(s+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
function dayName(s){return new Date(s+"T12:00:00").toLocaleDateString(undefined,{weekday:"short"})}
function roundDailyHours(hours){const mins=Math.max(0,Math.round(num(hours)*60));return (Math.floor(mins/15)*15+(mins%15>5?15:0))/60}
function updateUrl(){const u=new URL(location.href);if(selectedPeriodStart)u.searchParams.set("periodStart",selectedPeriodStart);if(selectedEmployeeId)u.searchParams.set("employeeId",selectedEmployeeId);history.replaceState({},"",u)}
function showMessage(message,type="success"){const box=document.getElementById("messageBox");box.textContent=message;box.className="notice "+type;clearTimeout(showMessage.t);showMessage.t=setTimeout(()=>{box.className="notice"},6000)}
async function apiFetch(url,options={}){const headers={...(options.headers||{})};if(token())headers.Authorization=`Bearer ${token()}`;if(options.body&&!headers["Content-Type"])headers["Content-Type"]="application/json";if(selectedPeriodStart&&url.startsWith(apiBase)){const sep=url.includes("?")?"&":"?";url+=`${sep}period_start=${encodeURIComponent(selectedPeriodStart)}`}const response=await fetch(url,{...options,headers});if(response.status===401){localStorage.removeItem("timeclock_token");location.replace("https://employee.edgefieldcountysc.org/apps/timeclock/launch?return_to=timecard");throw new Error("Login required")}return response}
async function jsonOrError(response){let data={};try{data=await response.json()}catch(_){data={}}if(!response.ok){const err=new Error(data.error||`Request failed (${response.status})`);err.status=response.status;err.data=data;throw err}return data}
function elevatedView(){return hasAny(["view_assigned_employees","view_department_time","view_payroll_records","review_approved_timecards","view_all_timeclock_records"])}
function payrollView(){return hasAny(["edit_payroll_time","view_payroll_records","review_approved_timecards","view_all_timeclock_records","return_to_supervisor","finalize_timecard"])}
function canAddEntries(){return hasAny(["add_employee_entry","edit_employee_time","edit_payroll_time"])}
function canReturn(){return hasAny(["return_timecard","return_to_supervisor","edit_payroll_time"])}
function selectedIsSelf(){return Number(selectedEmployeeId)===Number(currentUser?.id)}

async function init(){
  if(!token()){location.replace("https://employee.edgefieldcountysc.org/apps/timeclock/launch?return_to=timecard");return}
  try{
    const me=await jsonOrError(await apiFetch(`${apiBase}/me`));currentUser=me.user;currentPermissions=new Set(me.permissions||[]);
    await loadPeriods();
    await loadEmployees();
    renderSelectors();
    await loadTimecard();
  }catch(err){showMessage(err.message,"error")}
}

async function loadPeriods(){
  const data=await jsonOrError(await apiFetch(`${apiBase}/pay-periods`));periods=(data.periods||[]).filter(p=>!p.is_future);
  if(!selectedPeriodStart||!periods.some(p=>p.pay_period_start===selectedPeriodStart))selectedPeriodStart=data.current?.pay_period_start||periods[0]?.pay_period_start;
}
async function loadEmployees(){
  if(elevatedView()){
    try{
      const data=await jsonOrError(await apiFetch(`${apiBase}/supervisor/pay-period-status`));employees=(data.employees||[]).map(e=>({...e,name:`${e.last_name}, ${e.first_name}`}));
      if(!employees.some(e=>Number(e.id)===Number(currentUser.id))&&has("view_own_time"))employees.unshift({id:currentUser.id,first_name:currentUser.first_name,last_name:currentUser.last_name,department:currentUser.department_name||currentUser.department,name:`${currentUser.last_name}, ${currentUser.first_name}`});
    }catch(err){employees=[]}
  }
  if(!employees.length)employees=[{id:currentUser.id,first_name:currentUser.first_name,last_name:currentUser.last_name,department:currentUser.department_name||currentUser.department,name:`${currentUser.last_name}, ${currentUser.first_name}`}];
  if(!selectedEmployeeId||!employees.some(e=>Number(e.id)===Number(selectedEmployeeId))){
    selectedEmployeeId=has("view_own_time")&&employees.some(e=>Number(e.id)===Number(currentUser.id))
      ? Number(currentUser.id)
      : Number(employees[0].id);
  }
  updateUrl();
}
function renderSelectors(){
  const es=document.getElementById("employeeSelect");es.innerHTML=employees.map(e=>`<option value="${Number(e.id)}"${Number(e.id)===Number(selectedEmployeeId)?" selected":""}>${esc(e.name||`${e.last_name}, ${e.first_name}`)}${e.department?` — ${esc(e.department)}`:""}</option>`).join("");
  const ps=document.getElementById("periodSelect");ps.innerHTML=periods.map(p=>`<option value="${esc(p.pay_period_start)}"${p.pay_period_start===selectedPeriodStart?" selected":""}>${esc(localDateLabel(p.pay_period_start))} through ${esc(localDateLabel(p.pay_period_end))}${p.is_current?" (Current)":""}</option>`).join("");
  syncNavButtons();
}
function syncNavButtons(){
  const ei=employees.findIndex(e=>Number(e.id)===Number(selectedEmployeeId));document.getElementById("prevEmployeeBtn").disabled=employees.length<2||ei<=0;document.getElementById("nextEmployeeBtn").disabled=employees.length<2||ei<0||ei>=employees.length-1;
  const pi=periods.findIndex(p=>p.pay_period_start===selectedPeriodStart);document.getElementById("prevPeriodBtn").disabled=pi<0||pi>=periods.length-1;document.getElementById("nextPeriodBtn").disabled=pi<=0;
}
async function switchEmployee(id){selectedEmployeeId=Number(id);updateUrl();renderSelectors();await loadTimecard()}
async function switchPeriod(start){selectedPeriodStart=start;updateUrl();await loadEmployees();renderSelectors();await loadTimecard()}
document.getElementById("employeeSelect").addEventListener("change",e=>switchEmployee(e.target.value));
document.getElementById("periodSelect").addEventListener("change",e=>switchPeriod(e.target.value));
document.getElementById("prevEmployeeBtn").addEventListener("click",()=>{const i=employees.findIndex(e=>Number(e.id)===Number(selectedEmployeeId));if(i>0)switchEmployee(employees[i-1].id)});
document.getElementById("nextEmployeeBtn").addEventListener("click",()=>{const i=employees.findIndex(e=>Number(e.id)===Number(selectedEmployeeId));if(i>=0&&i<employees.length-1)switchEmployee(employees[i+1].id)});
document.getElementById("prevPeriodBtn").addEventListener("click",()=>{const i=periods.findIndex(p=>p.pay_period_start===selectedPeriodStart);if(i>=0&&i<periods.length-1)switchPeriod(periods[i+1].pay_period_start)});
document.getElementById("nextPeriodBtn").addEventListener("click",()=>{const i=periods.findIndex(p=>p.pay_period_start===selectedPeriodStart);if(i>0)switchPeriod(periods[i-1].pay_period_start)});

async function loadTimecard(){
  closeMenu();
  const useSupervisor=elevatedView()&&(!selectedIsSelf()||!has("view_own_time"));
  currentMode=useSupervisor?"supervisor":"employee";
  const endpoint=useSupervisor?`${apiBase}/supervisor/employee-timecard/${selectedEmployeeId}`:`${apiBase}/employee/my-timecard`;
  try{
    currentData=await jsonOrError(await apiFetch(endpoint));renderTimecard();
    await refreshQuickPunch();
  }catch(err){showMessage(err.message,"error")}
}
function entryInDisplay(e){return e.clock_in_time||e.clock_in_display||new Date(e.clock_in).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"})}
function entryOutDisplay(e){return e.clock_out_time||e.clock_out_display||(e.clock_out?new Date(e.clock_out).toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):null)}
function entryIn24(e){return e.clock_in_time_24||e.clock_in_24||new Date(e.clock_in).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",hour12:false})}
function entryOut24(e){return e.clock_out_time_24||e.clock_out_24||(e.clock_out?new Date(e.clock_out).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",hour12:false}):"")}
function approvedLeaveHours(day,type){
  return (currentData.leave_entries||[]).filter(l=>dateOnly(l.leave_date_iso||l.leave_date)===day&&l.status==="approved"&&(type==="other"?!["holiday","vacation","sick","floating_holiday"].includes(l.leave_type):l.leave_type===type)).reduce((a,l)=>a+num(l.hours),0)
}
function pendingLeaveHours(day,type){
  return (currentData.leave_entries||[]).filter(l=>dateOnly(l.leave_date_iso||l.leave_date)===day&&l.status==="pending"&&(type==="other"?!["holiday","vacation","sick","floating_holiday"].includes(l.leave_type):l.leave_type===type)).reduce((a,l)=>a+num(l.hours),0)
}
function dailyWorked(entries){return roundDailyHours(entries.reduce((a,e)=>a+num(e.hours_worked),0))}
function allocateDailyWork(days){
  const result={};for(let w=0;w<2;w++){let cumulative=0;for(let i=w*7;i<w*7+7;i++){const day=days[i],worked=day.worked;const remaining=Math.max(0,40-cumulative);const regular=Math.min(worked,remaining);const ot=Math.max(0,worked-regular);result[day.date]={regular,ot};cumulative+=worked}}return result
}
function punchCells(day,entries){
  const punches=[];
  entries.forEach(e=>{
    punches.push({label:entryInDisplay(e),entry:e,kind:"in",cls:""});
    if(e.clock_out)punches.push({label:entryOutDisplay(e),entry:e,kind:"out",cls:""});
    else{
      const age=Date.now()-new Date(e.clock_in).getTime(),isOld=day<new Date().toISOString().slice(0,10)||age>=23*3600000;
      punches.push({label:isOld?"MISSING OUT":"OPEN",entry:e,kind:"out",cls:isOld?"missing":"open"});
    }
  });
  const cells=[];for(let i=0;i<4;i++){let items=[];if(i<3)items=punches[i]?[punches[i]]:[];else items=punches.slice(3);cells.push(`<td>${items.map(p=>`<span class="punch ${p.cls}" data-entry-id="${Number(p.entry.id)}" data-kind="${p.kind}">${esc(p.label)}</span>`).join(" ")}</td>`)}return cells.join("")
}
function leaveCell(day,type){
  const approved=approvedLeaveHours(day,type),pending=pendingLeaveHours(day,type);if(!approved&&!pending)return"<td></td>";const title=pending?` title="${pending.toFixed(2)} pending"`:"";return `<td class="${pending?"pending-cell":""}"${title}>${approved?approved.toFixed(2):""}${pending?`${approved?" + ":""}${pending.toFixed(2)} P`:""}</td>`
}
function otherTotal(map){return Object.entries(map||{}).filter(([k])=>!["holiday","vacation","sick","floating_holiday"].includes(k)).reduce((a,[,v])=>a+num(v),0)}
function totalRow(label,summary,klass){
  const m=summary?.leave_hours_by_type||{};return `<tr class="${klass}"><td class="left" colspan="5">${esc(label)}</td><td>${fmt(summary?.regular_worked_hours)}</td><td>${fmt(summary?.overtime_hours)}</td><td>${fmt(m.holiday)}</td><td>${fmt(m.vacation)}</td><td>${fmt(m.sick)}</td><td>${fmt(m.floating_holiday)}</td><td>${fmt(otherTotal(m))}</td><td>${fmt(summary?.total_paid_hours)}</td></tr>`
}
