-- E-maily z aplikácie (pozvánky, kontrolné dni, výzvy, úlohy, ranný súhrn).
-- Posiela ich serverová funkcia "notify" cez schránku noreply@stavebnafirma.eu.
-- Táto migrácia pridá: záznam odoslaných e-mailov (denný limit firmy), čas odoslania pozvánky,
-- pomocné funkcie pre server a každodenné spustenie ranného súhrnu (pg_cron + pg_net).
-- Predpokladá spustené 001–013. Dá sa spustiť opakovane.

-- záznam odoslaných e-mailov – len pre server (RLS bez pravidiel)
create table if not exists public.mail_log (
  id         bigint generated always as identity primary key,
  tenant_id  uuid references public.tenants(id) on delete cascade,
  user_id    uuid,
  kind       text not null,
  recipients int  not null default 1,
  created_at timestamptz not null default now()
);
create index if not exists mail_log_tenant_idx on public.mail_log(tenant_id, created_at);
alter table public.mail_log enable row level security;

-- kedy bola pozvánka naposledy odoslaná e-mailom
alter table public.invites add column if not exists name text;
alter table public.invites add column if not exists sent_at timestamptz;

-- ľudia firmy s e-mailom (pre server: príjemcovia upozornení)
create or replace function public.notify_people(t uuid) returns table(user_id uuid, email text, name text, role text, rights jsonb)
language sql stable security definer set search_path = public as $$
  select m.user_id, u.email::text,
         coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), u.raw_user_meta_data->>'name', split_part(u.email::text, '@', 1)),
         m.role, m.rights
  from public.members m join auth.users u on u.id = m.user_id left join public.profiles p on p.id = m.user_id
  where m.tenant_id = t
$$;

-- je adresa firme známa? (člen, pozvánka alebo kontakt uložený v údajoch firmy) – ochrana pred zneužitím na spam
create or replace function public.notify_email_known(t uuid, e text) returns boolean
language sql stable security definer set search_path = public as $$
  select length(coalesce(e, '')) > 5 and (
    exists (select 1 from public.members m join auth.users u on u.id = m.user_id where m.tenant_id = t and lower(u.email) = lower(e))
    or exists (select 1 from public.invites i where i.tenant_id = t and lower(i.email) = lower(e))
    or exists (select 1 from public.docs d where d.tenant_id = t and position(lower(e) in lower(d.data::text)) > 0))
$$;

-- tajný kľúč, ktorým sa server presvedčí, že ranný súhrn spustil plánovač (nie niekto zvonka)
create table if not exists public.app_secrets (k text primary key, v text not null);
alter table public.app_secrets enable row level security;
insert into public.app_secrets(k, v) values ('cron', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (k) do nothing;
create or replace function public.cron_key_ok(key text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_secrets where k = 'cron' and v = key)
$$;

revoke execute on function public.notify_people(uuid), public.notify_email_known(uuid, text), public.cron_key_ok(text) from public, anon, authenticated;
grant execute on function public.notify_people(uuid), public.notify_email_known(uuid, text), public.cron_key_ok(text) to service_role;

-- ranný súhrn: každý deň o 5:00 UTC (6:00 v zime, 7:00 v lete)
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net with schema extensions;
    perform cron.unschedule(jobid) from cron.job where jobname = 'sf-ranny-suhrn';
    perform cron.schedule('sf-ranny-suhrn', '0 5 * * *', $job$
      select net.http_post(
        url     := 'https://jvwyudhlpdavvwqkarcn.supabase.co/functions/v1/notify',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', (select v from public.app_secrets where k = 'cron')),
        body    := '{"action":"digest"}'::jsonb,
        timeout_milliseconds := 60000)
    $job$);
  end if;
end $do$;
