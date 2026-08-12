'use strict';

function formatDateOnly(value){
  if(!value) return null;
  const date=value instanceof Date?value:new Date(`${String(value).slice(0,10)}T12:00:00Z`);
  if(Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0,10);
}

function resolvePayPeriod({anchorDate,periodDays,targetDate,requestedStart=null}){
  const anchor=new Date(`${formatDateOnly(anchorDate)}T12:00:00Z`);
  const days=Number(periodDays);
  const targetText=requestedStart?String(requestedStart).slice(0,10):formatDateOnly(targetDate);
  const target=new Date(`${targetText}T12:00:00Z`);
  if(!Number.isInteger(days)||days<=0||Number.isNaN(anchor.getTime())||Number.isNaN(target.getTime())){
    const error=new Error('Invalid pay period configuration or date');
    error.statusCode=400;
    throw error;
  }
  const dayMs=24*60*60*1000;
  const daysFromAnchor=Math.floor((target.getTime()-anchor.getTime())/dayMs);
  const periodIndex=Math.floor(daysFromAnchor/days);
  const start=new Date(anchor.getTime()+periodIndex*days*dayMs);
  const end=new Date(start.getTime()+(days-1)*dayMs);
  if(requestedStart&&formatDateOnly(start)!==String(requestedStart).slice(0,10)){
    const error=new Error('Pay period start does not match the configured schedule');
    error.statusCode=400;
    throw error;
  }
  return {pay_period_start:formatDateOnly(start),pay_period_end:formatDateOnly(end),period_days:days};
}

function shiftDate(dateString,days){
  const date=new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate()+Number(days));
  return formatDateOnly(date);
}

module.exports={formatDateOnly,resolvePayPeriod,shiftDate};
