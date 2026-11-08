// E-maily z aplikácie Stavebná firma – odosiela cez SMTP schránku noreply@stavebnafirma.eu.
// Nasadiť BEZ overovania JWT (ranný súhrn spúšťa plánovač s vlastným kľúčom); používateľa overuje funkcia sama.
//   POST { action: "invite", tenant_id, invite_id }        – pozvánka do firmy / na stavbu (s odkazom na nastavenie hesla)
//   POST { action: "send", tenant_id, kind, ... }          – upozornenie (kontrolný deň, výzva, úloha, súpis)
//   POST { action: "digest" } + hlavička x-cron-key         – ranný súhrn pre všetky firmy (plánovač)
// Nastavenia (Edge Functions → Secrets): SMTP_PASS (heslo schránky), voliteľne SMTP_USER, SMTP_HOST, SMTP_PORT, APP_URL.
import { createClient } from "jsr:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const APP = (() => { let u = (Deno.env.get("APP_URL") || "https://stavebnafirma.eu").trim().replace(/\/+$/, ""); if (!/^https?:\/\//i.test(u)) u = "https://" + u; return u; })();
const clean = (v: string | undefined) => String(v ?? "").trim().replace(/^(["'])(.*)\1$/s, "$2");
const FROM_ADDR = clean(Deno.env.get("SMTP_USER")).toLowerCase() || "noreply@stavebnafirma.eu";
const DAY_LIMIT = 300;          // e-mailov na firmu za 24 hodín
const MAX_TO = 50;              // príjemcov v jednej správe
const TASK_KINDS = ["req", "task", "supis"];   // vypína sa voľbou „Výzvy a úlohy“
const KINDS = ["kd", ...TASK_KINDS];

let transport: any = null;
/* pripojenie k SMTP: heslo a meno sa očistia od medzier a úvodzoviek (častá chyba pri vkladaní do Secrets);
   ak SMTP_HOST nie je zadaný a server odmietne prihlásenie, skúsi sa aj druhý server Websupportu */
async function mailer() {
  if (transport) return transport;
  const raw = Deno.env.get("SMTP_PASS") ?? "";
  const pass = clean(raw);
  if (!pass) throw new Error("E-maily nie sú nastavené: chýba SMTP_PASS v Supabase (Edge Functions → Secrets).");
  const port = Number(clean(Deno.env.get("SMTP_PORT")) || 465);
  const own = clean(Deno.env.get("SMTP_HOST"));
  const hosts = [...new Set([own, "smtp.m1.websupport.sk", "smtp.websupport.sk"].filter(Boolean))];
  const ascii = /^[\x20-\x7e]*$/.test(pass);
  let last: any = null;
  for (const host of hosts) for (const authMethod of ["PLAIN", "LOGIN"]) {
    const t = nodemailer.createTransport({ host, port, secure: port === 465, authMethod, auth: { user: FROM_ADDR, pass } });
    try { await t.verify(); transport = t; console.log(`SMTP ok: ${FROM_ADDR} @ ${host}:${port} ${authMethod}`); return t; }
    catch (e) {
      last = e;
      const msg = String((e as any)?.response || (e as Error)?.message);
      // diagnostika bez hesla: meno, server, spôsob prihlásenia, dĺžka hesla, či obsahuje znaky mimo ASCII (diakritika, €, §…)
      console.error(`SMTP prihlásenie zlyhalo: user=${FROM_ADDR} host=${host}:${port} auth=${authMethod} heslo_znakov=${pass.length} heslo_ascii=${ascii} orezané=${raw.length !== pass.length} chyba=${msg}`);
      if (!/535|EAUTH|Invalid login|authentication/i.test(msg)) break;
    }
  }
  throw last;
}

// ---------- šablóna e-mailu ----------
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);
type Mail = {
  title: string; intro?: string; rows?: [string, string][]; text?: string; sections?: { h: string; items: string[] }[];
  button?: { label: string; url: string }; after?: string; firm?: string; footer?: string;
};
function render(m: Mail) {
  const rows = (m.rows || []).filter((r) => r && r[1]).map(([k, v]) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#6b6b6b;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0;color:#222">${esc(v).replace(/\n/g, "<br>")}</td></tr>`).join("");
  const secs = (m.sections || []).filter((s) => s.items.length).map((s) =>
    `<h3 style="margin:18px 0 6px;font-size:15px;color:#222">${esc(s.h)}</h3><ul style="margin:0;padding-left:18px;color:#222">${s.items.map((i) => `<li style="margin:3px 0">${esc(i)}</li>`).join("")}</ul>`).join("");
  const html = `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#f3f3f1;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f3f1;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e4e4e0">
<tr><td style="background:#2b2b2b;padding:14px 24px;color:#fff;font-weight:bold;font-size:16px"><span style="color:#ef7d2d">▲</span> Stavebná firma${m.firm ? `<span style="font-weight:normal;color:#cfcfcf"> · ${esc(m.firm)}</span>` : ""}</td></tr>
<tr><td style="padding:24px">
<h2 style="margin:0 0 12px;font-size:20px;color:#222">${esc(m.title)}</h2>
${m.intro ? `<p style="margin:0 0 12px;color:#222">${esc(m.intro).replace(/\n/g, "<br>")}</p>` : ""}
${rows ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:6px 0 12px">${rows}</table>` : ""}
${m.text ? `<p style="margin:0 0 12px;color:#222;white-space:pre-line">${esc(m.text)}</p>` : ""}
${secs}
${m.button ? `<p style="margin:22px 0"><a href="${esc(m.button.url)}" style="background:#ef7d2d;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block">${esc(m.button.label)}</a></p>` : ""}
${m.after ? `<p style="margin:0 0 12px;color:#6b6b6b;font-size:13px">${esc(m.after).replace(/\n/g, "<br>")}</p>` : ""}
</td></tr>
<tr><td style="padding:14px 24px;background:#fafaf8;border-top:1px solid #eee;color:#8a8a8a;font-size:12px">${esc(m.footer || "Tento e-mail poslala aplikácia Stavebná firma (www.stavebnafirma.eu).")}</td></tr>
</table></td></tr></table></body></html>`;
  const txt = [m.title, m.intro, ...(m.rows || []).filter((r) => r && r[1]).map(([k, v]) => `${k}: ${v}`), m.text,
    ...(m.sections || []).filter((s) => s.items.length).map((s) => `${s.h}\n${s.items.map((i) => "- " + i).join("\n")}`),
    m.button ? `${m.button.label}: ${m.button.url}` : "", m.after, "--", m.footer || "Stavebná firma · www.stavebnafirma.eu"].filter(Boolean).join("\n\n");
  return { html, text: txt };
}
async function send(o: { to: { email: string; name?: string }[]; subject: string; mail: Mail; replyTo?: string; fromName?: string; attachments?: any[] }) {
  const { html, text } = render(o.mail);
  const fromName = (o.fromName || "Stavebná firma").replace(/["<>]/g, "");
  // každý príjemca dostane vlastnú správu (nevidia adresy ostatných)
  for (const r of o.to) {
    await (await mailer()).sendMail({
      from: `"${fromName}" <${FROM_ADDR}>`, to: r.name ? `"${r.name.replace(/["<>]/g, "")}" <${r.email}>` : r.email,
      replyTo: o.replyTo || undefined, subject: o.subject, html, text, attachments: o.attachments,
    });
  }
}

