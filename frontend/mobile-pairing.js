(function(){
  const apiBase='/api';
  const getToken=()=>localStorage.getItem('timeclock_token');

  function authHeaders(){
    const token=getToken();
    return token?{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}:{'Content-Type':'application/json'};
  }

  function createDesktopModal(){
    if(document.getElementById('mobilePairingModal'))return document.getElementById('mobilePairingModal');
    const overlay=document.createElement('div');
    overlay.id='mobilePairingModal';
    overlay.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center;z-index:3000;padding:20px';
    overlay.innerHTML=`<div style="background:#fff;border-radius:14px;max-width:460px;width:100%;padding:28px;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.25)">
      <h2 style="margin-top:0">Phone Login Code</h2>
      <p style="margin-bottom:8px">On the phone, open <strong>Mobile Quick Punch</strong> and choose <strong>Enter Desktop Code</strong>.</p>
      <div id="mobilePairingCode" style="font-size:42px;font-weight:800;letter-spacing:.14em;margin:22px 0 8px;font-variant-numeric:tabular-nums">------</div>
      <div id="mobilePairingExpiry" style="color:#667085;margin-bottom:18px">Generating code…</div>
      <p style="font-size:14px;color:#667085">The code works once and expires after 5 minutes. Generating another code cancels this one.</p>
      <button type="button" id="mobilePairingClose" style="border:0;border-radius:9px;padding:10px 16px;font-weight:700;cursor:pointer">Close</button>
    </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#mobilePairingClose').addEventListener('click',()=>overlay.style.display='none');
    overlay.addEventListener('click',event=>{if(event.target===overlay)overlay.style.display='none'});
    return overlay;
  }

  async function generateDesktopCode(){
    const overlay=createDesktopModal();
    const codeBox=overlay.querySelector('#mobilePairingCode');
    const expiryBox=overlay.querySelector('#mobilePairingExpiry');
    overlay.style.display='flex';
    codeBox.textContent='------';
    expiryBox.textContent='Generating code…';
    try{
      const response=await fetch(`${apiBase}/auth/mobile-code`,{method:'POST',headers:authHeaders(),body:'{}'});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.error||'Unable to generate phone login code');
      const code=String(data.code||'').padStart(6,'0');
      codeBox.textContent=`${code.slice(0,3)} ${code.slice(3)}`;
      const expires=new Date(data.expires_at);
      expiryBox.textContent=`Expires at ${expires.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}`;
    }catch(err){
      codeBox.textContent='ERROR';
      expiryBox.textContent=err.message||'Unable to generate code';
    }
  }

  function installDesktopGenerator(){
    const actions=document.querySelector('.top-actions')||document.querySelector('#signedIn .actions');
    if(!actions||!getToken()||document.getElementById('mobilePairingGenerateBtn'))return;
    const button=document.createElement('button');
    button.type='button';
    button.id='mobilePairingGenerateBtn';
    button.className=actions.classList.contains('top-actions')?'btn':'secondary';
    button.textContent='Phone Login Code';
    button.title='Generate a one-time code to sign your phone into Mobile Quick Punch';
    button.addEventListener('click',generateDesktopCode);
    const printButton=[...actions.querySelectorAll('button')].find(item=>item.textContent.trim()==='Print');
    actions.insertBefore(button,printButton||actions.firstChild);
  }

  function installMobileRedeemer(){
    const signedOut=document.getElementById('signedOut');
    if(!signedOut||document.getElementById('mobilePairingCodeInput'))return;
    const box=document.createElement('div');
    box.style.cssText='margin-top:22px;padding-top:20px;border-top:1px solid #d8e0e8';
    box.innerHTML=`<h3 style="margin:0 0 8px">Enter Desktop Code</h3>
      <p class="muted" style="margin-top:0">Already signed in on a computer? Generate a Phone Login Code there and enter the 6 digits below.</p>
      <input id="mobilePairingCodeInput" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="000 000" aria-label="6-digit desktop code" style="width:100%;font-size:28px;letter-spacing:.18em;text-align:center;padding:14px;border:1px solid #b8c5d1;border-radius:10px;margin:8px 0 12px">
      <button type="button" id="mobilePairingRedeemBtn" class="signin" style="border:0;width:100%;cursor:pointer">Use Desktop Code</button>
      <div id="mobilePairingMessage" class="muted" style="margin-top:10px;min-height:20px"></div>`;
    signedOut.appendChild(box);

    const input=box.querySelector('#mobilePairingCodeInput');
    const button=box.querySelector('#mobilePairingRedeemBtn');
    const message=box.querySelector('#mobilePairingMessage');
    input.addEventListener('input',()=>{
      const digits=input.value.replace(/\D/g,'').slice(0,6);
      input.value=digits.length>3?`${digits.slice(0,3)} ${digits.slice(3)}`:digits;
    });

    async function redeem(){
      const code=input.value.replace(/\D/g,'');
      if(code.length!==6){message.textContent='Enter all 6 digits.';return}
      button.disabled=true;
      button.textContent='Connecting…';
      message.textContent='Checking code…';
      try{
        const response=await fetch(`${apiBase}/auth/mobile-code/redeem`,{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({code}),
        });
        const data=await response.json().catch(()=>({}));
        if(!response.ok)throw new Error(data.error||'Unable to use that code');
        localStorage.setItem('timeclock_token',data.token);
        message.textContent='Phone connected. Loading TimeClock…';
        window.location.reload();
      }catch(err){
        message.textContent=err.message||'Unable to use that code';
        button.disabled=false;
        button.textContent='Use Desktop Code';
      }
    }

    button.addEventListener('click',redeem);
    input.addEventListener('keydown',event=>{if(event.key==='Enter')redeem()});
  }

  function install(){
    installDesktopGenerator();
    installMobileRedeemer();
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);
  else install();
})();
