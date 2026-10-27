// Predplatné modulov: ceny, platba (Stripe Checkout), zmena modulov, správa predplatného (Stripe portál)
// Volá aplikácia s prihláseným používateľom: POST { action, tenant_id, modules?, interval? }
import { createClient } from "jsr:@supabase/supabase-js@2";
// ---- spoločné (_shared/stripe.ts) ----
// Spoločné pomôcky pre Stripe (bez knižnice – priamo cez REST API Stripe)
export const MODULES = ["personal", "doprava", "pozicovna", "stavba"] as const;
export const INTERVALS = ["month", "year"] as const;
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

// ceny sú v Stripe označené kľúčom lookup_key: personal_month, personal_year, doprava_month, …
export const lookupKey = (m: string, i: string) => `${m}_${i}`;
export function moduleOfPrice(price: { lookup_key?: string | null; metadata?: Record<string, string> }): { module: string; interval: string } | null {
  const lk = price?.lookup_key || "";
  const [m, i] = lk.split("_");
  if ((MODULES as readonly string[]).includes(m) && (INTERVALS as readonly string[]).includes(i)) return { module: m, interval: i };
  const mm = price?.metadata?.module;
  return mm && (MODULES as readonly string[]).includes(mm) ? { module: mm, interval: "" } : null;
}
export async function pricesByKey(): Promise<Record<string, any>> {
  const keys = MODULES.flatMap((m) => INTERVALS.map((i) => lookupKey(m, i)));
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
  const paid: Record<string, { until: string; status: string; interval: string }> = {};
  let interval = "";
  if (active) {
    for (const it of sub.items?.data || []) {
      const mi = moduleOfPrice(it.price || {});
      if (!mi) continue;
      const end = Number(it.current_period_end || sub.current_period_end || 0);
      const until = new Date((end + GRACE_DAYS * 86400) * 1000).toISOString();
      paid[mi.module] = { until, status: sub.status, interval: mi.interval || it.price?.recurring?.interval || "" };
      interval = paid[mi.module].interval || interval;
    }
  }
  const billing = { subscription_id: sub.id, status: sub.status, interval, cancel_at_period_end: !!sub.cancel_at_period_end, updated: new Date().toISOString() };
  return { paid, billing };
}
// ---- funkcia ----

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const appUrl = () => (Deno.env.get("APP_URL") || "https://www.stavebnafirma.com").replace(/\/$/, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: uerr } = await admin.auth.getUser(token);
    if (uerr || !user) return json({ error: "Nie si prihlásený." }, 401);
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "");

    if (action === "prices") {
      const P = await pricesByKey();
      const out: Record<string, Record<string, { amount: number; currency: string } | null>> = {};
      for (const m of MODULES) { out[m] = {}; for (const i of INTERVALS) { const p = P[lookupKey(m, i)]; out[m][i] = p ? { amount: p.unit_amount / 100, currency: p.currency } : null; } }
      // na kontrolu nastavenia: všetky aktívne opakované ceny v Stripe (aj bez správneho lookup_key)
      const all = await stripe("GET", "prices", { active: true, type: "recurring", limit: 100, expand: ["data.product"] }).catch(() => ({ data: [] }));
      const stripePrices = (all.data || []).map((p: any) => ({ product: p.product?.name || "", lookup_key: p.lookup_key || "", interval: p.recurring?.interval || "", amount: (p.unit_amount || 0) / 100, livemode: !!p.livemode }));
      return json({ prices: out, stripePrices });
    }

    const tid = String(body.tenant_id || "");
    const { data: mem } = await admin.from("members").select("role").eq("tenant_id", tid).eq("user_id", user.id).maybeSingle();
    if (!mem || mem.role !== "admin") return json({ error: "Predplatné spravuje administrátor firmy." }, 403);
    const { data: ten } = await admin.from("tenants").select("id,name,stripe_customer_id,billing").eq("id", tid).single();
    if (!ten) return json({ error: "Firma neexistuje." }, 404);

    const ensureCustomer = async () => {
      if (ten.stripe_customer_id) return ten.stripe_customer_id as string;
      const c = await stripe("POST", "customers", { email: user.email, name: ten.name, metadata: { tenant_id: tid }, preferred_locales: ["sk"] });
      await admin.from("tenants").update({ stripe_customer_id: c.id }).eq("id", tid);
      return c.id as string;
    };

    if (action === "portal") {
      const customer = await ensureCustomer();
      const s = await stripe("POST", "billing_portal/sessions", { customer, return_url: `${appUrl()}/?platba=portal`, locale: "sk" });
      return json({ url: s.url });
    }

    if (action === "checkout") {
      const mods = (Array.isArray(body.modules) ? body.modules : []).filter((m: string) => (MODULES as readonly string[]).includes(m));
      const interval = (INTERVALS as readonly string[]).includes(body.interval) ? body.interval : "month";
      if (!mods.length) return json({ error: "Vyber aspoň jeden modul." }, 400);
      const P = await pricesByKey();
      const missing = mods.filter((m: string) => !P[lookupKey(m, interval)]);
      if (missing.length) return json({ error: `V Stripe chýba cena pre: ${missing.map((m: string) => lookupKey(m, interval)).join(", ")}` }, 400);

      // existujúce aktívne predplatné → len upraviť moduly (s doplatkom/dobropisom za zvyšok obdobia)
      const subId = ten.billing?.subscription_id;
      if (subId) {
        const sub = await stripe("GET", `subscriptions/${subId}`).catch(() => null);
        if (sub && ["active", "trialing", "past_due"].includes(sub.status)) {
          const want = new Set(mods.map((m: string) => P[lookupKey(m, interval)].id));
          const items: Record<string, unknown>[] = [];
          for (const it of sub.items.data) { if (want.has(it.price.id)) want.delete(it.price.id); else items.push({ id: it.id, deleted: true }); }
          for (const price of want) items.push({ price, quantity: 1 });
          const upd = await stripe("POST", `subscriptions/${subId}`, { items, proration_behavior: "create_prorations", cancel_at_period_end: false });
          const { paid, billing } = paidFromSubscription(upd);
          await admin.from("tenants").update({ paid_modules: paid, billing }).eq("id", tid);
          return json({ updated: true });
        }
      }
      const customer = await ensureCustomer();
      const s = await stripe("POST", "checkout/sessions", {
        mode: "subscription", customer, locale: "sk",
        line_items: mods.map((m: string) => ({ price: P[lookupKey(m, interval)].id, quantity: 1 })),
        subscription_data: { metadata: { tenant_id: tid } },
        metadata: { tenant_id: tid },
        allow_promotion_codes: true,
        billing_address_collection: "required",
        tax_id_collection: { enabled: true },
        customer_update: { name: "auto", address: "auto" },
        success_url: `${appUrl()}/?platba=ok`,
        cancel_url: `${appUrl()}/?platba=zrusena`,
      });
      return json({ url: s.url });
    }
    return json({ error: "Neznáma akcia." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});
