/* =====================================================================
   OSTRÁ VERZIA – prihlasovanie a ukladanie údajov cez Supabase
   (nahrádza úložisko prototypu v prehliadači)
   ===================================================================== */
const SB_URL="https://jvwyudhlpdavvwqkarcn.supabase.co";
/* verejný kľúč projektu (anon). Je určený pre prehliadač – prístup k údajom chránia pravidlá v databáze. */
const SB_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2d3l1ZGhscGRhdnZ3cWthcmNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMwNDEzNTgsImV4cCI6MjEwODYxNzM1OH0.O3c6CRw0jYjyE96cIGqXDz46z_7gaP4rd7UsEPLcsdg";
const SB=window.supabase&&window.supabase.createClient?window.supabase.createClient(SB_URL,SB_KEY,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}):null;
const MAP_KINDS=["att","trips","payProf","payMon"];                 /* objekty kľúč → hodnota, každý kľúč = 1 riadok */
const SKIP_KEYS=new Set(["users","created"]);   /* používatelia sa ukladajú do members/invites, nie do docs */
const MODS_ALL={personal:true,doprava:true,pozicovna:true,stavba:true};
let TID=null,authUser=null,myTenants=[],SNAP=new Map(),USNAP=new Map(),PSNAP="",liveCh=null,saveQ=Promise.resolve(),saveBusy=0,pendingRemote=false;
function blankState(){return {company:"",firm:{setupDone:false},users:[],projects:[],workers:[],machines:[],diary:[],tasks:[],jobs:[],weighs:[],teams:[],
  rentItems:[],rentals:[],trainings:[],att:{},trips:{},payProf:{},payMon:{},modules:{...MODS_ALL}}}
const newInvId=()=>"inv:"+(crypto.randomUUID?crypto.randomUUID():"10000000-1000-4000-8000-100000000000".replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16)));
const lsGet=k=>{try{return localStorage.getItem(k)}catch(e){return null}},lsSet=(k,v)=>{try{localStorage.setItem(k,v)}catch(e){}};

/* --- údaje firmy ↔ riadky tabuľky docs --- */
function docRows(){const out=new Map();
  for(const [k,v] of Object.entries(S)){
    if(SKIP_KEYS.has(k)||k[0]==="_"||/^mig\d*$/.test(k)||v===undefined)continue;
    if(MAP_KINDS.includes(k)&&v&&typeof v==="object"&&!Array.isArray(v)){for(const [id,d] of Object.entries(v))if(d!==undefined)out.set(k+"|"+id,{kind:k,id,project_id:null,data:d});continue}
    if(Array.isArray(v)&&v.every(x=>x&&typeof x==="object"&&typeof x.id==="string"&&x.id)){
      v.forEach((x,i)=>out.set(k+"|"+x.id,{kind:k,id:x.id,project_id:k==="projects"?x.id:(typeof x.projectId==="string"?x.projectId:null),data:x}));continue}
    out.set("meta|"+k,{kind:"meta",id:k,project_id:null,data:{v}})}
  return out}
const rowSig=r=>JSON.stringify(r.data)+"\u0001"+(r.project_id||"");
function applyRow(T,kind,id,data){
  if(kind==="meta"){T[id]=data?data.v:undefined;return}
  if(MAP_KINDS.includes(kind)){(T[kind]=T[kind]&&!Array.isArray(T[kind])?T[kind]:{})[id]=data;return}
  const a=Array.isArray(T[kind])?T[kind]:(T[kind]=[]);const i=a.findIndex(x=>x&&x.id===id);if(i>=0)a[i]=data;else a.push(data)}
function removeRow(T,kind,id){
  if(kind==="meta"){delete T[id];return}
  if(MAP_KINDS.includes(kind)){if(T[kind])delete T[kind][id];return}
  if(Array.isArray(T[kind]))T[kind]=T[kind].filter(x=>x.id!==id)}

async function loadTenant(tid){
  const rows=[];for(let from=0;;from+=1000){const {data,error}=await SB.from("docs").select("kind,id,project_id,data").eq("tenant_id",tid).order("kind").order("id").range(from,from+999);
    if(error)throw error;rows.push(...data);if(data.length<1000)break}
  const T=blankState();rows.forEach(r=>applyRow(T,r.kind,r.id,r.data));
  /* poradie stavieb a záznamov podľa času založenia, ak ho majú */
  S=T;TID=tid;lsSet("sf-tenant",tid);
  SNAP=new Map();docRows().forEach((r,k)=>SNAP.set(k,rowSig(r)));
  await loadPeople();remapInvites();await loadBilling();
  if(!S.firm||typeof S.firm!=="object")S.firm={setupDone:false};
  S.company=S.firm.name||S.company||((myTenants.find(t=>t.tenant_id===tid)||{}).tenants||{}).name||"";
}
/* --- používatelia firmy: členovia + čakajúce pozvánky --- */
function userFromMember(m){const name=[m.first_name,m.last_name].filter(Boolean).join(" ");
  const rights=m.role==="spravca"?Object.fromEntries(Object.keys(MODS_ALL).map(k=>[k,"edit"])):(m.rights||{});
  return {id:m.user_id,email:m.email||"",name:name||(m.email||"").split("@")[0],firstName:m.first_name||"",lastName:m.last_name||"",phone:m.phone||"",
    companyRole:m.role==="admin"?"admin":"clen",rights,dbRole:m.role}}
