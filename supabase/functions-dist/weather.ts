// Počasie pre denný záznam stavby: podľa polohy stavby a dátumu vráti druh počasia a priemernú teplotu v pracovnom čase (7–15 h).
// Zdroj: Open-Meteo (modelové údaje). Bez kľúča beží bezplatné API (len na skúšanie, nie na komerčné použitie);
// po zakúpení predplatného stačí doplniť Secret OPENMETEO_KEY a funkcia prejde na komerčné API.
// POST { date: "2026-11-01", lat?, lng?, place? }
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
const KEY = Deno.env.get("OPENMETEO_KEY") || "";
const api = (path: string, host: string) => KEY ? `https://customer-${host}/${path}` : `https://${host}/${path}`;
const withKey = (u: string) => KEY ? `${u}&apikey=${encodeURIComponent(KEY)}` : u;

async function getJson(url: string) {
  const r = await fetch(withKey(url));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.reason || `Open-Meteo ${r.status}`);
  return j;
}
// obec / adresa → súradnice (skúša postupne: celý text, potom jednotlivé časti od konca, napr. obec)
async function geocode(place: string) {
  const parts = place.split(/[,·]/).map((s) => s.trim()).filter(Boolean);
  const tries = [...new Set([...parts.slice().reverse(), place].map((s) => s.replace(/^\d{3}\s?\d{2}\s+/, "")))].filter((s) => s.length >= 2);
  for (const q of tries) {
    const j = await getJson(api(`v1/search?name=${encodeURIComponent(q)}&count=1&language=sk&countryCode=SK&format=json`, "geocoding-api.open-meteo.com"));
    const g = j?.results?.[0];
    if (g) return { lat: g.latitude as number, lng: g.longitude as number, name: [g.name, g.admin2 || g.admin1].filter(Boolean).join(", ") };
  }
  return null;
}
// WMO kód počasia → voľba v dennom zázname
function classify(codes: number[], temps: number[], precip: number, windMax: number) {
  const has = (f: (c: number) => boolean) => codes.some(f);
  const avg = temps.reduce((s, t) => s + t, 0) / (temps.length || 1);
  if (has((c) => (c >= 71 && c <= 77) || c === 85 || c === 86)) return "Sneh";
  if (precip >= 0.3 && has((c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82) || c >= 95)) return "Dážď";
  if (windMax >= 40) return "Vietor";
  if (avg < 0) return "Mráz";
  const cnt = { jasno: 0, polo: 0, zam: 0 };
  for (const c of codes) { if (c <= 1) cnt.jasno++; else if (c === 2) cnt.polo++; else cnt.zam++; }
  return cnt.zam >= cnt.jasno && cnt.zam >= cnt.polo ? "Zamračené" : cnt.polo >= cnt.jasno ? "Polojasno" : "Jasno";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: { user }, error: uerr } = await admin.auth.getUser(token);
    if (uerr || !user) return json({ error: "Nie si prihlásený." }, 401);
    const body = await req.json().catch(() => ({}));
    const date = String(body.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Chýba dátum." }, 400);
    const days = Math.round((Date.parse(date) - Date.now()) / 864e5);
    if (days < -90) return json({ error: "Počasie sa dá načítať najviac 3 mesiace dozadu. Zadaj ho ručne." }, 400);
    if (days > 14) return json({ error: "Predpoveď počasia je dostupná najviac 14 dní dopredu." }, 400);

    let lat = Number(body.lat), lng = Number(body.lng), name = "";
    if (!isFinite(lat) || !isFinite(lng) || (!lat && !lng)) {
      const place = String(body.place || "").trim();
      if (!place) return json({ error: "Stavba nemá zadané miesto. Doplň obec alebo GPS v nastaveniach stavby." }, 400);
      const g = await geocode(place);
      if (!g) return json({ error: `Miesto „${place}“ sa nepodarilo nájsť. Skontroluj obec v nastaveniach stavby alebo zadaj GPS.` }, 400);
      ({ lat, lng, name } = g);
    }
    const url = api(`v1/forecast?latitude=${lat}&longitude=${lng}&hourly=temperature_2m,weather_code,precipitation,wind_speed_10m&timezone=Europe%2FBratislava&start_date=${date}&end_date=${date}`, "api.open-meteo.com");
    const j = await getJson(url);
    const H = j.hourly || {};
    const idx = (H.time || []).map((t: string, i: number) => [Number(t.slice(11, 13)), i]).filter(([h]: number[]) => h >= 7 && h <= 15).map(([, i]: number[]) => i);
    if (!idx.length) return json({ error: "Pre tento deň nie sú údaje o počasí." }, 404);
    const pick = (k: string) => idx.map((i: number) => Number(H[k]?.[i])).filter((x: number) => isFinite(x));
    const temps = pick("temperature_2m"), codes = pick("weather_code"), prec = pick("precipitation"), wind = pick("wind_speed_10m");
    const precip = prec.reduce((s: number, x: number) => s + x, 0), windMax = Math.max(0, ...wind);
    const temp = Math.round(temps.reduce((s: number, t: number) => s + t, 0) / (temps.length || 1));
    return json({
      weather: classify(codes, temps, precip, windMax), temp,
      tmin: Math.round(Math.min(...temps)), tmax: Math.round(Math.max(...temps)),
      precip: Math.round(precip * 10) / 10, windMax: Math.round(windMax), lat, lng, place: name, source: "Open-Meteo",
    });
  } catch (e) {
    console.error(e);
    return json({ error: "Počasie sa nepodarilo načítať: " + String((e as Error)?.message || e) }, 500);
  }
});
