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

/* --- súbory stavby (výkresy) v Supabase Storage: priečinok firma/stavba, prístup podľa pravidiel v databáze --- */
const FILESTORE={bucket:"dokumentacia",
  async put(path,file){const {error}=await SB.storage.from(this.bucket).upload(path,file,{upsert:false,contentType:file.type||"application/octet-stream",cacheControl:"3600"});if(error)throw error},
  async url(path,name,download){const {data,error}=await SB.storage.from(this.bucket).createSignedUrl(path,600,download?{download:name||true}:undefined);if(error)throw error;return data.signedUrl},
  async del(path){const {error}=await SB.storage.from(this.bucket).remove([path]);if(error)throw error}};
/* --- údaje firmy ↔ riadky tabuľky docs --- */
function docRows(){const out=new Map();
  for(const [k,v] of Object.entries(S)){
    if(SKIP_KEYS.has(k)||k[0]==="_"||/^mig\d*$/.test(k)||v===undefined)continue;
    if(MAP_KINDS.includes(k)&&v&&typeof v==="object"&&!Array.isArray(v)){for(const [id,d] of Object.entries(v))if(d!==undefined)out.set(k+"|"+id,{kind:k,id,project_id:null,data:d});continue}
    /* stavba: rozpočet a súpisy generálneho zhotoviteľa v samostatnom riadku „projfin“ – subdodávateľ s pridelenou časťou ho v databáze nevidí */
    if(k==="projects"&&Array.isArray(v)){v.forEach(x=>{if(!x||typeof x.id!=="string")return;const {budget,invoices,...rest}=x;out.set("projects|"+x.id,{kind:"projects",id:x.id,project_id:x.id,data:rest});
      if(budget||(invoices&&invoices.length))out.set("projfin|"+x.id,{kind:"projfin",id:x.id,project_id:x.id,data:{budget:budget||null,invoices:invoices||[]}})});continue}
    if(Array.isArray(v)&&v.every(x=>x&&typeof x==="object"&&typeof x.id==="string"&&x.id)){
      v.forEach((x,i)=>out.set(k+"|"+x.id,{kind:k,id:x.id,project_id:k==="projects"?x.id:(typeof x.projectId==="string"?x.projectId:null),data:x}));continue}
    out.set("meta|"+k,{kind:"meta",id:k,project_id:null,data:{v}})}
  return out}
const rowSig=r=>JSON.stringify(r.data)+"\u0001"+(r.project_id||"");
function applyRow(T,kind,id,data){
  if(kind==="meta"){T[id]=data?data.v:undefined;return}
  if(kind==="projfin"){const p=(Array.isArray(T.projects)?T.projects:[]).find(x=>x&&x.id===id);if(p){p.budget=data&&data.budget||undefined;p.invoices=data&&data.invoices||undefined;if(p.budget===undefined)delete p.budget;if(p.invoices===undefined)delete p.invoices}else(T._pf=T._pf||{})[id]=data;return}
  if(kind==="projects"&&data&&!("budget" in data)&&!("invoices" in data)){const a=Array.isArray(T.projects)?T.projects:(T.projects=[]);const i=a.findIndex(x=>x&&x.id===id),old=i>=0?a[i]:null,pf=T._pf&&T._pf[id];
    const nd={...data};if(pf){if(pf.budget)nd.budget=pf.budget;if(pf.invoices)nd.invoices=pf.invoices;delete T._pf[id]}else if(old){if(old.budget)nd.budget=old.budget;if(old.invoices)nd.invoices=old.invoices}
    if(i>=0)a[i]=nd;else a.push(nd);return}
  if(MAP_KINDS.includes(kind)){(T[kind]=T[kind]&&!Array.isArray(T[kind])?T[kind]:{})[id]=data;return}
  const a=Array.isArray(T[kind])?T[kind]:(T[kind]=[]);const i=a.findIndex(x=>x&&x.id===id);if(i>=0)a[i]=data;else a.push(data)}
function removeRow(T,kind,id){
  if(kind==="meta"){delete T[id];return}
  if(kind==="projfin"){const p=(T.projects||[]).find(x=>x&&x.id===id);if(p){delete p.budget;delete p.invoices}return}
  if(MAP_KINDS.includes(kind)){if(T[kind])delete T[kind][id];return}
  if(Array.isArray(T[kind]))T[kind]=T[kind].filter(x=>x.id!==id)}

/* --- offline: údaje firmy uložené v zariadení (IndexedDB); pri ďalšom otvorení sa stiahnu len zmenené riadky --- */
const OFF={db:null,
  open(){return this.db||(this.db=new Promise((res,rej)=>{const r=indexedDB.open("sf-cache",1);r.onupgradeneeded=()=>r.result.createObjectStore("c");r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)}))},
  async run(mode,fn){const d=await this.open();return new Promise((res,rej)=>{const t=d.transaction("c",mode);const q=fn(t.objectStore("c"));t.oncomplete=()=>res(q&&q.result);t.onerror=()=>rej(t.error)})},
  async get(k){try{return await this.run("readonly",o=>o.get(k))}catch(e){return null}},
  async put(k,v){try{await this.run("readwrite",o=>o.put(v,k))}catch(e){console.warn("cache",e)}},
  async clear(){try{await this.run("readwrite",o=>o.clear())}catch(e){}}};
let VER=new Map(),OFFLINE=false,FROM_CACHE=false,cacheT=null;
const cacheKey=tid=>"t:"+((authUser&&authUser.id)||lsGet("sf-uid")||"")+":"+tid;
const isNetErr=e=>!navigator.onLine||/Failed to fetch|NetworkError|network|Load failed|fetch/i.test(String(e&&e.message||e||""));
function cacheNow(){if(!TID)return;clearTimeout(cacheT);cacheT=setTimeout(()=>{if(!TID)return;let snapS;try{snapS=structuredClone(S)}catch(e){snapS=JSON.parse(JSON.stringify(S))}
  OFF.put(cacheKey(TID),{at:Date.now(),S:snapS,snap:[...SNAP],ver:[...VER],usnap:[...USNAP],psnap:PSNAP,me:me&&me.id,tenants:myTenants,bill:typeof BILL!=="undefined"?BILL:null})},300)}
