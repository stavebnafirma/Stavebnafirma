// Počasie pre denný záznam stavby: podľa polohy stavby a dátumu vráti druh počasia a priemernú teplotu v pracovnom čase (7–15 h).
// Zdroj: Open-Meteo (modelové údaje). Bez kľúča beží bezplatné API (len na skúšanie, nie na komerčné použitie);
// po zakúpení predplatného stačí doplniť Secret OPENMETEO_KEY a funkcia prejde na komerčné API.
// POST { date: "2026-11-01", lat?, lng?, place? }
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors, json } from "../_shared/stripe.ts";

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
