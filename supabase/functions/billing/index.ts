// Predplatné modulov: ceny, platba (Stripe Checkout), zmena modulov, správa predplatného (Stripe portál)
// Volá aplikácia s prihláseným používateľom: POST { action, tenant_id, modules?, interval? }
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors, json, stripe, pricesByKey, lookupKey, MODULES, INTERVALS, paidFromSubscription } from "../_shared/stripe.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const admin = createClient(SB_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
// adresa aplikácie pre návrat zo Stripe (doplní https://, ak chýba)
const appUrl = () => { let u = (Deno.env.get("APP_URL") || "https://www.stavebnafirma.eu").trim().replace(/\/+$/, ""); if (!/^https?:\/\//i.test(u)) u = "https://" + u; return u; };

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
    if (!mem) return json({ error: "Do tejto firmy nemáš prístup." }, 403);
    const { data: ten } = await admin.from("tenants").select("id,name,stripe_customer_id,billing").eq("id", tid).single();
    if (!ten) return json({ error: "Firma neexistuje." }, 404);

    // zosúladenie so Stripe (ak by potvrdenie cez webhook neprišlo): najnovšie predplatné zákazníka
    if (action === "sync") {
      if (!ten.stripe_customer_id) return json({ synced: false });
      const list = await stripe("GET", "subscriptions", { customer: ten.stripe_customer_id, status: "all", limit: 10 });
      const subs = (list.data || []).sort((a: any, b: any) => b.created - a.created);
      const sub = subs.find((x: any) => ["active", "trialing", "past_due"].includes(x.status)) || subs[0];
      if (!sub) return json({ synced: false });
      const { paid, billing } = paidFromSubscription(sub);
      await admin.from("tenants").update({ paid_modules: paid, billing }).eq("id", tid);
      return json({ synced: true, paid });
    }
    if (mem.role !== "admin") return json({ error: "Predplatné spravuje administrátor firmy." }, 403);

    const ensureCustomer = async () => {
      if (ten.stripe_customer_id) return ten.stripe_customer_id as string;
      const c = await stripe("POST", "customers", { email: user.email, name: ten.name, metadata: { tenant_id: tid }, preferred_locales: ["sk"] });
      await admin.from("tenants").update({ stripe_customer_id: c.id }).eq("id", tid);
      ten.stripe_customer_id = c.id;
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
      // aktívne predplatné (aj keby ešte nebolo zapísané) → upraviť ho, nezakladať druhé
      let subId = ten.billing?.subscription_id;
      if (!subId && ten.stripe_customer_id) {
        const list = await stripe("GET", "subscriptions", { customer: ten.stripe_customer_id, status: "active", limit: 1 }).catch(() => ({ data: [] }));
        subId = list.data?.[0]?.id;
      }
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
