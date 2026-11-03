"use strict";
function weeklyExtraCell(week,index){
 const value=Number(week?.cap_extra_hours||0);
 const cap=week?.weekly_hours_cap;
 const cell=document.createElement("td");
 if(cap==null) return cell;
 cell.textContent=value.toFixed(2);
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
