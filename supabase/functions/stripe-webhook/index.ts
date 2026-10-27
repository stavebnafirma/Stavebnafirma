// Stripe → server: po zaplatení, obnove, zmene alebo zrušení predplatného nastaví firme dostupné moduly
// Nasadiť BEZ overovania JWT (Stripe neposiela prihlásenie, overuje sa podpis).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { stripe, verifySignature, paidFromSubscription } from "../_shared/stripe.ts";

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
