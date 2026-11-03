"use strict";
function weeklyExtraCell(week,index){
 const value=Number(week?.cap_extra_hours||0);
 const cap=week?.weekly_hours_cap;
 const cell=document.createElement("td");
 if(cap==null) return cell;
 if(currentMode==="supervisor" && currentData?.can_edit_weekly_extra){
  const input=document.createElement("input");
  input.className="weekly-extra-input";input.type="number";input.step="0.01";input.min="0";
  input.max=Number(week?.max_cap_extra_hours||0).toFixed(2);
  input.value=value.toFixed(2);input.dataset.week=String(index+1);
  input.title="Maximum actual worked hours removed by cap: "+input.max;
  cell.appendChild(input);
 }else cell.textContent=value.toFixed(2);
 return cell;
}

const originalRenderTimecard=renderTimecard;
renderTimecard=function(){
 originalRenderTimecard();
 const header=document.querySelector(".tablewrap table thead tr");
 if(header&&!header.querySelector(".weekly-extra-head")){
  const th=document.createElement("th");th.className="weekly-extra-head";
  th.textContent="Approved Extra";header.appendChild(th);
 }
 let weekIndex=0;
 for(const row of document.querySelectorAll("#timeRows tr")){
  let cell=document.createElement("td");
  if(row.classList.contains("week-total")){
   const week=currentData?.timecard_summary?.weeks?.[weekIndex];
   cell=weeklyExtraCell(week,weekIndex);
   weekIndex++;
  }else if(row.classList.contains("period-total")){
   cell.textContent=Number(currentData?.timecard_summary?.period?.cap_extra_hours||0).toFixed(2);
  }
  row.appendChild(cell);
 }
};

document.getElementById("timeRows").addEventListener("change",async event=>{
 const input=event.target;
 if(!input.matches(".weekly-extra-input"))return;
 const value=Number(input.value),max=Number(input.max);
 if(!Number.isFinite(value)||value<0||value>max||Math.abs(value*100-Math.round(value*100))>1e-6){
  showMessage(`Approved extra hours must be between 0.00 and ${max.toFixed(2)} in hundredths`,"error");
  await loadTimecard();return;
 }
 input.disabled=true;
 try{
  await jsonOrError(await apiFetch(`${apiBase}/supervisor/weekly-cap-extra`,{
   method:"POST",body:JSON.stringify({employee_id:selectedEmployeeId,week_number:Number(input.dataset.week),extra_hours:value})
  }));
  showMessage("Approved extra hours saved");
  await loadTimecard();
 }catch(err){showMessage(err.message,"error");await loadTimecard()}
});