async function loadPeople(){
  const {data:ppl,error}=await SB.rpc("tenant_people",{t:TID});if(error)throw error;
  S.users=(ppl||[]).map(userFromMember);
  /* pečiatky ľudí z firmy (dozor na súpise a pozvánke na kontrolný deň) */
  const ids=S.users.map(u=>u.id);if(ids.length){const {data:st}=await SB.from("profiles").select("id,stamp").in("id",ids);(st||[]).forEach(r=>{const u=S.users.find(x=>x.id===r.id);if(u&&r.stamp)u.stamp=r.stamp})}
  const {data:inv}=await SB.from("invites").select("id,email,name,role,rights,projects,accepted_at,accepted_by").eq("tenant_id",TID);
  S._inv=inv||[];
  (inv||[]).filter(i=>!i.accepted_at).forEach(i=>S.users.push({id:"inv:"+i.id,email:i.email,name:i.name||i.email.split("@")[0],companyRole:"clen",rights:i.role==="spravca"?Object.fromEntries(Object.keys(MODS_ALL).map(k=>[k,"edit"])):(i.rights||{}),dbRole:i.role,pending:true}));
  const {data:pr}=await SB.from("profiles").select("first_name,last_name,phone,stamp").eq("id",authUser.id).maybeSingle();
  me=S.users.find(u=>u.id===authUser.id)||null;
  if(me&&pr){me.firstName=pr.first_name||"";me.lastName=pr.last_name||"";me.phone=pr.phone||"";if(pr.stamp)me.stamp=pr.stamp;me.name=[me.firstName,me.lastName].filter(Boolean).join(" ")||me.name}
  USNAP=new Map();S.users.forEach(u=>USNAP.set(u.id,JSON.stringify(userState(u))));PSNAP=JSON.stringify(profState());
  /* meno z registrácie do profilu (uloží sa pri najbližšom ukladaní) */
  const mn=authUser.user_metadata&&authUser.user_metadata.name;
  if(me&&!me.firstName&&!me.lastName&&mn){const n=mn.trim().split(/\s+/);me.firstName=n.shift()||"";me.lastName=n.join(" ");me.name=mn.trim()}}
/* prijaté pozvánky: dočasné id "inv:…" na stavbách nahradiť skutočným používateľom */
function remapInvites(){const acc=(S._inv||[]).filter(i=>i.accepted_by);if(!acc.length)return;const M=Object.fromEntries(acc.map(i=>["inv:"+i.id,i.accepted_by]));
  S.projects.forEach(p=>(p.members||[]).forEach(m=>{if(M[m.userId]){m.userId=M[m.userId];if(m.status==="pozvaný")m.status="aktívny"}}));
  (S.tasks||[]).forEach(t=>["assignee","assignedTo","by","doneBy"].forEach(k=>{if(M[t[k]])t[k]=M[t[k]]}))}
function userState(u){const projects=S.projects.filter(p=>(p.members||[]).some(m=>m.userId===u.id)).map(p=>p.id).sort();
  let role=u.companyRole==="admin"?"admin":(u.dbRole==="spravca"&&RIGHT_MODS.every(([k])=>(u.rights||{})[k]==="edit"))?"spravca":
    (!RIGHT_MODS.some(([k])=>(u.rights||{})[k])&&projects.length&&S.projects.filter(p=>projects.includes(p.id)).every(p=>p.members.find(m=>m.userId===u.id).role==="dozor"))?"dozor":"clen";
  return {role,rights:role==="admin"?{}:(u.rights||{}),projects}}
function profState(){return me?{first_name:me.firstName||null,last_name:me.lastName||null,phone:me.phone||null,stamp:me.stamp||null}:{}}

/* --- ukladanie: rozdiel oproti poslednému stavu z databázy --- */
function save(){if(!TID||!SB)return true;saveBusy++;setSaving(true);
  saveQ=saveQ.then(doSave).catch(e=>{console.error(e);toast("Zmenu sa nepodarilo uložiť: "+errText(e))}).finally(()=>{if(--saveBusy===0){setSaving(false);if(pendingRemote)flushRemote()}});return true}
async function doSave(){const rows=docRows(),ups=[],dels=[];
  rows.forEach((r,k)=>{const s=rowSig(r);if(SNAP.get(k)!==s)ups.push({k,s,row:{tenant_id:TID,kind:r.kind,id:r.id,project_id:r.project_id,data:r.data}})});
  SNAP.forEach((s,k)=>{if(!rows.has(k))dels.push(k)});
  /* najprv používatelia (práva na stavby), potom údaje */
  await syncUsers();await syncProfile();
  let batch=[],size=0;const flush=async()=>{if(!batch.length)return;const b=batch;batch=[];size=0;
    const {error}=await SB.from("docs").upsert(b.map(x=>x.row),{onConflict:"tenant_id,kind,id"});if(error)throw error;b.forEach(x=>SNAP.set(x.k,x.s))};
  for(const x of ups){const n=x.s.length;if(size+n>2e6)await flush();batch.push(x);size+=n}await flush();
  const byKind={};dels.forEach(k=>{const i=k.indexOf("|");(byKind[k.slice(0,i)]=byKind[k.slice(0,i)]||[]).push(k.slice(i+1))});
  for(const [kind,ids] of Object.entries(byKind)){for(let i=0;i<ids.length;i+=100){const part=ids.slice(i,i+100);
    const {error}=await SB.from("docs").delete().eq("tenant_id",TID).eq("kind",kind).in("id",part);if(error)throw error;part.forEach(id=>SNAP.delete(kind+"|"+id))}}}