async function listVersions(tid){const out=[];for(let from=0;;from+=1000){const {data,error}=await SB.from("docs").select("kind,id,updated_at").eq("tenant_id",tid).order("kind").order("id").range(from,from+999);
  if(error)throw error;out.push(...data);if(data.length<1000)break}return out}
async function loadTenant(tid){
  const C=await OFF.get(cacheKey(tid));let T,LEG=[];
  if(C&&C.S&&C.ver&&C.ver.length){
    /* zmeny urobené offline najprv odoslať */
    S=C.S;TID=tid;SNAP=new Map(C.snap||[]);VER=new Map(C.ver);USNAP=new Map(C.usnap||[]);PSNAP=C.psnap||"";
    const pend=[...docRows()].some(([k,r])=>SNAP.get(k)!==rowSig(r))||[...SNAP.keys()].some(k=>!docRows().has(k));
    if(pend){try{await doDocs()}catch(e){console.warn("pending",e)}}
    const list=await listVersions(tid),now=new Map(list.map(r=>[r.kind+"|"+r.id,r.updated_at]));
    T=S;VER.forEach((v,k)=>{if(!now.has(k)){const i=k.indexOf("|"),kind=k.slice(0,i),id=k.slice(i+1);removeRow(T,kind==="meta"?"meta":kind,id);SNAP.delete(k)}});
    const need={};list.forEach(r=>{const k=r.kind+"|"+r.id;if(VER.get(k)!==r.updated_at)(need[r.kind]=need[r.kind]||[]).push(r.id)});
    for(const [kind,ids] of Object.entries(need))for(let i=0;i<ids.length;i+=150){const {data,error}=await SB.from("docs").select("kind,id,project_id,data,updated_at").eq("tenant_id",tid).eq("kind",kind).in("id",ids.slice(i,i+150));if(error)throw error;
      data.forEach(r=>{applyRow(T,r.kind,r.id,r.data);SNAP.set((r.kind==="meta"?"meta|":r.kind+"|")+r.id,rowSig(r))})}
    VER=now}
  else{const rows=[];for(let from=0;;from+=1000){const {data,error}=await SB.from("docs").select("kind,id,project_id,data,updated_at").eq("tenant_id",tid).order("kind").order("id").range(from,from+999);
      if(error)throw error;rows.push(...data);if(data.length<1000)break}
    T=blankState();rows.forEach(r=>applyRow(T,r.kind,r.id,r.data));
    LEG=rows.filter(r=>r.kind==="projects"&&r.data&&("budget" in r.data||"invoices" in r.data)).map(r=>r.id);   /* staršie stavby: rozpočet ešte v riadku stavby */VER=new Map(rows.map(r=>[r.kind+"|"+r.id,r.updated_at]))}
  const full=!(C&&C.S&&C.ver&&C.ver.length);S=T;TID=tid;lsSet("sf-tenant",tid);FROM_CACHE=false;
  if(full){SNAP=new Map();docRows().forEach((r,k)=>SNAP.set(k,rowSig(r)));LEG.forEach(id=>{SNAP.delete("projects|"+id);SNAP.delete("projfin|"+id)})}
  if(LEG.length)setTimeout(()=>{try{save()}catch(e){}},1500);   /* presunúť rozpočet a súpisy do samostatného riadku */
  await loadPeople();remapInvites();await loadBilling();
  if(!S.firm||typeof S.firm!=="object")S.firm={setupDone:false};
  S.company=S.firm.name||S.company||((myTenants.find(t=>t.tenant_id===tid)||{}).tenants||{}).name||"";
  cacheNow()}
/* otvorenie firmy bez internetu z údajov v zariadení */
async function openFromCache(){const tid=lsGet("sf-tenant"),uid=lsGet("sf-uid");if(!tid||!uid)return false;const C=await OFF.get("t:"+uid+":"+tid);if(!C||!C.S)return false;
  S=C.S;TID=tid;SNAP=new Map(C.snap||[]);VER=new Map(C.ver||[]);USNAP=new Map(C.usnap||[]);PSNAP=C.psnap||"";myTenants=C.tenants||[];if(C.bill&&typeof BILL!=="undefined")BILL=C.bill;
  me=(S.users||[]).find(u=>u.id===C.me)||null;if(!me)return false;authUser=authUser||{id:uid,email:me.email};FROM_CACHE=true;setOffline(true);
  view=isExternal(me)?externalStart():{screen:startScreen(),tab:"dennik"};render();return true}
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
  const {data:pr}=await SB.from("profiles").select("first_name,last_name,phone,stamp,prefs").eq("id",authUser.id).maybeSingle();
  me=S.users.find(u=>u.id===authUser.id)||null;
  if(me&&pr){me.firstName=pr.first_name||"";me.lastName=pr.last_name||"";me.phone=pr.phone||"";if(pr.stamp)me.stamp=pr.stamp;if(pr.prefs&&pr.prefs.dash)me.dash=pr.prefs.dash;me.name=[me.firstName,me.lastName].filter(Boolean).join(" ")||me.name}
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
    (!RIGHT_MODS.some(([k])=>(u.rights||{})[k])&&projects.length&&S.projects.filter(p=>projects.includes(p.id)).every(p=>["dozor","extsv"].includes(p.members.find(m=>m.userId===u.id).role)))?"dozor":"clen";   /* externí (dozor, externý stavbyvedúci) – v databáze rola „dozor“: len svoje stavby */
  let rights=role==="admin"?{}:{...(u.rights||{})};delete rights.areas;
  if(role==="dozor"){const A={};S.projects.forEach(p=>{const m=(p.members||[]).find(x=>x.userId===u.id&&x.role==="extsv");if(m&&m.areaIds&&m.areaIds.length)A[p.id]=m.areaIds.slice().sort()});if(Object.keys(A).length)rights.areas=A}
  return {role,rights,projects}}
function profState(){return me?{first_name:me.firstName||null,last_name:me.lastName||null,phone:me.phone||null,stamp:me.stamp||null,prefs:me.dash?{dash:me.dash}:null}:{}}