// ---------- pomôcky ----------
async function firmOf(tid: string) {
  const { data } = await admin.from("docs").select("data").eq("tenant_id", tid).eq("kind", "meta").eq("id", "firm").maybeSingle();
  return (data?.data?.v || {}) as Record<string, any>;
}
async function people(tid: string) {
  const { data, error } = await admin.rpc("notify_people", { t: tid });
  if (error) throw error;
  return (data || []) as { user_id: string; email: string; name: string; role: string; rights: Record<string, string> }[];
}
async function sentToday(tid: string) {
  const since = new Date(Date.now() - 864e5).toISOString();
  const { data } = await admin.from("mail_log").select("recipients").eq("tenant_id", tid).gte("created_at", since);
  return (data || []).reduce((s, r: any) => s + (r.recipients || 0), 0);
}
const log = (tid: string | null, uid: string | null, kind: string, n: number) => admin.from("mail_log").insert({ tenant_id: tid, user_id: uid, kind, recipients: n });
const okEmail = (e: string) => /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(e);
const todayBA = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Bratislava" });
const d2 = (iso: string) => { const [y, m, d] = String(iso || "").slice(0, 10).split("-"); return y && m && d ? `${+d}. ${+m}. ${y}` : String(iso || ""); };
const daysBetween = (a: string, b: string) => Math.round((new Date(b + "T12:00").getTime() - new Date(a + "T12:00").getTime()) / 864e5);
const addMonths = (d: string, n: number) => { const x = new Date(d + "T12:00"); const day = x.getDate(); x.setMonth(x.getMonth() + n); if (x.getDate() < day) x.setDate(0); return x.toISOString().slice(0, 10); };
const addDays = (d: string, n: number) => { const x = new Date(d + "T12:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const pl = (n: number, a: string, b: string, c: string) => (n === 1 ? a : n >= 2 && n <= 4 ? b : c);
const nf = (n: number) => Math.round(n).toLocaleString("sk-SK");
const appLink = (kind: string, hash: string | undefined, email: string) => hash ? `${APP}/?${kind}=${encodeURIComponent(hash)}&e=${encodeURIComponent(email)}` : "";

// ---------- zabudnuté heslo (bez prihlásenia) ----------
async function doReset(body: any) {
  const email = String(body.email || "").trim().toLowerCase();
  if (!okEmail(email)) return json({ error: "Neplatný e-mail." }, 400);
  const { data: rl, error } = await admin.auth.admin.generateLink({ type: "recovery", email });
  if (error || !rl?.user) return json({ ok: true });            // neprezradí, či účet existuje
  const uid = rl.user.id;
  const since = new Date(Date.now() - 36e5).toISOString();
  const { count } = await admin.from("mail_log").select("id", { count: "exact", head: true }).eq("user_id", uid).eq("kind", "reset").gte("created_at", since);
  if ((count || 0) >= 3) return json({ ok: true });
  await send({
    to: [{ email }], fromName: "Stavebná firma", subject: "Nové heslo do aplikácie Stavebná firma",
    mail: {
      title: "Nastavenie nového hesla",
      intro: `Niekto (pravdepodobne ty) požiadal o nové heslo k účtu ${email}. Klikni na tlačidlo a nastav si nové heslo.`,
      button: { label: "Nastaviť nové heslo", url: appLink("obnova", rl.properties?.hashed_token, email) },
      after: "Odkaz platí 24 hodín a dá sa použiť raz. Ak si o nové heslo nežiadal, e-mail ignoruj – heslo ostane nezmenené.",
    },
  });
  await log(null, uid, "reset", 1);
  return json({ ok: true });
}

// ---------- pozvánka ----------
async function doInvite(user: any, body: any) {
  const tid = String(body.tenant_id || ""), iid = String(body.invite_id || "");
  const { data: mem } = await admin.from("members").select("role").eq("tenant_id", tid).eq("user_id", user.id).maybeSingle();
  if (!mem) return json({ error: "Do tejto firmy nemáš prístup." }, 403);
  const { data: inv } = await admin.from("invites").select("id,email,name,role,projects,created_by,accepted_at").eq("id", iid).eq("tenant_id", tid).maybeSingle();
  if (!inv) return json({ error: "Pozvánka sa nenašla." }, 404);
  if (inv.accepted_at) return json({ error: "Pozvánku už prijal." }, 400);
  if (mem.role !== "admin" && inv.created_by !== user.id) return json({ error: "Pozvánku posiela administrátor firmy." }, 403);
  if (await sentToday(tid) + 1 > DAY_LIMIT) return json({ error: `Firma dnes už poslala ${DAY_LIMIT} e-mailov. Skús to zajtra.` }, 429);

  const firm = await firmOf(tid);
  const { data: ten } = await admin.from("tenants").select("name").eq("id", tid).single();
  const firmName = firm.name || ten?.name || "firma";
  const ppl = await people(tid);
  const inviter = ppl.find((p) => p.user_id === user.id)?.name || user.email;
  let what = "do firmy";
  if (inv.projects?.length) {
    const { data: pr } = await admin.from("docs").select("id,data").eq("tenant_id", tid).eq("kind", "projects").in("id", inv.projects);
    const names = (pr || []).map((r: any) => r.data?.name).filter(Boolean);
    // rola na stavbe podľa tímu stavby (pozvaný má v tíme id „inv:<id pozvánky>“)
    const pRoles = (pr || []).map((r: any) => (r.data?.members || []).find((m: any) => m.userId === `inv:${inv.id}`)?.role).filter(Boolean);
    const as = pRoles.includes("dozor") ? "ako stavebný dozor " : pRoles.includes("extsv") ? "ako externý stavbyvedúci " : inv.role === "dozor" ? "ako stavebný dozor " : "";
    if (names.length) what = `${as}na ${names.length > 1 ? "stavby" : "stavbu"} ${names.join(", ")}`;
  }
  const email = String(inv.email).toLowerCase();
  const reg = `${APP}/?registracia=${encodeURIComponent(email)}`;
  // odkaz vedie do aplikácie, token sa overí až kliknutím na tlačidlo (kontrola odkazov v Gmaili/Outlooku ho nespotrebuje)
  let link = "", existing = false;
  const { data: gl, error: ge } = await admin.auth.admin.generateLink({ type: "invite", email, options: { redirectTo: APP, data: { name: inv.name || "" } } });
  if (ge) { if (/already|registered|exists/i.test(ge.message)) existing = true; else throw ge; }
  else link = appLink("pozvanka", gl?.properties?.hashed_token, email);
  if (existing) {
    // účet už existuje: ak vznikol z pozvánky a heslo si ešte nenastavil, pošle sa odkaz na nastavenie hesla
    const { data: rl } = await admin.auth.admin.generateLink({ type: "recovery", email });
    const u: any = rl?.user;
    if (u && u.invited_at && !u.user_metadata?.pw_set) { existing = false; link = appLink("obnova", rl?.properties?.hashed_token, email); }
  }

  await send({
    to: [{ email, name: inv.name || "" }], fromName: `${firmName} cez Stavebná firma`, replyTo: user.email,
    subject: `Pozvánka do aplikácie Stavebná firma – ${firmName}`,
    mail: existing ? {
      firm: firmName, title: `${inviter} ťa pridal ${what}`,
      intro: `Firma ${firmName} ti v aplikácii Stavebná firma sprístupnila svoje údaje. Prihlás sa svojím doterajším účtom (${email}) – firma sa ti zobrazí v zozname firiem.`,
      button: { label: "Prihlásiť sa", url: `${APP}/?prihlasenie` },
    } : {
      firm: firmName, title: `${inviter} ťa pozýva ${what}`,
      intro: `Firma ${firmName} používa aplikáciu Stavebná firma na stavebné denníky, dochádzku, stroje a stavby. Po kliknutí na tlačidlo si nastavíš heslo a otvorí sa ti firma s pridelenými právami.`,
      button: { label: "Prijať pozvánku a nastaviť heslo", url: link || reg },
      after: link ? `Odkaz platí 24 hodín a dá sa použiť raz. Ak už neplatí, otvor ${APP.replace(/^https?:\/\//, "")}, klikni na Prihlásiť sa → Zabudnuté heslo a zadaj tento e-mail – príde ti nový odkaz.`
        : `Zaregistruj sa práve týmto e-mailom – do firmy sa pridáš automaticky.`,
    },
  });
  await admin.from("invites").update({ sent_at: new Date().toISOString() }).eq("id", iid);
  await log(tid, user.id, "invite", 1);
  return json({ sent: 1, existing });
}

// ---------- upozornenia z aplikácie ----------
async function doSend(user: any, body: any) {
  const tid = String(body.tenant_id || ""), kind = String(body.kind || "");
  if (!KINDS.includes(kind)) return json({ error: "Neznámy druh e-mailu." }, 400);
  const { data: mem } = await admin.from("members").select("role").eq("tenant_id", tid).eq("user_id", user.id).maybeSingle();
  if (!mem) return json({ error: "Do tejto firmy nemáš prístup." }, 403);
  const firm = await firmOf(tid);
  if (TASK_KINDS.includes(kind) && firm.mail && firm.mail.tasks === false) return json({ sent: 0, off: true });

  const ppl = await people(tid);
  const to: { email: string; name?: string }[] = [];
  const add = (email: string, name?: string) => { email = String(email || "").trim().toLowerCase(); if (okEmail(email) && email !== String(user.email).toLowerCase() && !to.some((x) => x.email === email)) to.push({ email, name: clip(name, 80) }); };
  for (const id of (Array.isArray(body.users) ? body.users : [])) { const p = ppl.find((x) => x.user_id === id); if (p) add(p.email, p.name); }
  for (const r of (Array.isArray(body.emails) ? body.emails : []).slice(0, MAX_TO)) {
    const e = String(r?.email || "").trim().toLowerCase();
    if (!okEmail(e) || to.some((x) => x.email === e)) continue;
    const { data: known } = await admin.rpc("notify_email_known", { t: tid, e });
    if (known) add(e, r?.name);
  }
  if (!to.length) return json({ sent: 0 });
  if (to.length > MAX_TO) to.length = MAX_TO;
  if (await sentToday(tid) + to.length > DAY_LIMIT) return json({ error: `Firma dnes už poslala ${DAY_LIMIT} e-mailov. Skús to zajtra.` }, 429);

  const sender = ppl.find((p) => p.user_id === user.id)?.name || user.email;
  const firmName = firm.name || "firma";
  const rows: [string, string][] = (Array.isArray(body.rows) ? body.rows : []).slice(0, 12).map((r: any) => [clip(r?.[0], 60), clip(r?.[1], 600)]);
  let attachments: any[] | undefined;
  if (body.attachment?.data && /\.pdf$/i.test(String(body.attachment.name || ""))) {
    const b64 = String(body.attachment.data).replace(/^data:[^,]*,/, "");
    if (b64.length > 4_000_000) return json({ error: "Príloha je príliš veľká." }, 400);
    attachments = [{ filename: clip(body.attachment.name, 100).replace(/[\\/:*?"<>|]/g, "_"), content: b64, encoding: "base64", contentType: "application/pdf" }];
  }
  await send({
    to, fromName: `${firmName} cez Stavebná firma`, replyTo: user.email, attachments,
    subject: clip(body.subject, 150) || "Upozornenie z aplikácie Stavebná firma",
    mail: {
      firm: firmName, title: clip(body.title, 150) || clip(body.subject, 150), intro: clip(body.intro, 1500), rows, text: clip(body.text, 4000),
      button: { label: clip(body.button, 60) || "Otvoriť v aplikácii", url: `${APP}/?prihlasenie` },
      after: `Poslal(a) ${sender} z firmy ${firmName}. Odpoveď na tento e-mail príde priamo jemu/jej.`,
      footer: TASK_KINDS.includes(kind) ? "Tento e-mail poslala aplikácia Stavebná firma (www.stavebnafirma.eu). E-mailové upozornenia na výzvy a úlohy môže vypnúť administrátor firmy v karte Firma → Údaje o firme." : undefined,
    },
  });
  await log(tid, user.id, kind, to.length);
  return json({ sent: to.length });
}

// ---------- ranný súhrn (plánovač) ----------
const CAT_UNIT: Record<string, string> = { car: "km", truck: "km" };
// hodiny riadku denného záznamu: od – do mínus prestávka, alebo priamo zadané hodiny
const rowHours = (c: any) => {
  if (!c.from || !c.to) return +c.hours || 0;
  const [a, b] = String(c.from).split(":").map(Number), [x, y] = String(c.to).split(":").map(Number);
  return Math.max(0, x * 60 + y - (a * 60 + b) - (+c.brk || 0)) / 60;
};
async function digestFor(t: any, today: string) {
  const tid = t.id as string;
  const firm = await firmOf(tid);
  if (firm.mail && firm.mail.digest === false) return 0;
  const { count: done } = await admin.from("mail_log").select("id", { count: "exact", head: true }).eq("tenant_id", tid).eq("kind", "digest").gte("created_at", today + "T00:00:00+01:00");
  if (done) return 0;
  const rows = async (kind: string) => {
    const out: any[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await admin.from("docs").select("data").eq("tenant_id", tid).eq("kind", kind).range(from, from + 999);
      if (error) throw error; out.push(...(data || []).map((r: any) => r.data)); if (!data || data.length < 1000) break;
    }
    return out;
  };
  const machines = await rows("machines");
  const bad: string[] = [], soon: string[] = [];
  let diary: any[] | null = null;
  for (const m of machines) {
    if (!m || m.archived) continue;
    const label = [m.name, m.ecv].filter(Boolean).join(" · ");
    for (const tm of (m.terms || [])) {
      if (!tm.until) continue;
      const d = daysBetween(today, tm.until);
      if (d < 0) bad.push(`${label}: ${tm.kind} – skončila ${d2(tm.until)} (pred ${-d} ${pl(-d, "dňom", "dňami", "dňami")})`);
      else if (d <= (+tm.warn || 30)) soon.push(`${label}: ${tm.kind} – do ${d2(tm.until)} (${d === 0 ? "končí dnes" : `ešte ${d} ${pl(d, "deň", "dni", "dní")}`})`);
    }
    for (const s of (m.svcs || [])) {
      let st = "ok"; const parts: string[] = [];
      if (s.everyMonths && s.lastDate) {
        const nd = addMonths(s.lastDate, +s.everyMonths), d = daysBetween(today, nd);
        if (d < 0) st = "bad"; else if (d <= 30) st = "soon"; parts.push(`termín ${d2(nd)}`);
      }
      if (s.everyQty && s.lastQty != null && s.lastQty !== "" && m.reading) {
        const unit = CAT_UNIT[m.cat] || "h";
        let cur = +m.reading.value || 0;
        if (unit === "h") {
          diary = diary || await rows("diary");
          for (const e of diary) if (e && e.date > (m.reading.date || "")) for (const c of (e.mach || [])) if (c.machineId === m.id) cur += rowHours(c);
        }
        const left = (+s.lastQty) + (+s.everyQty) - cur;
        if (left <= 0) st = "bad"; else if (left <= +s.everyQty * 0.1 && st !== "bad") st = "soon";
        parts.push(left > 0 ? `o ${nf(left)} ${unit}` : `prekročené o ${nf(-left)} ${unit}`);
      }
      if (st === "bad") bad.push(`${label}: servis ${s.name} – ${parts.join(", ")}`);
      else if (st === "soon") soon.push(`${label}: servis ${s.name} – ${parts.join(", ")}`);
    }
  }
  const billDays = +firm.billDays || 15;
  const jobs = (await rows("jobs")).filter((j) => j && j.date && j.date <= today && !j.billed && j.status !== "cancelled" &&
    (j.priceMode === "own" ? (+String(j.price || "").replace(",", ".") || 0) > 0 : (j.machines || []).length > 0));
  const bill: string[] = [];
  for (const j of jobs.sort((a, b) => a.date.localeCompare(b.date))) {
    const dl = addDays(j.date, billDays), left = daysBetween(today, dl);
    if (left > 1) continue;
    bill.push(`${d2(j.date)} · ${[j.client, j.place].filter(Boolean).join(" – ") || "jazda"} – ${left < 0 ? `fakturovať ${-left} ${pl(-left, "deň", "dni", "dní")} po termíne` : left === 0 ? "fakturovať dnes" : "fakturovať zajtra"}`);
  }
  if (!bad.length && !soon.length && !bill.length) return 0;

  const ppl = await people(tid);
  const to = ppl.filter((p) => p.role === "admin" || p.role === "spravca" || (p.rights || {}).doprava === "edit").filter((p) => okEmail(p.email)).map((p) => ({ email: p.email, name: p.name }));
  if (!to.length) return 0;
  const firmName = firm.name || t.name || "firma";
  const lim = (a: string[]) => (a.length > 40 ? [...a.slice(0, 40), `… a ďalších ${a.length - 40}`] : a);
  const n = bad.length + soon.length + bill.length;
  await send({
    to, fromName: "Stavebná firma",
    subject: `Ranný prehľad ${d2(today)} – ${firmName}: ${n} ${pl(n, "upozornenie", "upozornenia", "upozornení")}`,
    mail: {
      firm: firmName, title: `Dobré ráno, prehľad na ${d2(today)}`,
      intro: "Čo si dnes vyžaduje pozornosť v Doprave a logistike:",
      sections: [{ h: `Po termíne (${bad.length})`, items: lim(bad) }, { h: `Blíži sa termín (${soon.length})`, items: lim(soon) }, { h: `Jazdy na fakturáciu (${bill.length})`, items: lim(bill) }],
      button: { label: "Otvoriť aplikáciu", url: `${APP}/?prihlasenie` },
      footer: "Ranný prehľad posiela aplikácia Stavebná firma (www.stavebnafirma.eu), len keď je čo hlásiť. Vypnúť ho môže administrátor firmy v karte Firma → Údaje o firme.",
    },
  });
  await log(tid, null, "digest", to.length);
  return to.length;
}
async function doDigest() {
  const { data: tens, error } = await admin.from("tenants").select("id,name,modules,complimentary,trial_ends_at,paid_modules");
  if (error) throw error;
  const now = Date.now(), today = todayBA();
  let sent = 0; const errors: string[] = [];
  for (const t of tens || []) {
    const on = (t.modules || {}).doprava !== false &&
      (t.complimentary || (t.trial_ends_at && Date.parse(t.trial_ends_at) > now) || (t.paid_modules?.doprava?.until && Date.parse(t.paid_modules.doprava.until) > now));
    if (!on) continue;
    try { sent += await digestFor(t, today); } catch (e) { console.error("súhrn", t.id, e); errors.push(String(t.id)); }
  }
  return json({ sent, errors });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");
    if (action === "reset") return await doReset(body);
    if (action === "digest") {
      const key = req.headers.get("x-cron-key") || "";
      const { data: ok } = await admin.rpc("cron_key_ok", { key });
      if (!ok) return json({ error: "Neoprávnené spustenie." }, 401);
      return await doDigest();
    }
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: uerr } = await admin.auth.getUser(token);
    if (uerr || !user) return json({ error: "Nie si prihlásený." }, 401);
    if (action === "invite") return await doInvite(user, body);
    if (action === "send") return await doSend(user, body);
    return json({ error: "Neznáma akcia." }, 400);
  } catch (e) {
    console.error(e);
    const m = String((e as Error)?.message || e);
    return json({ error: /535|EAUTH|Invalid login|authentication failed/i.test(m) ? `E-mail sa nepodarilo odoslať: schránka ${FROM_ADDR} odmietla prihlásenie (skontroluj SMTP_PASS a SMTP_USER).` : m }, 500);
  }
});