async function syncUsers(){const cur=new Map(S.users.map(u=>[u.id,u]));
  for(const u of S.users){const st=userState(u),js=JSON.stringify(st);if(USNAP.get(u.id)===js)continue;
    if(u.id.startsWith("inv:")){const row={role:st.role==="admin"?"clen":st.role,rights:st.rights,projects:st.projects,email:u.email,name:u.name||null};
      const q=USNAP.has(u.id)?SB.from("invites").update(row).eq("id",u.id.slice(4)):SB.from("invites").insert({id:u.id.slice(4),tenant_id:TID,created_by:authUser.id,...row});
      const {error}=await q;if(error)throw permErr(error,"Pozývať a meniť prístupy môže administrátor firmy.");}
    else{const {error}=await SB.from("members").update(st).eq("tenant_id",TID).eq("user_id",u.id);if(error)throw permErr(error,"Prístupy používateľov mení administrátor firmy.")}
    USNAP.set(u.id,js)}
  for(const id of [...USNAP.keys()]){if(cur.has(id))continue;
    const {error}=id.startsWith("inv:")?await SB.from("invites").delete().eq("id",id.slice(4)):await SB.from("members").delete().eq("tenant_id",TID).eq("user_id",id);
    if(error)throw permErr(error,"Používateľov odstraňuje administrátor firmy.");USNAP.delete(id)}}
async function syncProfile(){if(!me||!authUser)return;const st=profState(),js=JSON.stringify(st);if(js===PSNAP)return;
  const {error}=await SB.from("profiles").upsert({id:authUser.id,email:authUser.email,...st,updated_at:new Date().toISOString()});if(error)throw error;PSNAP=js}
function permErr(e,msg){return /row-level security|permission denied|42501/.test(String(e.message||e.code||""))?new Error(msg):e}
function errText(e){const m=String(e&&e.message||e||"");if(/Failed to fetch|NetworkError|network/i.test(m))return "nie je pripojenie na internet. Skús to znova.";return m}
function setSaving(on){const el=$("#saveInd");if(el){el.hidden=!on}}

/* --- živé zmeny od ostatných používateľov --- */
const remoteQ=[];
function subscribeLive(){if(liveCh){SB.removeChannel(liveCh);liveCh=null}
  liveCh=SB.channel("docs-"+TID).on("postgres_changes",{event:"*",schema:"public",table:"docs",filter:"tenant_id=eq."+TID},pl=>{
    const n=pl.new||{},o=pl.old||{};if(pl.eventType!=="DELETE"&&n.updated_by===authUser.id)return;remoteQ.push(pl);if(!saveBusy)flushRemote();else pendingRemote=true}).subscribe()}
function flushRemote(){pendingRemote=false;if(!remoteQ.length)return;
  const a=document.activeElement;if(a&&a.closest&&a.closest("#app")&&/INPUT|TEXTAREA|SELECT/.test(a.tagName)){setTimeout(flushRemote,2500);return}
  remoteQ.splice(0).forEach(pl=>{const r=pl.eventType==="DELETE"?pl.old:pl.new;if(!r||!r.kind)return;
    const key=(r.kind==="meta"?"meta|":r.kind+"|")+r.id;
    if(pl.eventType==="DELETE"){removeRow(S,r.kind,r.id);SNAP.delete(key)}
    else{applyRow(S,r.kind,r.id,r.data);SNAP.set(key,JSON.stringify(r.data)+"\u0001"+(r.project_id||""))}});
  render()}

/* --- prihlásenie, registrácia, výber firmy --- */
async function boot(){
  if(!SB){document.getElementById("app").innerHTML=`<div class="login"><div class="err">Nepodarilo sa načítať pripojenie k databáze. Skontroluj internet a obnov stránku.</div></div>`;return}
  view={screen:"home",auth:"loading"};render();
  SB.auth.onAuthStateChange((ev,s)=>{if(ev==="PASSWORD_RECOVERY"){me=null;TID=null;view={screen:"home",auth:"newpw"};render()}});
  const hash=location.hash||"";if(/type=recovery/.test(hash))return;
  if(/error_description=/.test(hash)){const m=decodeURIComponent((hash.match(/error_description=([^&]*)/)||[])[1]||"").replace(/\+/g," ");history.replaceState(null,"",location.pathname);view={screen:"home",auth:"login",loginErr:/expired/i.test(m)?"Odkaz v e-maile už neplatí. Prihlás sa alebo si vyžiadaj nový.":m};render();return}
  const {data:{session}}=await SB.auth.getSession();
  if(session&&session.user)await afterLogin(session.user);else{view={screen:"home",auth:"login",loginErr:""};render()}}
