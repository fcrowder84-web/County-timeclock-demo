"use strict";
function weeklyExtraCell(week,index){
 const value=Number(week?.cap_extra_hours||0);
 const cap=week?.weekly_hours_cap;
 const cell=document.createElement("td");
 if(cap==null) return cell;
 cell.textContent=value.toFixed(2);
 return cell;
}