/* --- ukladanie: rozdiel oproti poslednému stavu z databázy --- */
function save(){if(!TID||!SB)return true;cacheNow();if(OFFLINE&&!navigator.onLine){setSaving(false);return true}saveBusy++;setSaving(true);
  saveQ=saveQ.then(doSave).then(()=>{if(OFFLINE)setOffline(false);cacheNow()}).catch(e=>{console.error(e);if(isNetErr(e)){setOffline(true);cacheNow()}else toast("Zmenu sa nepodarilo uložiť: "+errText(e))}).finally(()=>{if(--saveBusy===0){setSaving(false);if(pendingRemote)flushRemote()}});return true}
async function doSave(){await syncUsers();await syncProfile();await doDocs();await syncOffers()}
/* --- ponuka strojov: stroje označené „Stroj v ponuke“ sa kopírujú do tabuľky offers, ktorú vidia všetci --- */
let OFFERS=[],OSNAP=null,offersAt=0;
async function syncOffers(){if(!TID||typeof offerFromMachine!=="function")return;const mine=(S.machines||[]).filter(m=>m.offer).map(m=>({id:m.id,data:offerFromMachine(m)}));
  const sig=JSON.stringify(mine);if(sig===OSNAP)return;
  try{const {data:cur,error:e0}=await SB.from("offers").select("id").eq("tenant_id",TID);if(e0)throw e0;
    if(mine.length){const {error}=await SB.from("offers").upsert(mine.map(o=>({tenant_id:TID,id:o.id,data:{...o.data,own:false},updated_at:new Date().toISOString()})),{onConflict:"tenant_id,id"});if(error)throw error}
    const gone=(cur||[]).map(r=>r.id).filter(id=>!mine.some(o=>o.id===id));if(gone.length){const {error}=await SB.from("offers").delete().eq("tenant_id",TID).in("id",gone);if(error)throw error}
    OSNAP=sig}catch(e){console.warn("ponuka strojov",e)}}
async function loadOffers(force){if(!SB||(!force&&Date.now()-offersAt<120000))return;offersAt=Date.now();
  try{const {data,error}=await SB.from("offers").select("tenant_id,id,data").limit(1000);if(error)throw error;OFFERS=(data||[]).map(r=>({...r.data,id:r.tenant_id+"|"+r.id,tenant:r.tenant_id,own:false}));render()}catch(e){console.warn("ponuka strojov",e)}}
async function doDocs(){const rows=docRows(),ups=[],dels=[];
  const ro=r=>(r.kind==="projects"||r.kind==="projfin")&&typeof isSubOf==="function"&&isSubOf((S.projects||[]).find(x=>x.id===r.id));
  rows.forEach((r,k)=>{const s=rowSig(r);if(SNAP.get(k)!==s&&!ro(r))ups.push({k,s,row:{tenant_id:TID,kind:r.kind,id:r.id,project_id:r.project_id,data:r.data}})});
  SNAP.forEach((s,k)=>{if(rows.has(k))return;const i=k.indexOf("|");if(!ro({kind:k.slice(0,i),id:k.slice(i+1)}))dels.push(k)});
  let batch=[],size=0;const flush=async()=>{if(!batch.length)return;const b=batch;batch=[];size=0;
    const {data,error}=await SB.from("docs").upsert(b.map(x=>x.row),{onConflict:"tenant_id,kind,id"}).select("kind,id,updated_at");if(error)throw error;b.forEach(x=>SNAP.set(x.k,x.s));(data||[]).forEach(r=>VER.set(r.kind+"|"+r.id,r.updated_at))};
  for(const x of ups){const n=x.s.length;if(size+n>2e6)await flush();batch.push(x);size+=n}await flush();
  const byKind={};dels.forEach(k=>{const i=k.indexOf("|");(byKind[k.slice(0,i)]=byKind[k.slice(0,i)]||[]).push(k.slice(i+1))});
  for(const [kind,ids] of Object.entries(byKind)){for(let i=0;i<ids.length;i+=100){const part=ids.slice(i,i+100);
    const {error}=await SB.from("docs").delete().eq("tenant_id",TID).eq("kind",kind).in("id",part);if(error)throw error;part.forEach(id=>{SNAP.delete(kind+"|"+id);VER.delete(kind+"|"+id)})}}}
async function syncUsers(){const cur=new Map(S.users.map(u=>[u.id,u]));
  for(const u of S.users){const st=userState(u),js=JSON.stringify(st);if(USNAP.get(u.id)===js)continue;
    if(u.id.startsWith("inv:")){const row={role:st.role==="admin"?"clen":st.role,rights:st.rights,projects:st.projects,email:u.email,name:u.name||null};
      const q=USNAP.has(u.id)?SB.from("invites").update(row).eq("id",u.id.slice(4)):SB.from("invites").insert({id:u.id.slice(4),tenant_id:TID,created_by:authUser.id,...row});
      const isNew=!USNAP.has(u.id);const {error}=await q;if(error)throw permErr(error,"Pozývať a meniť prístupy môže administrátor firmy.");if(isNew)sendInvite(u.id.slice(4),u.email);}
    else{const {error}=await SB.from("members").update(st).eq("tenant_id",TID).eq("user_id",u.id);if(error)throw permErr(error,"Prístupy používateľov mení administrátor firmy.")}
    USNAP.set(u.id,js)}
  for(const id of [...USNAP.keys()]){if(cur.has(id))continue;
    const {error}=id.startsWith("inv:")?await SB.from("invites").delete().eq("id",id.slice(4)):await SB.from("members").delete().eq("tenant_id",TID).eq("user_id",id);
    if(error)throw permErr(error,"Používateľov odstraňuje administrátor firmy.");USNAP.delete(id)}}
async function syncProfile(){if(!me||!authUser)return;const st=profState(),js=JSON.stringify(st);if(js===PSNAP)return;
  const {error}=await SB.from("profiles").upsert({id:authUser.id,email:authUser.email,...st,updated_at:new Date().toISOString()});if(error)throw error;PSNAP=js}