async function afterLogin(u){authUser=u;view={screen:"home",auth:"loading"};render();
  try{await SB.rpc("accept_invites");
    const {data:ms,error}=await SB.from("members").select("tenant_id,role,tenants(name)").eq("user_id",u.id);if(error)throw error;
    myTenants=ms||[];
    if(!myTenants.length){TID=null;S=blankState();
      me={id:u.id,email:u.email,name:(u.user_metadata&&u.user_metadata.name)||"",companyRole:"admin",rights:{}};S.users=[me];
      if(u.user_metadata&&u.user_metadata.modules)S.modules={...MODS_ALL,...u.user_metadata.modules};
      view={screen:"setup",tab:"dennik"};render();window.scrollTo(0,0);return}
    const last=lsGet("sf-tenant"),pick=myTenants.find(t=>t.tenant_id===last)||(myTenants.length===1?myTenants[0]:null);
    if(!pick){view={screen:"home",auth:"pick"};render();return}
    await openTenant(pick.tenant_id)}
  catch(e){console.error(e);view={screen:"home",auth:"login",loginErr:"Prihlásenie zlyhalo: "+errText(e)};render()}}
async function openTenant(tid){view={screen:"home",auth:"loading"};render();
  await loadTenant(tid);subscribeLive();
  if(!me){view={screen:"home",auth:"login",loginErr:"Do tejto firmy už nemáš prístup."};render();return}
  if(JSON.stringify(profState())!==PSNAP)save();
  view=needsSetup()?{screen:"setup"}:needsProfile()?{screen:"profile"}:isExternal(me)?externalStart():{screen:startScreen(),tab:"dennik"};render();window.scrollTo(0,0);
  if(/[?&]platba=/.test(location.search))afterPaymentReturn();else syncBilling()}
async function createFirm(name){
  const mods=S.modules||MODS_ALL;const {data:tid,error}=await SB.rpc("create_tenant",{p_name:name,p_modules:mods});if(error)throw error;
  const {data:ms}=await SB.from("members").select("tenant_id,role,tenants(name)").eq("user_id",authUser.id);myTenants=ms||[];
  const keepMods=S.modules;await loadTenant(tid);S.modules={...MODS_ALL,...keepMods};subscribeLive()}
async function logout(){try{if(liveCh)SB.removeChannel(liveCh)}catch(e){}liveCh=null;await saveQ.catch(()=>{});await SB.auth.signOut();
  me=null;authUser=null;TID=null;S=blankState();SNAP=new Map();USNAP=new Map();view={screen:"home",auth:"login",loginErr:""};render();window.scrollTo(0,0)}
function needsSetup(){return me&&me.companyRole==="admin"&&(!TID||!S.firm||!S.firm.setupDone)}

function authShell(title,eyebrow,body){return `<div class="login stack"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1></div>${body}</div>`}
function introHTML(){return `<div class="intro stack"><div><div class="eyebrow">Aplikácia pre stavebné firmy</div><h1 class="hero">Firma, ľudia, stroje a stavby na jednom mieste</h1></div>
    <div class="tiles"><div class="tile base">${icon("firma")}<b>Firma</b><span class="muted">Údaje o firme, zamestnanci, strojový a vozový park a používatelia s rolami. Súčasť každého predplatného.</span></div>
      ${MODULES.map(([k,l,d])=>`<div class="tile">${icon(k==="stavba"?"home":k)}<b>${l}</b><span class="muted">${d}</span></div>`).join("")}</div></div>`}
