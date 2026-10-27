#!/usr/bin/env python3
"""Zostaví ostrú verziu aplikácie (web/index.html) z prototypu (build/prototype.html)
a z vrstvy pre Supabase (build/live.js).  Spustenie:  python3 build/build.py"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
proto = (ROOT / "build" / "prototype.html").read_text(encoding="utf-8")
live = (ROOT / "build" / "live.js").read_text(encoding="utf-8")
s = proto

def rep(old, new, count=1):
    global s
    n = s.count(old)
    if n != count:
        sys.exit(f"Build: očakávaný text sa našiel {n}× namiesto {count}×:\n{old[:160]}")
    s = s.replace(old, new)

def cut(start, end, new, keep_end=True):
    """nahradí úsek od `start` po `end` (end ostáva, ak keep_end)"""
    global s
    i = s.index(start); j = s.index(end, i)
    s = s[:i] + new + (s[j:] if keep_end else s[j + len(end):])

# 1) úložisko prototypu (ukážková firma v prehliadači) → Supabase
cut("/* všetky firmy (tenanti) v jednom úložisku prototypu", "let me=null, view=",
    live + "\nlet S=blankState();\n")
cut("function save(){ROOT.tenants[curT]=S;", "const $=s=>", "")
cut("/* ---------- účty, heslá a firmy (tenanti) ---------- */", "/* ---------- údaje o firme ---------- */",
    "/* ---------- účty: pozri OSTRÁ VERZIA vyššie ---------- */\n")
cut("const plain=s=>String(s).replace(", "function fileBase(p,inv)",
    'const plain=s=>String(s).replace(/[  ]/g," ");\n')

# 2) obsluha starého prihlasovania a ukážkových dát
rep('  if(a==="quick")login(b.dataset.email);\n  else if(a==="logout"){me=null;useTenant("demo");view={screen:"home",loginErr:"",auth:"login"};render();window.scrollTo(0,0)}\n  else if(a==="reset"){ROOT.tenants.demo=seed();useTenant("demo");save();toast("Ukážkové dáta obnovené");render()}\n  else if(a==="authGo")',
    '  if(a==="authGo")')
rep('  else if(a==="forgot"){toast("V ostrej verzii príde na e-mail odkaz na nastavenie nového hesla.")}\n', '')
i = s.index('  if(f==="loginForm"){view.loginEmail='); j = s.index('  else if(f==="modForm")', i)
s = s[:i] + '  if(false){}\n' + s[j:]

# 3) založenie firmy pri prvom nastavení
rep('const setup=ev.target.dataset.mode==="setup";S.firm={...view.firmDraft,setupDone:true};S.company=S.firm.name;if(setup&&!me.name)me.name=S.firm.repName;\n    view.firmDraft=null;view.firmErr="";view.firmEditing=false;if(save())toast(setup?"Firma nastavená. Môžeš začať.":"Údaje o firme uložené");\n    view=setup?{screen:startScreen(),tab:"dennik"}:{screen:"firma",firmTab:"udaje"};render();window.scrollTo(0,0)}',
    'const setup=ev.target.dataset.mode==="setup";(async()=>{if(!TID){try{await createFirm(view.firmDraft.name)}catch(e){view.firmErr="Firmu sa nepodarilo založiť: "+errText(e);render();return}}\n    S.firm={...view.firmDraft,setupDone:true};S.company=S.firm.name;if(setup&&!me.name)me.name=S.firm.repName;\n    view.firmDraft=null;view.firmErr="";view.firmEditing=false;if(save())toast(setup?"Firma nastavená. Môžeš začať.":"Údaje o firme uložené");\n    view=setup?{screen:startScreen(),tab:"dennik"}:{screen:"firma",firmTab:"udaje"};render();window.scrollTo(0,0)})()}')

# 4) používatelia a pozvánky
rep('if(findAccount(email)){toast("Používateľ s týmto e-mailom už existuje");return}',
    'if(S.users.some(u=>(u.email||"").toLowerCase()===email)){toast("Používateľ s týmto e-mailom už existuje");return}')
rep('S.users.push({id:uid("u"),email,name,companyRole:"clen",rights});view.userNew=false;save();toast(`Používateľ ${name} pridaný`);render()});',
    'S.users.push({id:newInvId(),email,name,companyRole:"clen",rights,pending:true});view.userNew=false;save();toast(`Pozvánka uložená. Pošli kolegovi odkaz www.stavebnafirma.com – zaregistruje sa e-mailom ${email}.`);render()});')
rep('${esc(u.email)}${u.pw||DEMO_IDS.includes(u.id)?"":" · ešte sa neprihlásil"}', '${esc(u.email)}${u.pending?" · pozvaný, ešte sa nezaregistroval":""}')
rep('if(!u){u={id:uid("u"),email,name:$("#invName").value.trim()||email.split("@")[0],companyRole:"clen"};S.users.push(u)}',
    'if(!u){u={id:newInvId(),email,name:$("#invName").value.trim()||email.split("@")[0],companyRole:"clen",pending:true};S.users.push(u)}')
rep('p.members.push({userId:u.id,role,status:"pozvaný"});toast("Pozvánka pripravená. Odhlás sa a prihlás jeho e-mailom.")',
    'p.members.push({userId:u.id,role,status:u.pending?"pozvaný":"aktívny"});toast(u.pending?`Pozvánka uložená. Pošli mu odkaz www.stavebnafirma.com – zaregistruje sa e-mailom ${u.email}.`:`${u.name} pridaný na stavbu`)')
rep('const rows=p.members.map(m=>{const u=user(m.userId);', 'const rows=p.members.map(m=>{const u=user(m.userId)||{id:m.userId,name:"(odstránený používateľ)",email:""};')
rep('${m.role==="dozor"&&!u.pw&&m.status==="pozvaný"?" · ešte nepotvrdil pozvánku":""}', '${u.pending?" · ešte sa nezaregistroval":""}')
rep('${m.status==="pozvaný"?`<span class="pill s-pozvany">Pozvaný</span>`:""}', '${u.pending?`<span class="pill s-pozvany">Pozvaný</span>`:""}')

# 5) heslo a OEV II
rep('me.pw=await hashPw(a);save();toast("Heslo zmenené");', 'const {error}=await SB.auth.updateUser({password:a});if(error){toast(AUTH_ERR(error.message));return}toast("Heslo zmenené");')
rep('let sample=null;try{sample=await window.claude?.use?.("sample")}catch(e){}', 'let sample=null;')
rep('"Automatické vyčítanie tu nie je dostupné. Fotky sú uložené, údaje doplň ručne."', '"Automatické vyčítanie z fotky pripravujeme. Fotky sú uložené, údaje zatiaľ doplň ručne."')

# 6) koniec skriptu: bez ukážkových dát, štart cez Supabase
i = s.index('if(!ROOT.tenants.demo.trainings)'); j = s.index('render();\n</script>', i)
s = s[:i] + 'boot();\n</script>' + s[j + len('render();\n</script>'):]

# 6b) predplatné: dostupné moduly určuje server (billing_status), karta Moduly je z live.js
rep('const hasMod=k=>!!(S.modules||ALL_MODS)[k];','const hasMod=k=>!!((typeof BILL!=="undefined"&&BILL&&BILL.active)||S.modules||ALL_MODS)[k];')
rep('function modulesHTML(){\n  const M=S.modules||ALL_MODS','function modulesHTML_prototyp(){\n  const M=S.modules||ALL_MODS')
rep('nie je v predplatnom. Zapnúť ho môžeš tu.','nie je predplatený. Predplatiť ho môžeš tu.')
rep('</style>', '.modcard.bill{display:flex;gap:12px;align-items:flex-start}.modcard.bill.on{border-color:var(--accent);background:var(--tint)}.bprice{white-space:nowrap;font-weight:600;font-size:14px}\n</style>')

# 7) lišta: prepnutie firmy a indikátor ukladania
rep('<button class="logout" data-a="logout">Odhlásiť</button></div>`:"");',
    '<span class="saveind" id="saveInd" hidden>Ukladám…</span>${myTenants.length>1?`<button class="logout" data-a="switchTenant" title="Prepnúť firmu">Firmy</button>`:""}<button class="logout" data-a="logout">Odhlásiť</button></div>`:"");')
rep('</style>', '.spinner{width:34px;height:34px;border-radius:50%;border:4px solid var(--line);border-top-color:var(--accent);animation:spin 0.9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}\n.saveind{font-size:12px;color:var(--brand-hi);margin-right:8px;white-space:nowrap}\n</style>')

# 8) knižnica Supabase a úplný HTML dokument
rep('<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>',
    '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js"></script>\n<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>')
rep('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
head_end = s.index('<header class="bar">')
s = ('<!doctype html>\n<html lang="sk">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n'
     '<meta name="description" content="Stavebná firma – firma, personalistika, doprava a logistika, požičovňa a stavby na jednom mieste.">\n'
     + s[:head_end] + '</head>\n<body>\n' + s[head_end:] + '\n</body>\n</html>\n')

# kontrola: v ostrej verzii nesmú ostať odkazy na úložisko prototypu
for bad in ["ROOT.", "localStorage.setItem(KEY", "findAccount(", "useTenant(", "hashPw(", "window.claude", "DEMO_IDS"]:
    if bad in s:
        sys.exit(f"Build: v ostrej verzii ostal odkaz na prototyp: {bad}")
(ROOT / "web" / "index.html").write_text(s, encoding="utf-8")
print(f"web/index.html zostavený ({len(s)//1024} kB)")