function permErr(e,msg){return /row-level security|permission denied|42501/.test(String(e.message||e.code||""))?new Error(msg):e}
function errText(e){const m=String(e&&e.message||e||"");if(/Failed to fetch|NetworkError|network/i.test(m))return "nie je pripojenie na internet. Skús to znova.";return m}
function setSaving(on){const el=$("#saveInd");if(el){el.hidden=!on&&!OFFLINE;el.textContent=OFFLINE?"Offline":"Ukladám…";el.title=OFFLINE?"Bez pripojenia – zmeny sú uložené v zariadení a odošlú sa po pripojení":"";el.classList.toggle("off",OFFLINE)}}
function setOffline(on){if(OFFLINE===on)return setSaving(saveBusy>0);OFFLINE=on;setSaving(saveBusy>0);if(on)toast("Si offline. Zápisy sa ukladajú v zariadení a odošlú sa po pripojení.")}
window.addEventListener("online",async()=>{if(!TID||!me)return;try{if(FROM_CACHE){const {data:{session}}=await SB.auth.getSession();if(!session){view={screen:"home",auth:"login",loginErr:"Prihlásenie vypršalo. Prihlás sa znova – zápisy z offline režimu ostali v zariadení a odošlú sa."};me=null;render();return}
    authUser=session.user;await openTenant(TID);setOffline(false);toast("Pripojenie obnovené – zmeny odoslané")}else{save();await saveQ;if(!OFFLINE)toast("Pripojenie obnovené – zmeny odoslané")}}catch(e){console.warn(e)}});
window.addEventListener("offline",()=>{if(TID)setOffline(true)});

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
  /* odkaz z e-mailu (pozvánka / nové heslo): token sa overí až po kliknutí na tlačidlo – kontrola odkazov v e-mailových schránkach ho tak nespotrebuje */
  {const q=new URLSearchParams(location.search),th=q.get("pozvanka")||q.get("obnova");
    if(th){view={screen:"home",auth:"otp",otpType:q.get("pozvanka")?"invite":"recovery",otpHash:th,otpEmail:q.get("e")||""};render();return}}
  const hash=location.hash||"";if(/type=recovery/.test(hash))return;
  if(/type=invite/.test(hash)){view={screen:"home",auth:"newpw",invite:true};render();return}   /* odkaz z pozvánky: najprv si nastaví heslo */
  if(/error_description=/.test(hash)){const m=decodeURIComponent((hash.match(/error_description=([^&]*)/)||[])[1]||"").replace(/\+/g," ");history.replaceState(null,"",location.pathname);view={screen:"home",auth:"login",loginErr:/expired/i.test(m)?"Odkaz v e-maile už neplatí. Prihlás sa alebo si vyžiadaj nový.":m};render();return}
  if(!navigator.onLine&&await openFromCache())return;
  let session=null;try{({data:{session}}=await SB.auth.getSession())}catch(e){if(await openFromCache())return}
  if(session&&session.user)await afterLogin(session.user);else if(lsGet("sf-uid")&&!navigator.onLine&&await openFromCache())return;else{const rg=(location.search.match(/[?&]registracia=([^&]*)/)||[])[1];view={screen:"home",auth:rg!=null?"register":/[?&]prihlasenie/.test(location.search)?"login":location.hash==="#ako-to-funguje"?"howto":"landing",loginErr:"",regPrefill:rg?decodeURIComponent(rg):""};render()}}
async function afterLogin(u){authUser=u;lsSet("sf-uid",u.id);view={screen:"home",auth:"loading"};render();
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
  catch(e){console.error(e);if(isNetErr(e)&&await openFromCache())return;view={screen:"home",auth:"login",loginErr:"Prihlásenie zlyhalo: "+errText(e)};render()}}
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
  await OFF.clear();lsSet("sf-uid","");me=null;authUser=null;TID=null;S=blankState();SNAP=new Map();USNAP=new Map();VER=new Map();view={screen:"home",auth:"landing",loginErr:""};render();window.scrollTo(0,0)}
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
  if(A==="otp"){const inv=view.otpType==="invite";return authShell(inv?"Prijatie pozvánky":"Nové heslo",inv?"Pozvánka do aplikácie":"Obnovenie hesla",`<div class="card stack">
      <div>${inv?"Vitaj v aplikácii Stavebná firma. Pokračuj a nastav si heslo, ktorým sa budeš odteraz prihlasovať.":"Pokračuj a nastav si nové heslo."}${view.otpEmail?`<br><span class="muted">Účet: <b>${esc(view.otpEmail)}</b></span>`:""}</div>
      ${view.loginErr?`<div class="err">${esc(view.loginErr)}</div>`:""}
      <button class="btn primary" data-a="otpGo" ${view.otpBusy?"disabled":""} style="align-self:flex-start">${view.otpBusy?"Overujem odkaz…":inv?"Prijať pozvánku a nastaviť heslo":"Nastaviť nové heslo"}</button></div>`)}
  if(A==="newpw")return authShell(view.invite?"Nastav si heslo":"Nové heslo",view.invite?"Prijatie pozvánky":"Obnovenie hesla",`<form class="card stack" id="newPwForm">${view.invite?`<div class="muted">Vitaj v aplikácii Stavebná firma. Zvoľ si heslo, ktorým sa budeš odteraz prihlasovať. Po uložení sa ti otvorí firma, ktorá ťa pozvala.</div>`:""}
      <div class="grid2"><label>Nové heslo<input id="npPw" type="password" required minlength="8" autocomplete="new-password"></label><label>Heslo znova<input id="npPw2" type="password" required minlength="8" autocomplete="new-password"></label></div>
      ${view.loginErr?`<div class="err">${esc(view.loginErr)}</div>`:""}<button class="btn primary" type="submit">Uložiť heslo a prihlásiť sa</button></form>`);
  if(A==="pick")return authShell("Vyber firmu","Máš prístup do viacerých firiem",`${myTenants.map(t=>`<button class="card demo" data-a="pickTenant" data-id="${t.tenant_id}"><span><b>${esc((t.tenants||{}).name||"Firma")}</b><br><span class="muted">${esc({admin:"administrátor",spravca:"správca",clen:"člen",dozor:"stavebný dozor"}[t.role]||t.role)}</span></span></button>`).join("")}
    <button class="linkbtn" data-a="logout" style="align-self:flex-start">Odhlásiť sa</button>`);
  return `<div class="authwrap solo"><button class="linkbtn ldback" data-a="landGo" data-to="landing">← Úvodná stránka</button>`+authShell("Prihlásenie","Prihlás sa do svojej firmy",`
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
      <label>E-mail<input id="rgEmail" type="email" required autocomplete="username" placeholder="meno@firma.sk" value="${esc(view.regPrefill||"")}"></label>
      <div class="grid2"><label>Heslo<input id="rgPw" type="password" required minlength="8" autocomplete="new-password"></label>
        <label>Heslo znova<input id="rgPw2" type="password" required minlength="8" autocomplete="new-password"></label></div>
      <span class="hint">Aspoň 8 znakov.</span>
      <fieldset class="modes"><legend>Moduly (pri založení novej firmy)</legend><div class="muted" style="font-size:13px">Karta Firma je vždy súčasťou. Ak ťa do firmy pozvali, moduly neriešiš – nastavuje ich administrátor.</div>${modChecks("rg",ALL_MODS)}</fieldset>
      <label class="chk"><input type="checkbox" id="rgGdpr" required> Súhlasím s podmienkami používania a so spracovaním osobných údajov</label>
      ${view.loginErr?`<div class="err">${esc(view.loginErr)}</div>`:""}
      <button class="btn primary" type="submit">Vytvoriť účet</button>
      <div class="muted" style="font-size:13px">Na e-mail príde odkaz na overenie adresy. Po prihlásení zadáš údaje o firme, alebo sa rovno otvorí firma, kam ťa pozvali.</div>
    </form>
    <button class="linkbtn" data-a="authGo" data-to="login" style="align-self:flex-start">Už mám účet – prihlásiť sa</button><button class="linkbtn" data-a="landGo" data-to="landing" style="align-self:flex-start">← Úvodná stránka</button>`)}
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
      const {data,error}=await SB.auth.updateUser({password:a,data:{pw_set:true}});if(error){view.loginErr=AUTH_ERR(error.message);render();return}
      history.replaceState(null,"",location.pathname);toast("Heslo zmenené");await afterLogin(data.user)}
  }catch(e){console.error(e);view.loginErr=errText(e);render()}})()},true);