function loginHTML(){
  const A=view.auth;
  if(A==="loading")return `<div class="login stack" style="align-items:center;padding-top:60px"><div class="spinner" aria-label="Načítava sa"></div><div class="muted">Načítavam…</div></div>`;
  if(A==="register")return registerHTML();
  if(A==="checkmail")return authShell("Skontroluj e-mail","Registrácia",`<div class="card stack"><div>Na adresu <b>${esc(view.regEmail||"")}</b> sme poslali odkaz na overenie. Klikni naň a potom sa prihlás.</div>
    <div class="muted" style="font-size:13px">Ak e-mail neprišiel do pár minút, pozri priečinok Spam alebo Hromadné.</div><button class="btn" data-a="authGo" data-to="login" style="align-self:flex-start">Na prihlásenie</button></div>`);
  if(A==="newpw")return authShell("Nové heslo","Obnovenie hesla",`<form class="card stack" id="newPwForm">
      <div class="grid2"><label>Nové heslo<input id="npPw" type="password" required minlength="8" autocomplete="new-password"></label><label>Heslo znova<input id="npPw2" type="password" required minlength="8" autocomplete="new-password"></label></div>
      ${view.loginErr?`<div class="err">${esc(view.loginErr)}</div>`:""}<button class="btn primary" type="submit">Uložiť heslo a prihlásiť sa</button></form>`);
  if(A==="pick")return authShell("Vyber firmu","Máš prístup do viacerých firiem",`${myTenants.map(t=>`<button class="card demo" data-a="pickTenant" data-id="${t.tenant_id}"><span><b>${esc((t.tenants||{}).name||"Firma")}</b><br><span class="muted">${esc({admin:"administrátor",spravca:"správca",clen:"člen",dozor:"stavebný dozor"}[t.role]||t.role)}</span></span></button>`).join("")}
    <button class="linkbtn" data-a="logout" style="align-self:flex-start">Odhlásiť sa</button>`);
  return `<div class="authwrap">${introHTML()}`+authShell("Prihlásenie","Prihlás sa do svojej firmy",`
    <form class="card stack" id="loginForm">
      <label>E-mail<input id="loginEmail" type="email" placeholder="meno@firma.sk" autocomplete="username" required value="${esc(view.loginEmail||"")}"></label>
      <label>Heslo<input id="loginPw" type="password" autocomplete="current-password" required></label>
      ${view.loginErr?`<div class="err">${esc(view.loginErr)}</div>`:""}${view.loginOk?`<div class="note">${esc(view.loginOk)}</div>`:""}
      <button class="btn primary" type="submit">Prihlásiť sa</button>
      <button type="button" class="linkbtn" data-a="forgot">Zabudnuté heslo</button>
    </form>
    <div class="card stack regcta"><b>Nová firma alebo pozvaný kolega?</b><div class="muted">Firma si založí účet administrátora a kolegov potom pozve sama. Ak ťa pozvali, zaregistruj sa e-mailom, na ktorý ťa pozvali – do firmy sa pridáš automaticky.</div>
      <button class="btn" data-a="authGo" data-to="register" style="align-self:flex-start">Zaregistrovať sa</button></div>`)+`</div>`}
function registerHTML(){
  return authShell("Registrácia","Nový účet",`
    <form class="card stack" id="registerForm">
      <label>Meno a priezvisko<input id="rgName" required autocomplete="name"></label>
      <label>E-mail<input id="rgEmail" type="email" required autocomplete="username" placeholder="meno@firma.sk"></label>
      <div class="grid2"><label>Heslo<input id="rgPw" type="password" required minlength="8" autocomplete="new-password"></label>
        <label>Heslo znova<input id="rgPw2" type="password" required minlength="8" autocomplete="new-password"></label></div>
      <span class="hint">Aspoň 8 znakov.</span>
      <fieldset class="modes"><legend>Moduly (pri založení novej firmy)</legend><div class="muted" style="font-size:13px">Karta Firma je vždy súčasťou. Ak ťa do firmy pozvali, moduly neriešiš – nastavuje ich administrátor.</div>${modChecks("rg",ALL_MODS)}</fieldset>
      <label class="chk"><input type="checkbox" id="rgGdpr" required> Súhlasím s podmienkami používania a so spracovaním osobných údajov</label>
      ${view.loginErr?`<div class="err">${esc(view.loginErr)}</div>`:""}
      <button class="btn primary" type="submit">Vytvoriť účet</button>
      <div class="muted" style="font-size:13px">Na e-mail príde odkaz na overenie adresy. Po prihlásení zadáš údaje o firme, alebo sa rovno otvorí firma, kam ťa pozvali.</div>
    </form>
    <button class="linkbtn" data-a="authGo" data-to="login" style="align-self:flex-start">← Späť na prihlásenie</button>`)}
const AUTH_ERR=m=>/Invalid login credentials/i.test(m)?"Nesprávny e-mail alebo heslo.":/Email not confirmed/i.test(m)?"E-mail ešte nie je overený. Klikni na odkaz v e-maile, ktorý ti prišiel po registrácii.":
  /already registered|already exists/i.test(m)?"Účet s týmto e-mailom už existuje. Prihlás sa, prípadne použi Zabudnuté heslo.":/rate limit|security purposes/i.test(m)?"Príliš veľa pokusov. Skús to o pár minút.":
  /Password should be/i.test(m)?"Heslo je príliš slabé – použi aspoň 8 znakov.":errText({message:m});
document.addEventListener("submit",ev=>{const f=ev.target.id;if(!["loginForm","registerForm","newPwForm"].includes(f))return;ev.preventDefault();ev.stopImmediatePropagation();
  (async()=>{try{
    if(f==="loginForm"){const email=$("#loginEmail").value.trim(),pw=$("#loginPw").value;view.loginEmail=email;view.loginErr="";view.loginOk="";
      const {data,error}=await SB.auth.signInWithPassword({email,password:pw});if(error){view.loginErr=AUTH_ERR(error.message);render();const el=$("#loginPw");if(el)el.focus();return}
      await afterLogin(data.user)}
    else if(f==="registerForm"){const name=$("#rgName").value.trim(),email=$("#rgEmail").value.trim().toLowerCase(),pw=$("#rgPw").value,pw2=$("#rgPw2").value;
      if(pw.length<8){view.loginErr="Heslo musí mať aspoň 8 znakov.";render();return}if(pw!==pw2){view.loginErr="Heslá sa nezhodujú.";render();return}
      const mods=readMods();if(!Object.values(mods).some(Boolean)){view.loginErr="Vyber aspoň jeden modul.";render();return}
      const {data,error}=await SB.auth.signUp({email,password:pw,options:{data:{name,modules:mods},emailRedirectTo:location.origin}});
      if(error){view.loginErr=AUTH_ERR(error.message);render();return}
      if(data.session&&data.user){await afterLogin(data.user);return}
      view={screen:"home",auth:"checkmail",regEmail:email};render();window.scrollTo(0,0)}
    else if(f==="newPwForm"){const a=$("#npPw").value,b=$("#npPw2").value;if(a.length<8){view.loginErr="Heslo musí mať aspoň 8 znakov.";render();return}if(a!==b){view.loginErr="Heslá sa nezhodujú.";render();return}
      const {data,error}=await SB.auth.updateUser({password:a});if(error){view.loginErr=AUTH_ERR(error.message);render();return}
      history.replaceState(null,"",location.pathname);toast("Heslo zmenené");await afterLogin(data.user)}
  }catch(e){console.error(e);view.loginErr=errText(e);render()}})()},true);
