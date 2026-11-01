// Zrušenie účtu a firmy. Volá aplikácia s prihláseným používateľom (heslo overí aplikácia tesne pred volaním):
//   POST { action: "delete_company", tenant_id, delete_account? }  – administrátor zruší celú firmu (a voliteľne aj svoj účet)
//   POST { action: "delete_me" }                                   – používateľ zruší svoj účet (firmy ostanú)
// Firma: ukončí predplatné v Stripe, vymaže súbory firmy v úložisku a riadok firmy (ostatné údaje sa zmažú kaskádou).
import { createClient } from "jsr:@supabase/supabase-js@2";
// ---- spoločné (_shared/stripe.ts) ----
// Spoločné pomôcky pre Stripe (bez knižnice – priamo cez REST API Stripe)
export const MODULES = ["personal", "doprava", "pozicovna", "stavba"] as const;
export const INTERVALS = ["month", "year"] as const;
// moduly s balíčkami podľa počtu (stavby / zamestnanci / stroje): 1 = najmenší, 3 = bez obmedzenia
export const TIERED = ["stavba", "personal", "doprava"] as const;
export const TIERS = [1, 2, 3] as const;
export const isTiered = (m: string) => (TIERED as readonly string[]).includes(m);
export const GRACE_DAYS = 3; // rezerva po konci obdobia, kým príde platba za ďalšie
const STRIPE_VERSION = "2024-06-20";

export const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