document.addEventListener("click",ev=>{const b=ev.target.closest("[data-a]");if(!b)return;const a=b.dataset.a;
  if(a==="forgot"){ev.stopImmediatePropagation();const em=($("#loginEmail")&&$("#loginEmail").value.trim())||"";
    if(!em){view.loginErr="Najprv napíš svoj e-mail do políčka E-mail a potom klikni na Zabudnuté heslo.";render();return}
    /* nové heslo posiela naša funkcia (odkaz cez tlačidlo v aplikácii); ak by nebola dostupná, použije sa e-mail Supabase */
    SB.functions.invoke("notify",{body:{action:"reset",email:em}}).then(({data,error})=>error||!data||data.error?SB.auth.resetPasswordForEmail(em,{redirectTo:location.origin}):{error:null}).then(({error})=>{view.loginEmail=em;if(error){view.loginErr=AUTH_ERR(error.message);view.loginOk=""}else{view.loginErr="";view.loginOk=`Ak účet ${em} existuje, prišiel naň e-mail s odkazom na nové heslo.`}render()})}
  else if(a==="otpGo"){ev.stopImmediatePropagation();if(view.otpBusy)return;view.otpBusy=true;view.loginErr="";render();
    (async()=>{const {otpType:type,otpHash:token_hash,otpEmail:em}=view;
      try{await SB.auth.signOut({scope:"local"}).catch(()=>{});me=null;TID=null;
        const {error}=await SB.auth.verifyOtp({type,token_hash});if(error)throw error;
        history.replaceState(null,"",location.pathname);view={screen:"home",auth:"newpw",invite:type==="invite"};render()}
      catch(e){console.error(e);history.replaceState(null,"",location.pathname);
        view={screen:"home",auth:"login",loginEmail:em,loginErr:"Odkaz v e-maile už neplatí alebo bol použitý. Skontroluj e-mail nižšie a klikni na Zabudnuté heslo – príde ti nový odkaz."};render()}})()}
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
async function loadBilling(){if(!TID)return;const {data,error}=await SB.rpc("billing_status",{t:TID});if(!error&&data)BILL=data;loadPadmin()}
/* admin platformy: tlačidlo a prehľad len pre overený účet info@stavebnafirma.eu (rozhoduje databáza) */
let PADMIN=false;
async function loadPadmin(){try{const {data,error}=await SB.rpc("is_platform_admin");const v=!error&&!!data;if(v!==PADMIN){PADMIN=v;render()}}catch(e){PADMIN=false}}
isPlatformAdmin=()=>!!me&&PADMIN;
platformLoad=async()=>{let r=await SB.rpc("platform_overview");
  if(r.error&&/permission denied|JWT|401/i.test(r.error.message+(r.status||""))){await SB.auth.refreshSession().catch(()=>{});r=await SB.rpc("platform_overview")}
  if(r.error)throw new Error(/permission denied|JWT/i.test(r.error.message)?"Prihlásenie vypršalo. Odhlás sa a prihlás znova.":r.error.message);return r.data||[]};
/* po návrate k oknu (napr. po uspatí počítača) obnoviť prihlásenie skôr, než aplikácia niečo načíta alebo uloží */
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"&&SB&&authUser)SB.auth.getSession().then(({data})=>{const e=data&&data.session&&data.session.expires_at;if(!e||e*1000-Date.now()<120000)return SB.auth.refreshSession()}).catch(()=>{})});
/* počasie pre denný záznam: server (funkcia weather, Open-Meteo) podľa GPS alebo obce stavby */
wxFetch=async(p,d)=>{const body={date:d};if(p.locType==="gps"&&p.gps){body.lat=p.gps.lat;body.lng=p.gps.lng}else body.place=[p.locality,p.address].filter(Boolean).join(", ");
  const {data,error}=await SB.functions.invoke("weather",{body});
  if(error){let msg=error.message;try{const j=await error.context.json();if(j&&j.error)msg=j.error}catch(e){}throw new Error(msg)}
  if(data&&data.error)throw new Error(data.error);return data};
/* zosúladenie so Stripe – pri otvorení firmy a po návrate z platby (ak by potvrdenie zo Stripe meškalo) */
async function syncBilling(){if(!TID||!BILL||!BILL.has_customer)return false;try{const {data,error}=await SB.functions.invoke("billing",{body:{action:"sync",tenant_id:TID}});
  if(error||!data||!data.synced)return false;const before=JSON.stringify(BILL.active);await loadBilling();if(JSON.stringify(BILL.active)!==before){await loadTenant(TID);render()}return true}catch(e){return false}}
let STRIPE_PRICES=[];
async function loadPrices(){if(PRICES)return;PRICES={};try{const {data,error}=await SB.functions.invoke("billing",{body:{action:"prices"}});if(!error&&data&&data.prices){PRICES=data.prices;STRIPE_PRICES=data.stripePrices||[]}}catch(e){}render()}
/* ceny zo Stripe: PRICES[modul][balíček][obdobie]; Požičovňa má balíček "0" */
const tiersOf=k=>PLANS[k].tiers.length>1?PLANS[k].tiers.map(x=>x[0]):[0];
const lkey=(k,t,i)=>t?`${k}_${t}_${i}`:`${k}_${i}`;
const sPrice=(k,t,i)=>{const p=PRICES&&PRICES[k]&&PRICES[k][String(t)]&&PRICES[k][String(t)][i];return p?p.amount:null};
const pricesMissing=()=>{if(!PRICES||!Object.keys(PRICES).length)return null;const miss=[];MODULES.forEach(([k])=>tiersOf(k).forEach(t=>["month","year"].forEach(i=>{if(sPrice(k,t,i)===null)miss.push(lkey(k,t,i))})));return miss};
/* zaplatený balíček: počas skúšobného obdobia a pri bezplatnom prístupe bez obmedzenia */
planTier=function(k){if(!BILL||BILL.complimentary)return null;const pm=(BILL.paid_modules||{})[k];
  if(pm&&new Date(pm.until)>new Date())return pm.tier||null;return null};
const daysLeft=iso=>Math.ceil((new Date(iso)-new Date())/864e5);
const dmy=iso=>{const d=new Date(iso);return `${d.getDate()}. ${d.getMonth()+1}. ${d.getFullYear()}`};
function modStatus(k){if(!BILL)return {t:"",cls:""};const pm=(BILL.paid_modules||{})[k];
  if(BILL.complimentary)return {t:"Bezplatný prístup",cls:"s-ok"};
  if(pm&&new Date(pm.until)>new Date())return {t:`Zaplatené · ${pm.tier&&PLANS[k]&&PLANS[k].tiers.length>1?tierLabel(k,pm.tier)+" · ":""}${pm.interval==="year"?"ročne":"mesačne"}`,cls:"s-ok",paid:true};
  if(BILL.trial_ends_at&&new Date(BILL.trial_ends_at)>new Date())return {t:"Skúšobné obdobie",cls:"s-wait"};
  return {t:"Nezaplatené – zamknuté",cls:"s-lock"}}
function priceTxt(k,t,i){const a=sPrice(k,t,i);return a!==null?`${a.toLocaleString("sk-SK",{minimumFractionDigits:2,maximumFractionDigits:2})} € / ${i==="year"?"rok":"mesiac"}`:""}
function modulesHTML(){
  const admin=me.companyRole==="admin";if(!BILL)return `<div class="card muted">Načítavam predplatné…</div>`;
  if(PRICES===null)loadPrices();
  const B=BILL,trial=B.trial_ends_at&&new Date(B.trial_ends_at)>new Date(),hasSub=B.billing&&B.billing.subscription_id&&["active","trialing","past_due"].includes(B.billing.status);
  const D=view.billDraft||(view.billDraft={interval:(B.billing&&B.billing.interval)||"month",mods:MODULES.map(m=>m[0]).filter(k=>((B.paid_modules||{})[k])||(!hasSub&&(S.modules||{})[k])),
    tiers:Object.fromEntries(MODULES.map(([k])=>{const pm=(B.paid_modules||{})[k];const t=tiersOf(k);return [k,t[0]?Math.max(pm&&pm.tier||0,minTier(k)):0]}))});
  const tierFor=k=>D.tiers[k]||tiersOf(k)[0];
  const sum=D.mods.reduce((s,k)=>s+(sPrice(k,tierFor(k),D.interval)||0),0);
  const yearSave=(()=>{let m=0,y=0;MODULES.forEach(([k])=>{const a=sPrice(k,tierFor(k),"month"),b=sPrice(k,tierFor(k),"year");if(a&&b){m+=a*12;y+=b}});return m&&y<m?Math.round((1-y/m)*100):0})();
  const banner=B.complimentary?`<div class="note">Firma má <b>bezplatný prístup</b> ku všetkým modulom.</div>`
    :trial?`<div class="note"><b>Skúšobné obdobie do ${dmy(B.trial_ends_at)}</b> – zostáva ${daysLeft(B.trial_ends_at)} ${pl(daysLeft(B.trial_ends_at),"deň","dni","dní")}. Všetky moduly sú dovtedy dostupné. ${admin?"Moduly, ktoré chceš používať aj potom, si predplať nižšie.":""}</div>`
    :hasSub?(B.billing.status==="past_due"?`<div class="note cnote hard"><b>Platba za predplatné neprešla.</b> Skontroluj platobnú kartu v správe predplatného, inak sa moduly o pár dní zamknú.</div>`:B.billing.cancel_at_period_end?`<div class="note cnote">Predplatné je zrušené ku koncu obdobia. Moduly fungujú do dátumu uvedeného pri module.</div>`:"")
    :`<div class="note cnote hard"><b>Skúšobné obdobie skončilo.</b> ${admin?"Vyber moduly a predplať si ich – údaje ostali uložené a po zaplatení budú znova k dispozícii.":"Administrátor firmy môže moduly predplatiť v tejto karte."}</div>`;
  const cards=MODULES.map(([k,l,d])=>{const st=modStatus(k),pm=(B.paid_modules||{})[k],on=D.mods.includes(k),tiered=tiersOf(k)[0],u=planUsage(k),edit=admin&&!B.complimentary;
    return `<div class="modcard bill ${on?"on":""}"><div class="mcrow"><span style="flex:1;min-width:0"><b>${l}</b> <span class="pill ${st.cls}">${esc(st.t)}</span><br><span class="muted">${esc(d)}</span>
      ${tiered?`<div class="mcusage">${usageText(k)}</div>`:""}
      ${pm&&st.paid?`<br><span class="muted" style="font-size:12.5px">Predplatené do ${dmy(new Date(new Date(pm.until)-3*864e5).toISOString())}</span>`:""}</span>
      ${on?`<span class="bprice">${priceTxt(k,tierFor(k),D.interval)}</span>`:""}</div>
      ${edit?tierPicker(k,on?tierFor(k):"off",D.interval,"bt_"+k,sPrice,"btier"):""}</div>`}).join("");
  return `<div class="stack"><div class="card stack"><h2>Moduly a predplatné</h2>
    <div class="muted">Karta Firma so základným zoznamom zamestnancov a strojovým a vozovým parkom je súčasťou každého užívateľa bezplatne. Ostatné moduly si vyberieš podľa vlastnej potreby – môžeš si zvoliť iba tie, ktoré potrebuješ pre fungovanie svojej firmy.</div>
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
/* zrušenie účtu alebo celej firmy: overí heslo, zavolá server (funkcia "account") a odhlási */
accountDelete=async(scope,pw)=>{
  const email=me.email;const {error:e1}=await SB.auth.signInWithPassword({email,password:pw});
  if(e1)throw new Error(/invalid/i.test(e1.message)?"Nesprávne heslo.":e1.message);
  await saveQ.catch(()=>{});
  const {data,error}=await SB.functions.invoke("account",{body:scope==="me"?{action:"delete_me"}:{action:"delete_company",tenant_id:TID,delete_account:scope==="firmMe"}});
  if(error){let msg=error.message;try{const j=await error.context.json();if(j&&j.error)msg=j.error}catch(e){}throw new Error(msg)}
  if(data&&data.error)throw new Error(data.error);
  const gone=scope==="me"||(data&&data.account);view.accDel=null;
  try{if(liveCh)SB.removeChannel(liveCh)}catch(e){}liveCh=null;await OFF.clear();
  if(gone){try{await SB.auth.signOut({scope:"local"})}catch(e){}lsSet("sf-uid","");me=null;authUser=null;TID=null;S=blankState();SNAP=new Map();USNAP=new Map();VER=new Map();
    view={screen:"home",auth:"landing",loginErr:""};render();window.scrollTo(0,0);toast(scope==="me"?"Tvoj účet bol zrušený.":"Firma aj tvoj účet boli zrušené. Ďakujeme, že si používal Stavebnú firmu.")}
  else{lsSet("sf-tenant","");toast("Firma bola zrušená.");setTimeout(()=>location.replace(location.pathname),1200)}};
/* ---------- e-maily (funkcia notify) ---------- */
async function notifyCall(body){const {data,error}=await SB.functions.invoke("notify",{body:{tenant_id:TID,...body}});
  if(error){let msg=error.message;try{const j=await error.context.json();if(j&&j.error)msg=j.error}catch(e){}throw new Error(msg)}
  if(data&&data.error)throw new Error(data.error);return data||{}}
const mailToast=t=>setTimeout(()=>toast(t),1600);
mail=async(kind,o)=>{if(!TID||!navigator.onLine)return;if(!(o.users||[]).length&&!(o.emails||[]).length)return;
  try{await saveQ.catch(()=>{});const d=await notifyCall({action:"send",kind,...o});
    if(d.sent)mailToast(`E-mail odoslaný (${d.sent} ${pl(d.sent,"príjemca","príjemcovia","príjemcov")})`)}
  catch(e){console.error(e);mailToast("E-mail sa nepodarilo odoslať: "+(e.message||e))}};
async function sendInvite(id,email){try{const d=await notifyCall({action:"invite",invite_id:id});
    mailToast(d.existing?`${email} už má účet – poslali sme mu e-mail, že ho pridávaš`:`Pozvánka odoslaná na ${email}`)}
  catch(e){console.error(e);mailToast("Pozvánku sa nepodarilo odoslať e-mailom: "+(e.message||e))}}
document.addEventListener("click",ev=>{const b=ev.target.closest('[data-a="invResend"]');if(!b||!me)return;ev.stopImmediatePropagation();
  const u=S.users.find(x=>x.id===b.dataset.id);if(u){b.disabled=true;toast("Posielam pozvánku…");sendInvite(u.id.slice(4),u.email)}},true);
async function billCall(body){billBusy=true;render();
  try{const {data,error}=await SB.functions.invoke("billing",{body:{...body,tenant_id:TID}});
    if(error){let msg=error.message;try{const j=await error.context.json();if(j&&j.error)msg=j.error}catch(e){}throw new Error(msg)}
    if(data&&data.error)throw new Error(data.error);return data}
  finally{billBusy=false}}
document.addEventListener("click",ev=>{const b=ev.target.closest("[data-a]");if(!b||!me)return;const a=b.dataset.a;
  if(a==="billPay"){ev.stopImmediatePropagation();const D=view.billDraft;
    const bad=D.mods.find(k=>{const t=D.tiers[k],x=t&&PLANS[k].tiers.find(z=>z[0]===t);return x&&x[1]&&planUsage(k)>x[1]});
    if(bad){toast(`Pre modul ${PLANS[bad].n} máš viac ako ${tierLabel(bad,D.tiers[bad])} – vyber väčší balíček.`);return}
    billCall({action:"checkout",modules:D.mods,tiers:Object.fromEntries(D.mods.filter(k=>D.tiers[k]).map(k=>[k,D.tiers[k]])),interval:D.interval}).then(async d=>{if(d.url){view.payUrl=d.url;render();location.assign(d.url);return}
      if(d.updated){await loadBilling();view.billDraft=null;toast("Predplatné upravené");render()}}).catch(e=>{toast("Platbu sa nepodarilo pripraviť: "+e.message);render()})}
  else if(a==="billSync"){ev.stopImmediatePropagation();billBusy=true;render();syncBilling().then(ok=>{billBusy=false;view.billDraft=null;toast(ok?"Stav predplatného obnovený zo Stripe":"Stav sa nepodarilo obnoviť");render()})}
  else if(a==="billPortal"){ev.stopImmediatePropagation();billCall({action:"portal"}).then(d=>{if(d.url){view.payUrl=d.url;render();location.assign(d.url)}}).catch(e=>{toast("Správu predplatného sa nepodarilo otvoriť: "+e.message);render()})}},true);
document.addEventListener("change",ev=>{const t=ev.target;if(!me||!view.billDraft)return;
  if(t.dataset&&t.dataset.bmod){const D=view.billDraft;D.mods=t.checked?[...new Set([...D.mods,t.dataset.bmod])]:D.mods.filter(x=>x!==t.dataset.bmod);render()}
  else if(t.name==="bInt"){view.billDraft.interval=t.value;render()}
  else if(t.dataset&&t.dataset.btier){const D=view.billDraft,k=t.dataset.btier;
    if(t.value==="off")D.mods=D.mods.filter(x=>x!==k);else{D.mods=[...new Set([...D.mods,k])];D.tiers[k]=+t.value}render()}});
/* návrat zo Stripe */
async function afterPaymentReturn(){const q=new URLSearchParams(location.search),r=q.get("platba");if(!r)return;history.replaceState(null,"",location.pathname);
  view={screen:"firma",firmTab:"moduly"};
  if(r==="zrusena"){toast("Platba bola zrušená, nič sa nezaplatilo.");render();return}
  if(r==="ok"){toast("Ďakujeme, platba prebehla. Zapínam moduly…");for(let i=0;i<10;i++){await loadBilling();if(!(BILL&&Object.keys(BILL.paid_modules||{}).length)&&i>=1)await syncBilling();render();if(BILL&&Object.keys(BILL.paid_modules||{}).length)break;await new Promise(z=>setTimeout(z,2000))}
    view.billDraft=null;await loadTenant(TID);render();return}
  await syncBilling();await loadBilling();render()}

/* =====================================================================
   RÝCHLOSŤ A MOBIL: knižnice na PDF a Excel až po zobrazení, inštalácia na plochu, práca offline
   ===================================================================== */
const LIBS=["https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js","https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js","https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js"];
let libsP=null,libsReady=false;
function loadLibs(){return libsP||(libsP=LIBS.reduce((p,src)=>p.then(()=>new Promise(res=>{const el=document.createElement("script");el.src=src;el.onload=res;el.onerror=()=>{console.warn("Knižnica sa nenačítala:",src);res()};document.head.appendChild(el)})),Promise.resolve()).then(()=>{libsReady=true}))}
/* klik na export skôr, ako sa knižnice načítali: počkať a kliknúť znova */
const LIB_ACT=/pdf|xls|excel|exp|dex|payX|print|gps|supis|stamp|cert|zmluv|ziadost|list$/i,LIB_FORMS=new Set(["attExportForm","logExpForm","gpsForm","dexForm"]);
document.addEventListener("click",ev=>{if(libsReady)return;const b=ev.target.closest&&ev.target.closest("[data-a]");if(!b||!LIB_ACT.test(b.dataset.a))return;
  ev.preventDefault();ev.stopImmediatePropagation();toast("Pripravujem export…");loadLibs().then(()=>b.click())},true);
document.addEventListener("submit",ev=>{if(libsReady)return;const f=ev.target;if(!f||!LIB_FORMS.has(f.id))return;ev.preventDefault();ev.stopImmediatePropagation();
  loadLibs().then(()=>f.requestSubmit?f.requestSubmit():f.dispatchEvent(new Event("submit",{cancelable:true,bubbles:true})))},true);
window.addEventListener("load",()=>{const go=()=>loadLibs();if("requestIdleCallback" in window)requestIdleCallback(go,{timeout:4000});else setTimeout(go,1500)});

/* aplikácia na plochu (PWA): service worker drží aplikáciu v zariadení, aby sa otvorila aj bez signálu */
if("serviceWorker" in navigator&&location.protocol==="https:")window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(e=>console.warn("sw",e)));
let installEv=null;
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installEv=e;if(me)render()});
window.addEventListener("appinstalled",()=>{installEv=null;lsSet("sf-inst","1");render()});
const isStandalone=()=>matchMedia("(display-mode: standalone)").matches||navigator.standalone===true;
const isIOS=()=>/iphone|ipad|ipod/i.test(navigator.userAgent)&&!window.MSStream;
function installHTML(){if(isStandalone()||lsGet("sf-inst-skip")==="1"||!me)return "";if(!installEv&&!(isIOS()&&matchMedia("(max-width:820px)").matches))return "";
  return `<div class="instbar" role="region" aria-label="Aplikácia na plochu"><div><b>Pridaj si aplikáciu na plochu</b><span>${installEv?"Otvorí sa jedným ťuknutím a denník aj dochádzku zapíšeš aj bez signálu.":"V Safari ťukni na Zdieľať a potom na „Pridať na plochu“. Denník aj dochádzku zapíšeš aj bez signálu."}</span></div>
    ${installEv?`<button class="btn small primary" data-a="pwaInstall">Pridať</button>`:""}<button class="btn small ghost" data-a="pwaSkip" aria-label="Zavrieť">✕</button></div>`}
document.addEventListener("click",ev=>{const b=ev.target.closest&&ev.target.closest("[data-a]");if(!b)return;
  if(b.dataset.a==="pwaInstall"&&installEv){ev.stopImmediatePropagation();installEv.prompt();installEv.userChoice.finally(()=>{installEv=null;render()})}
  else if(b.dataset.a==="pwaSkip"){ev.stopImmediatePropagation();lsSet("sf-inst-skip","1");render()}},true);