document.addEventListener("click",ev=>{const b=ev.target.closest("[data-a]");if(!b)return;const a=b.dataset.a;
  if(a==="forgot"){ev.stopImmediatePropagation();const em=($("#loginEmail")&&$("#loginEmail").value.trim())||"";
    if(!em){view.loginErr="Najprv napíš svoj e-mail do políčka E-mail a potom klikni na Zabudnuté heslo.";render();return}
    SB.auth.resetPasswordForEmail(em,{redirectTo:location.origin}).then(({error})=>{view.loginEmail=em;if(error){view.loginErr=AUTH_ERR(error.message);view.loginOk=""}else{view.loginErr="";view.loginOk=`Ak účet ${em} existuje, prišiel naň e-mail s odkazom na nové heslo.`}render()})}
  else if(a==="pickTenant"){ev.stopImmediatePropagation();openTenant(b.dataset.id).catch(e=>{view={screen:"home",auth:"login",loginErr:errText(e)};render()})}
  else if(a==="switchTenant"){ev.stopImmediatePropagation();saveQ.then(()=>{view={screen:"home",auth:"pick"};me=null;render()})}
  else if(a==="logout"){ev.stopImmediatePropagation();logout()}},true);

/* --- stiahnutie súboru (PDF, Excel) --- */
async function offerFile(filename,data){
  try{const blob=data instanceof Blob?data:new Blob([data],{type:/\.pdf$/i.test(filename)?"application/pdf":/\.xlsx$/i.test(filename)?"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":"application/octet-stream"});
    const url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),4000);toast("Súbor sa sťahuje")}
  catch(e){toast("Súbor sa nepodarilo stiahnuť.")}}

/* =====================================================================
   PREDPLATNÉ MODULOV (Stripe) – stav načítaný zo servera, moduly zapína len server
   ===================================================================== */
let BILL=null,PRICES=null,billBusy=false;
async function loadBilling(){if(!TID)return;const {data,error}=await SB.rpc("billing_status",{t:TID});if(!error&&data)BILL=data}
/* zosúladenie so Stripe – pri otvorení firmy a po návrate z platby (ak by potvrdenie zo Stripe meškalo) */
async function syncBilling(){if(!TID||!BILL||!BILL.has_customer)return false;try{const {data,error}=await SB.functions.invoke("billing",{body:{action:"sync",tenant_id:TID}});
  if(error||!data||!data.synced)return false;const before=JSON.stringify(BILL.active);await loadBilling();if(JSON.stringify(BILL.active)!==before){await loadTenant(TID);render()}return true}catch(e){return false}}
let STRIPE_PRICES=[];
async function loadPrices(){if(PRICES)return;PRICES={};try{const {data,error}=await SB.functions.invoke("billing",{body:{action:"prices"}});if(!error&&data&&data.prices){PRICES=data.prices;STRIPE_PRICES=data.stripePrices||[]}}catch(e){}render()}
const pricesMissing=()=>{if(!PRICES||!Object.keys(PRICES).length)return null;const miss=[];MODULES.forEach(([k])=>["month","year"].forEach(i=>{if(!(PRICES[k]&&PRICES[k][i]))miss.push(k+"_"+i)}));return miss};
const daysLeft=iso=>Math.ceil((new Date(iso)-new Date())/864e5);
const dmy=iso=>{const d=new Date(iso);return `${d.getDate()}. ${d.getMonth()+1}. ${d.getFullYear()}`};
function modStatus(k){if(!BILL)return {t:"",cls:""};const pm=(BILL.paid_modules||{})[k];
  if(BILL.complimentary)return {t:"Bezplatný prístup",cls:"s-ok"};
  if(pm&&new Date(pm.until)>new Date())return {t:`Zaplatené · ${pm.interval==="year"?"ročne":"mesačne"}`,cls:"s-ok",paid:true};
  if(BILL.trial_ends_at&&new Date(BILL.trial_ends_at)>new Date())return {t:"Skúšobné obdobie",cls:"s-wait"};
  return {t:"Nezaplatené – zamknuté",cls:"s-lock"}}