// vnorené parametre → formulár pre Stripe (a[b][0][c]=…)
function enc(obj: unknown, prefix = "", out: string[] = []): string[] {
  if (obj === undefined || obj === null) return out;
  if (Array.isArray(obj)) obj.forEach((v, i) => enc(v, `${prefix}[${i}]`, out));
  else if (typeof obj === "object") for (const [k, v] of Object.entries(obj as Record<string, unknown>)) enc(v, prefix ? `${prefix}[${k}]` : k, out);
  else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(obj))}`);
  return out;
}
export async function stripe(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, unknown>) {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("Chýba STRIPE_SECRET_KEY v nastaveniach Supabase (Edge Functions → Secrets).");
  const qs = params ? enc(params).join("&") : "";
  const url = `https://api.stripe.com/v1/${path}${method === "GET" && qs ? `?${qs}` : ""}`;
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION, ...(method !== "GET" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: method !== "GET" ? qs : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Stripe ${res.status}`);
  return data;
}

// ceny sú v Stripe označené kľúčom lookup_key:
//   moduly s balíčkami: stavba_1_month, stavba_1_year, stavba_2_month … doprava_3_year
//   Požičovňa (bez balíčkov): pozicovna_month, pozicovna_year
export const lookupKey = (m: string, i: string, t?: number) => (isTiered(m) ? `${m}_${t || 1}_${i}` : `${m}_${i}`);
export function allLookupKeys(): string[] {
  return MODULES.flatMap((m) => isTiered(m) ? TIERS.flatMap((t) => INTERVALS.map((i) => lookupKey(m, i, t))) : INTERVALS.map((i) => lookupKey(m, i)));
}
export function moduleOfPrice(price: { lookup_key?: string | null; metadata?: Record<string, string> }): { module: string; interval: string; tier: number } | null {
  const parts = (price?.lookup_key || "").split("_");
  const m = parts[0], i = parts[parts.length - 1], t = parts.length === 3 ? Number(parts[1]) : 0;
  if ((MODULES as readonly string[]).includes(m) && (INTERVALS as readonly string[]).includes(i)) return { module: m, interval: i, tier: t };
  const mm = price?.metadata?.module;
  return mm && (MODULES as readonly string[]).includes(mm) ? { module: mm, interval: "", tier: Number(price?.metadata?.tier || 0) } : null;
}
export async function pricesByKey(): Promise<Record<string, any>> {
  const keys = allLookupKeys();
  const r = await stripe("GET", "prices", { lookup_keys: keys, active: true, limit: 100 });
  const out: Record<string, any> = {};
  for (const p of r.data || []) if (p.lookup_key) out[p.lookup_key] = p;
  return out;
}

// overenie podpisu webhooku (hlavička Stripe-Signature)
export async function verifySignature(body: string, header: string | null, secret: string, toleranceSec = 300): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i).trim(), kv.slice(i + 1)]; }));
  const t = parts["t"]; const sigs = header.split(",").filter((x) => x.trim().startsWith("v1=")).map((x) => x.trim().slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === hex.length && timingSafeEqual(s, hex));
}
function timingSafeEqual(a: string, b: string) { let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }

// zo Stripe predplatného → zaplatené moduly firmy
export function paidFromSubscription(sub: any) {
  const active = ["active", "trialing", "past_due"].includes(sub.status);
  const paid: Record<string, { until: string; status: string; interval: string; tier: number }> = {};
  let interval = "";
  if (active) {
    for (const it of sub.items?.data || []) {
      const mi = moduleOfPrice(it.price || {});
      if (!mi) continue;
      const end = Number(it.current_period_end || sub.current_period_end || 0);
      const until = new Date((end + GRACE_DAYS * 86400) * 1000).toISOString();
      paid[mi.module] = { until, status: sub.status, interval: mi.interval || it.price?.recurring?.interval || "", tier: mi.tier };
      interval = paid[mi.module].interval || interval;
    }
  }
  const billing = { subscription_id: sub.id, status: sub.status, interval, cancel_at_period_end: !!sub.cancel_at_period_end, updated: new Date().toISOString() };
  return { paid, billing };
}
// ---- funkcia ----

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKETS = ["files", "dokumentacia"];

// všetky súbory v priečinku (aj vo vnorených priečinkoch)
async function listAll(bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, { limit: 1000, offset });
    if (error) throw error;
    for (const it of data || []) {
      const path = `${prefix}/${it.name}`;
      if (it.id) out.push(path); else out.push(...await listAll(bucket, path));   // bez id = priečinok
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}
async function removeTenantFiles(tid: string) {
  for (const b of BUCKETS) {
    const paths = await listAll(b, tid).catch((e) => { if (/not found/i.test(String(e?.message))) return []; throw e; });
    for (let i = 0; i < paths.length; i += 500) {
      const { error } = await admin.storage.from(b).remove(paths.slice(i, i + 500));
      if (error) throw error;
    }
  }
}
// firmy, v ktorých je používateľ jediným administrátorom
async function soleAdminTenants(uid: string) {
  const { data: mine } = await admin.from("members").select("tenant_id, tenants(name)").eq("user_id", uid).eq("role", "admin");
  const out: { id: string; name: string }[] = [];
  for (const m of mine || []) {
    const { count } = await admin.from("members").select("user_id", { count: "exact", head: true }).eq("tenant_id", m.tenant_id).eq("role", "admin").neq("user_id", uid);
    if (!count) out.push({ id: m.tenant_id, name: (m as any).tenants?.name || "" });
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: uerr } = await admin.auth.getUser(token);
    if (uerr || !user) return json({ error: "Nie si prihlásený." }, 401);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "delete_me") {
      const sole = await soleAdminTenants(user.id);
      if (sole.length) return json({ error: `Si jediný administrátor firmy ${sole.map((t) => t.name).join(", ")}. Najprv nastav administrátora niekomu inému alebo zruš celú firmu.` }, 400);
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) throw error;
      return json({ deleted: "account" });
    }

    if (action === "delete_company") {
      const tid = String(body.tenant_id || "");
      const { data: mem } = await admin.from("members").select("role").eq("tenant_id", tid).eq("user_id", user.id).maybeSingle();
      if (!mem || mem.role !== "admin") return json({ error: "Firmu môže zrušiť iba jej administrátor." }, 403);
      const { data: ten } = await admin.from("tenants").select("id,name,stripe_customer_id,billing").eq("id", tid).single();
      if (!ten) return json({ error: "Firma neexistuje." }, 404);

      // 1) predplatné: ukončiť ihneď, aby sa už nič nestrhávalo (ak zlyhá, firma sa nezmaže)
      if (ten.stripe_customer_id && Deno.env.get("STRIPE_SECRET_KEY")) {
        // zákazník z testovacieho režimu (alebo už zmazaný) – nie je čo rušiť
        const list = await stripe("GET", "subscriptions", { customer: ten.stripe_customer_id, status: "all", limit: 20 })
          .catch((e) => { if (/No such customer/i.test(String(e?.message))) return { data: [] }; throw e; });
        for (const s of list.data || []) {
          if (["active", "trialing", "past_due", "unpaid", "incomplete", "paused"].includes(s.status)) await stripe("DELETE", `subscriptions/${s.id}`);
        }
      }
      // 2) súbory firmy v úložisku
      await removeTenantFiles(tid);
      // 3) firma a všetky jej údaje (docs, members, invites… sa zmažú kaskádou)
      const { error: derr } = await admin.from("tenants").delete().eq("id", tid);
      if (derr) throw derr;
      // 4) voliteľne aj účet administrátora – len ak už nie je jediným administrátorom inej firmy
      let account = false;
      if (body.delete_account) {
        const sole = await soleAdminTenants(user.id);
        if (!sole.length) { const { error } = await admin.auth.admin.deleteUser(user.id); if (error) throw error; account = true; }
      }
      return json({ deleted: "company", account });
    }
    return json({ error: "Neznáma akcia." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
