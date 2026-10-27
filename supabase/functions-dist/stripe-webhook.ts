// Stripe → server: po zaplatení, obnove, zmene alebo zrušení predplatného nastaví firme dostupné moduly
// Nasadiť BEZ overovania JWT (Stripe neposiela prihlásenie, overuje sa podpis).
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

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function tenantFor(sub: any): Promise<string | null> {
  if (sub?.metadata?.tenant_id) return sub.metadata.tenant_id;
  const { data } = await admin.from("tenants").select("id").eq("stripe_customer_id", sub.customer).maybeSingle();
  return data?.id || null;
}
async function applySubscription(subOrId: any) {
  const sub = typeof subOrId === "string" ? await stripe("GET", `subscriptions/${subOrId}`) : subOrId;
  const tid = await tenantFor(sub);
  if (!tid) { console.warn("Predplatné bez firmy", sub.id); return; }
  const { paid, billing } = paidFromSubscription(sub);
  const { error } = await admin.from("tenants").update({ paid_modules: paid, billing, stripe_customer_id: sub.customer }).eq("id", tid);
  if (error) throw error;
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!secret) return new Response("Chýba STRIPE_WEBHOOK_SECRET", { status: 500 });
  const body = await req.text();
  if (!(await verifySignature(body, req.headers.get("Stripe-Signature"), secret))) return new Response("Neplatný podpis", { status: 400 });
  const ev = JSON.parse(body);
  try {
    const o = ev.data?.object || {};
    switch (ev.type) {
      case "checkout.session.completed":
        if (o.metadata?.tenant_id && o.customer) await admin.from("tenants").update({ stripe_customer_id: o.customer }).eq("id", o.metadata.tenant_id);
        if (o.subscription) await applySubscription(o.subscription);
        break;
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
      case "customer.subscription.paused":
      case "customer.subscription.resumed":
        // vždy načítať aktuálny stav (udalosti môžu prísť v inom poradí)
        await applySubscription(o.id);
        break;
      case "invoice.paid":
      case "invoice.payment_failed":
        if (o.subscription) await applySubscription(o.subscription);
        break;
    }
    return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(String((e as Error)?.message || e), { status: 500 });
  }
});