function priceTxt(k,i){const p=PRICES&&PRICES[k]&&PRICES[k][i];return p?`${p.amount.toLocaleString("sk-SK",{minimumFractionDigits:2,maximumFractionDigits:2})} € / ${i==="year"?"rok":"mesiac"}`:""}
function modulesHTML(){
  const admin=me.companyRole==="admin";if(!BILL)return `<div class="card muted">Načítavam predplatné…</div>`;
  if(PRICES===null)loadPrices();
  const B=BILL,trial=B.trial_ends_at&&new Date(B.trial_ends_at)>new Date(),hasSub=B.billing&&B.billing.subscription_id&&["active","trialing","past_due"].includes(B.billing.status);
  const D=view.billDraft||(view.billDraft={interval:(B.billing&&B.billing.interval)||"month",mods:MODULES.map(m=>m[0]).filter(k=>((B.paid_modules||{})[k])||(!hasSub&&(S.modules||{})[k]))});
  const sum=D.mods.reduce((s,k)=>s+((PRICES&&PRICES[k]&&PRICES[k][D.interval]&&PRICES[k][D.interval].amount)||0),0);
  const yearSave=(()=>{let m=0,y=0;MODULES.forEach(([k])=>{const pm=PRICES&&PRICES[k];if(pm&&pm.month&&pm.year){m+=pm.month.amount*12;y+=pm.year.amount}});return m&&y<m?Math.round((1-y/m)*100):0})();
  const banner=B.complimentary?`<div class="note">Firma má <b>bezplatný prístup</b> ku všetkým modulom.</div>`
    :trial?`<div class="note"><b>Skúšobné obdobie do ${dmy(B.trial_ends_at)}</b> – zostáva ${daysLeft(B.trial_ends_at)} ${pl(daysLeft(B.trial_ends_at),"deň","dni","dní")}. Všetky moduly sú dovtedy dostupné. ${admin?"Moduly, ktoré chceš používať aj potom, si predplať nižšie.":""}</div>`
    :hasSub?(B.billing.status==="past_due"?`<div class="note cnote hard"><b>Platba za predplatné neprešla.</b> Skontroluj platobnú kartu v správe predplatného, inak sa moduly o pár dní zamknú.</div>`:B.billing.cancel_at_period_end?`<div class="note cnote">Predplatné je zrušené ku koncu obdobia. Moduly fungujú do dátumu uvedeného pri module.</div>`:"")
    :`<div class="note cnote hard"><b>Skúšobné obdobie skončilo.</b> ${admin?"Vyber moduly a predplať si ich – údaje ostali uložené a po zaplatení budú znova k dispozícii.":"Administrátor firmy môže moduly predplatiť v tejto karte."}</div>`;
  const cards=MODULES.map(([k,l,d])=>{const st=modStatus(k),pm=(B.paid_modules||{})[k],on=D.mods.includes(k);
    return `<label class="modcard bill ${on?"on":""}">${admin&&!B.complimentary?`<input type="checkbox" data-bmod="${k}" ${on?"checked":""}>`:""}<span style="flex:1;min-width:0"><b>${l}</b> <span class="pill ${st.cls}">${esc(st.t)}</span><br><span class="muted">${esc(d)}</span>
      ${pm&&st.paid?`<br><span class="muted" style="font-size:12.5px">Predplatené do ${dmy(new Date(new Date(pm.until)-3*864e5).toISOString())}</span>`:""}</span>
      <span class="bprice">${priceTxt(k,D.interval)}</span></label>`}).join("");
  return `<div class="stack"><div class="card stack"><h2>Moduly a predplatné</h2>
    <div class="muted">Karta Firma (údaje o firme, zamestnanci, strojový a vozový park, používatelia) je zadarmo. Ostatné moduly si firma predplatí podľa potreby – jeden, viac alebo všetky.</div>
    ${banner}
    ${admin&&!B.complimentary?`<div class="seg" role="radiogroup" style="align-self:flex-start"><label><input type="radio" name="bInt" value="month" ${D.interval==="month"?"checked":""}><span>Mesačne</span></label><label><input type="radio" name="bInt" value="year" ${D.interval==="year"?"checked":""}><span>Ročne${yearSave?` (−${yearSave} %)`:""}</span></label></div>`:""}
    <div class="mods">${cards}</div>
    ${admin&&!B.complimentary?`${PRICES&&!Object.keys(PRICES).length?`<div class="note cnote">Ceny sa nepodarilo načítať zo Stripe. Platbu zatiaľ nie je možné spustiť.</div>`:""}
      ${(()=>{const miss=pricesMissing();if(!miss||!miss.length)return "";
        return `<div class="note cnote hard"><b>V Stripe chýbajú ceny s kľúčom (Lookup key):</b> ${miss.map(x=>`<code>${x}</code>`).join(", ")}.
          ${STRIPE_PRICES.length?`<div style="margin-top:6px">Ceny, ktoré v Stripe sú:</div><ul style="margin:4px 0 0 18px">${STRIPE_PRICES.map(p=>`<li>${esc(p.product||"?")} – ${p.amount.toLocaleString("sk-SK",{minimumFractionDigits:2})} € / ${p.interval==="year"?"rok":p.interval==="month"?"mesiac":esc(p.interval)} – lookup key: <b>${p.lookup_key?esc(p.lookup_key):"nevyplnený"}</b></li>`).join("")}</ul>`:`<div style="margin-top:6px">V Stripe (v režime, ktorého kľúč je v Supabase) sa nenašla žiadna opakovaná cena.</div>`}
          <div style="margin-top:6px">Doplň kľúč pri každej cene v Stripe: produkt → cena → ⋯ Edit price → Lookup key.</div></div>`})()}
      <div class="row"><b>Spolu: ${sum.toLocaleString("sk-SK",{minimumFractionDigits:2,maximumFractionDigits:2})} € / ${D.interval==="year"?"rok":"mesiac"}</b><span class="muted" style="font-size:13px">${PRICES&&Object.keys(PRICES).length?"bez DPH":""}</span></div>
      ${view.payUrl?`<div class="note">Otváram platobnú stránku Stripe… Ak sa neotvorila sama, <a href="${esc(view.payUrl)}" rel="noopener"><b>klikni sem</b></a>.</div>`:""}
      <div class="row"><button class="btn primary" data-a="billPay" ${billBusy||!D.mods.length?"disabled":""}>${billBusy?"Pripravujem…":hasSub?"Uložiť zmenu predplatného":"Prejsť na platbu"}</button>
        ${B.has_customer?`<button class="btn" data-a="billPortal" ${billBusy?"disabled":""}>Platobná karta, faktúry a zrušenie</button><button class="btn ghost" data-a="billSync" ${billBusy?"disabled":""}>Obnoviť stav platby</button>`:""}</div>
      <div class="muted" style="font-size:13px">${hasSub?"Pri pridaní modulu sa doplatí len pomerná časť do konca obdobia, pri odobratí sa zvyšok odpočíta z ďalšej platby.":"Platbu spracúva Stripe – údaje o karte sa v aplikácii neukladajú. Predplatné sa obnovuje automaticky a dá sa kedykoľvek zrušiť."} Vypnutím modulu sa údaje nezmažú.</div>`
      :!admin?`<div class="muted" style="font-size:13px">Predplatné spravuje administrátor firmy.</div>`:""}
  </div></div>`}
