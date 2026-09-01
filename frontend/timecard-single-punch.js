(function(){
  function parsePunchDate(value){
    if(!value)return null;
    const d=value instanceof Date?value:new Date(value);
    return Number.isNaN(d.getTime())?null:d;
  }
  function sameInstant(a,b){
    const da=parsePunchDate(a),db=parsePunchDate(b);
    return Boolean(da&&db&&da.getTime()===db.getTime());
  }
  function punchDate(value){
    const d=parsePunchDate(value);
    if(!d)return dateOnly(value);
    const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,"0"),day=String(d.getDate()).padStart(2,"0");
    return `${y}-${m}-${day}`;
  }
  function punchTimeLabel(value){
    const d=parsePunchDate(value);
    return d?d.toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}):String(value||"");
  }
  function allRequests(){return currentData?.change_requests||currentData?.requests||[]}
  function isSinglePunchRequest(r){return r&&r.status==="pending"&&!r.time_entry_id&&Boolean(r.requested_clock_in)!==Boolean(r.requested_clock_out)}
  function canApproveOwnPunch(){return selectedIsSelf()&&currentPermissions.has("approve_own_punch_corrections")}
  function canApproveOwnTimecard(){return selectedIsSelf()&&currentPermissions.has("approve_own_timecard")}
  function actualPunchTimes(){
    const times=[];
    (currentData?.entries||[]).forEach(e=>{if(e.clock_in)times.push(e.clock_in);if(e.clock_out)times.push(e.clock_out)});
    return times;
  }
  function requestedEventsForRequest(r){
    if(!r||r.status!=="pending")return[];
    const actual=actualPunchTimes();
    const events=[];
    [r.requested_clock_in,r.requested_clock_out].forEach(v=>{
      if(!v)return;
      if(actual.some(a=>sameInstant(a,v)))return;
      if(events.some(e=>sameInstant(e.ts,v)))return;
      events.push({ts:v,request:r});
    });
    return events;
  }
  function pendingPunchEvents(day){
    return allRequests().flatMap(requestedEventsForRequest)
      .filter(e=>punchDate(e.ts)===day)
      .sort((a,b)=>parsePunchDate(a.ts)-parsePunchDate(b.ts));
  }

  const originalPunchCells=punchCells;
  punchCells=function(day,entries){
    const pending=pendingPunchEvents(day);
    if(!pending.length)return originalPunchCells(day,entries);

    const events=[];
    entries.forEach(e=>{
      events.push({ts:e.clock_in,label:entryInDisplay(e),entry:e,kind:"in",cls:"",pending:false});
      if(e.clock_out){
        events.push({ts:e.clock_out,label:entryOutDisplay(e),entry:e,kind:"out",cls:"",pending:false});
      }else{
        const hasPendingOut=allRequests().some(r=>r.status==="pending"&&Number(r.time_entry_id)===Number(e.id)&&r.requested_clock_out&&!sameInstant(r.requested_clock_out,e.clock_in));
        if(!hasPendingOut){
          const age=Date.now()-new Date(e.clock_in).getTime(),isOld=day<new Date().toISOString().slice(0,10)||age>=23*3600000;
          events.push({ts:new Date(e.clock_in).getTime()+1,label:isOld?"MISSING OUT":"OPEN",entry:e,kind:"out",cls:isOld?"missing":"open",pending:false,placeholder:true});
        }
      }
    });
    pending.forEach(p=>events.push({ts:p.ts,label:`${punchTimeLabel(p.ts)} PENDING`,pending:true,request:p.request}));
    events.sort((a,b)=>{
      const at=a.ts instanceof Date?a.ts.getTime():typeof a.ts==="number"?a.ts:parsePunchDate(a.ts)?.getTime()||0;
      const bt=b.ts instanceof Date?b.ts.getTime():typeof b.ts==="number"?b.ts:parsePunchDate(b.ts)?.getTime()||0;
      return at-bt;
    });

    const cells=[];
    for(let i=0;i<4;i++){
      const items=i<3?(events[i]?[events[i]]:[]):events.slice(3);
      cells.push(`<td>${items.map(p=>p.pending
        ? `<span class="punch missing pending-request" title="Punch request received and pending supervisor approval">${esc(p.label)}</span>`
        : `<span class="punch ${p.cls||""}" data-entry-id="${Number(p.entry.id)}" data-kind="${p.kind}">${esc(p.label)}</span>`
      ).join(" ")}</td>`);
    }
    return cells.join("");
  };

  pendingItems=function(){
    const start=dateOnly(currentData.pay_period_start),end=dateOnly(currentData.pay_period_end);
    const leave=(currentData.leave_entries||[]).filter(l=>l.status==="pending").map(l=>({type:"leave",id:l.id,text:`${localDateLabel(l.leave_date_iso||l.leave_date)} — ${String(l.leave_type).replaceAll("_"," ")} ${num(l.hours).toFixed(2)} hrs`}));
    const changes=allRequests().filter(r=>r.status==="pending").filter(r=>{
      const d=punchDate(r.requested_clock_in||r.requested_clock_out||r.created_at);return !d||(d>=start&&d<=end)
    }).map(r=>{
      const events=requestedEventsForRequest(r).map(e=>punchTimeLabel(e.ts));
      const day=punchDate(r.requested_clock_in||r.requested_clock_out||r.created_at);
      const text=isSinglePunchRequest(r)
        ? `Punch request: ${localDateLabel(day)}${events.length?` — ${events[0]}`:""} — waiting for approval`
        : `Punch change request: ${localDateLabel(day)}${events.length?` — ${events.join(" / ")}`:""} — waiting for approval`;
      return{type:"change",id:r.id,text};
    });
    return [...leave,...changes];
  };

  renderPending=function(){
    const items=pendingItems(),panel=document.getElementById("pendingPanel"),list=document.getElementById("pendingList");
    panel.classList.toggle("show",items.length>0);document.getElementById("pendingLegend").textContent=items.length?`${items.length} pending item${items.length===1?"":"s"}`:"";
    list.innerHTML=items.map(i=>{
      let actions="";
      if(i.type==="change"&&canApproveOwnPunch()){
        actions=`<span><button class="btn pending-change-review" data-id="${Number(i.id)}" data-status="approved">Approve My Punch</button></span>`;
      }else if(currentMode==="supervisor"){
        if(i.type==="leave"&&hasAny(["approve_timecard","edit_employee_time","edit_payroll_time","app_admin"]))actions=`<span><button class="btn pending-leave-review" data-id="${Number(i.id)}" data-status="approved">Approve</button><button class="btn pending-leave-review" data-id="${Number(i.id)}" data-status="denied">Deny</button></span>`;
        else if(i.type==="change"&&has("approve_punch_correction"))actions=`<span><button class="btn pending-change-review" data-id="${Number(i.id)}" data-status="approved">Approve</button><button class="btn pending-change-review" data-id="${Number(i.id)}" data-status="denied">Deny</button></span>`;
      }
      return `<div class="pending-item"><span>${esc(i.text)}</span>${actions}</div>`;
    }).join("");
    list.querySelectorAll(".pending-leave-review").forEach(b=>b.addEventListener("click",()=>reviewLeave(b.dataset.id,b.dataset.status)));
    list.querySelectorAll(".pending-change-review").forEach(b=>b.addEventListener("click",()=>reviewChange(b.dataset.id,b.dataset.status)));
  };

  const originalReviewChange=reviewChange;
  reviewChange=async function(id,status){
    const request=allRequests().find(r=>Number(r.id)===Number(id));
    if(status!=="approved")return originalReviewChange(id,status);
    const selfApproval=canApproveOwnPunch();
    if(!selfApproval&&!isSinglePunchRequest(request))return originalReviewChange(id,status);
    const note=prompt(selfApproval?"Note for your approval (optional):":"Supervisor note for approval (optional):")||"";
    try{
      if(isSinglePunchRequest(request)){
        const data=await jsonOrError(await apiFetch(`${apiBase}/supervisor/approve-single-punch`,{method:"POST",body:JSON.stringify({request_id:Number(id),supervisor_note:note})}));
        showMessage(data.message||"Punch request approved");
      }else{
        const data=await jsonOrError(await apiFetch(`${apiBase}/supervisor/approve-change-request`,{method:"POST",body:JSON.stringify({request_id:Number(id),supervisor_note:note})}));
        showMessage(data.message||"Punch change approved");
      }
      await loadTimecard();
    }catch(err){showMessage(err.message,"error")}
  };

  const originalRenderSignatures=renderSignatures;
  renderSignatures=function(){
    originalRenderSignatures();
    const a=currentData?.approval;
    if(canApproveOwnTimecard()&&a?.status==="employee_submitted"&&!a?.supervisor_approved_at){
      const supBtn=document.getElementById("supervisorSignBtn");
      supBtn.classList.remove("hidden");
      supBtn.textContent="Approve My Timecard";
      supBtn.title="This self-approval is enabled by your TimeClock access permission.";
    }
  };

  function fieldBox(id){return document.getElementById(id)?.closest("div")}
  function setFieldLabel(id,text){const box=fieldBox(id);const label=box?.querySelector("label");if(label)label.textContent=text}
  function restoreEntryFields(){
    fieldBox("entryInDate")?.classList.remove("hidden");fieldBox("entryInTime")?.classList.remove("hidden");
    fieldBox("entryOutDate")?.classList.remove("hidden");fieldBox("entryOutTime")?.classList.remove("hidden");
    setFieldLabel("entryInDate","Clock In Date");setFieldLabel("entryInTime","Clock In Time");setFieldLabel("entryOutDate","Clock Out Date");setFieldLabel("entryOutTime","Clock Out Time");
  }
  const originalOpenEntryModal=openEntryModal;
  openEntryModal=function(mode,entry){
    restoreEntryFields();
    const result=originalOpenEntryModal(mode,entry);
    if(mode!=="request")return result;

    const kind=entry?.clickedKind==="out"?"out":"in";
    const isOut=kind==="out";
    document.getElementById("entryModalTitle").textContent=isOut?"Request Clock Out Change":"Request Clock In Change";

    if(isOut){
      setFieldLabel("entryOutDate","Clock Out Date");
      setFieldLabel("entryOutTime","Requested Clock Out Time");
      fieldBox("entryInDate")?.classList.add("hidden");
      fieldBox("entryInTime")?.classList.add("hidden");
    }else{
      setFieldLabel("entryInDate","Clock In Date");
      setFieldLabel("entryInTime","Requested Clock In Time");
      fieldBox("entryOutDate")?.classList.add("hidden");
      fieldBox("entryOutTime")?.classList.add("hidden");
    }
    return result;
  };

  openAddEntry=function(day){
    restoreEntryFields();
    const employeeRequest=selectedIsSelf();
    entryModalMode=employeeRequest?"request-punch":"add-punch";activeEntry=null;clearEntryModalMessage();
    document.getElementById("entryModalTitle").textContent=employeeRequest?"Request Punch":"Add Punch";
    setFieldLabel("entryInDate","Punch Date");setFieldLabel("entryInTime","Punch Time");
    document.getElementById("entryInDate").value=day;document.getElementById("entryInTime").value="";
    document.getElementById("entryOutDate").value="";document.getElementById("entryOutTime").value="";
    fieldBox("entryOutDate")?.classList.add("hidden");fieldBox("entryOutTime")?.classList.add("hidden");
    document.getElementById("entryReason").value="";
    modal("entryModal",true);
    const existing=(currentData?.entries||[]).filter(e=>dateOnly(e.entry_date_iso||e.clock_in)===day);
    if(employeeRequest&&existing.length){
      showEntryModalMessage("Existing punches are already on this date. This requested punch will be inserted chronologically. Delete any incorrect punch first.",false);
    }
  };

  document.getElementById("entrySubmitBtn").addEventListener("click",async ev=>{
    if(entryModalMode!=="request-punch"&&entryModalMode!=="add-punch")return;
    ev.preventDefault();ev.stopImmediatePropagation();
    const punchDateValue=document.getElementById("entryInDate").value,punchTime=document.getElementById("entryInTime").value,reason=document.getElementById("entryReason").value.trim();
    clearEntryModalMessage();
    try{
      if(!punchDateValue||!punchTime)throw new Error("Punch date and time are required");
      if(!reason)throw new Error("Reason is required");
      const punchAt=timestamp(punchDateValue,punchTime);
      if(entryModalMode==="request-punch"){
        const data=await jsonOrError(await apiFetch(`${apiBase}/employee/request-time-change`,{method:"POST",body:JSON.stringify({requested_punch:punchAt,employee_reason:reason})}));
        showMessage(data.message||"Punch request submitted");
      }else{
        const data=await jsonOrError(await apiFetch(`${apiBase}/supervisor/add-time-entry`,{method:"POST",body:JSON.stringify({employee_id:selectedEmployeeId,punch_at:punchAt,reason})}));
        showMessage(data.message||"Punch added");
      }
      modal("entryModal",false);restoreEntryFields();await loadTimecard();
    }catch(err){showEntryModalMessage(err.message||"Unable to save punch",true)}
  },true);

  const style=document.createElement("style");
  style.textContent='.pending-request{color:#a61f1f!important;background:#fff0f0!important;border-color:#e1abab!important;font-weight:bold}.pending-request::after{content:""}';
  document.head.appendChild(style);
})();
