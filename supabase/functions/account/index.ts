// Zrušenie účtu a firmy. Volá aplikácia s prihláseným používateľom (heslo overí aplikácia tesne pred volaním):
//   POST { action: "delete_company", tenant_id, delete_account? }  – administrátor zruší celú firmu (a voliteľne aj svoj účet)
//   POST { action: "delete_me" }                                   – používateľ zruší svoj účet (firmy ostanú)
// Firma: ukončí predplatné v Stripe, vymaže súbory firmy v úložisku a riadok firmy (ostatné údaje sa zmažú kaskádou).
import { createClient } from "jsr:@supabase/supabase-js@2";
import { cors, json, stripe } from "../_shared/stripe.ts";

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
        const list = await stripe("GET", "subscriptions", { customer: ten.stripe_customer_id, status: "all", limit: 20 });
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