async function billCall(body){billBusy=true;render();
  try{const {data,error}=await SB.functions.invoke("billing",{body:{...body,tenant_id:TID}});
    if(error){let msg=error.message;try{const j=await error.context.json();if(j&&j.error)msg=j.error}catch(e){}throw new Error(msg)}
    if(data&&data.error)throw new Error(data.error);return data}
  finally{billBusy=false}}
document.addEventListener("click",ev=>{const b=ev.target.closest("[data-a]");if(!b||!me)return;const a=b.dataset.a;
  if(a==="billPay"){ev.stopImmediatePropagation();const D=view.billDraft;
    billCall({action:"checkout",modules:D.mods,interval:D.interval}).then(async d=>{if(d.url){view.payUrl=d.url;render();location.assign(d.url);return}
      if(d.updated){await loadBilling();view.billDraft=null;toast("Predplatné upravené");render()}}).catch(e=>{toast("Platbu sa nepodarilo pripraviť: "+e.message);render()})}
  else if(a==="billSync"){ev.stopImmediatePropagation();billBusy=true;render();syncBilling().then(ok=>{billBusy=false;view.billDraft=null;toast(ok?"Stav predplatného obnovený zo Stripe":"Stav sa nepodarilo obnoviť");render()})}
  else if(a==="billPortal"){ev.stopImmediatePropagation();billCall({action:"portal"}).then(d=>{if(d.url){view.payUrl=d.url;render();location.assign(d.url)}}).catch(e=>{toast("Správu predplatného sa nepodarilo otvoriť: "+e.message);render()})}},true);
document.addEventListener("change",ev=>{const t=ev.target;if(!me||!view.billDraft)return;
  if(t.dataset&&t.dataset.bmod){const D=view.billDraft;D.mods=t.checked?[...new Set([...D.mods,t.dataset.bmod])]:D.mods.filter(x=>x!==t.dataset.bmod);render()}
  else if(t.name==="bInt"){view.billDraft.interval=t.value;render()}});
/* návrat zo Stripe */
async function afterPaymentReturn(){const q=new URLSearchParams(location.search),r=q.get("platba");if(!r)return;history.replaceState(null,"",location.pathname);
  view={screen:"firma",firmTab:"moduly"};
  if(r==="zrusena"){toast("Platba bola zrušená, nič sa nezaplatilo.");render();return}
  if(r==="ok"){toast("Ďakujeme, platba prebehla. Zapínam moduly…");for(let i=0;i<10;i++){await loadBilling();if(!(BILL&&Object.keys(BILL.paid_modules||{}).length)&&i>=1)await syncBilling();render();if(BILL&&Object.keys(BILL.paid_modules||{}).length)break;await new Promise(z=>setTimeout(z,2000))}
    view.billDraft=null;await loadTenant(TID);render();return}
  await syncBilling();await loadBilling();render()}
