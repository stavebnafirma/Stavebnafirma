-- Stavebná firma – aktualizácia databázy (1. 11. 2026)
-- Obsahuje migrácie 011 (ukončenie stavby) a 012 (admin platformy). Dá sa spustiť aj opakovane.

-- Ukončenie stavby: stavba s údajom "closed" je natrvalo uzamknutá.
-- Databáza zaručí, že ju už nikto nezmení ani neodomkne a nezmení ani jej denné záznamy, náklady a dokumentáciu.
-- Zmeny sa ticho preskočia (bez chyby), aby sa zariadenie, ktoré bolo offline a má staré úpravy, nezaseklo pri ukladaní.
-- Odstrániť ukončenú stavbu (aj s jej záznamami a súbormi) môže iba administrátor alebo správca firmy.
-- Predpokladá spustené 001–007. Dá sa spustiť opakovane.

create or replace function public.proj_closed(t uuid, p text) returns boolean
language sql stable security definer set search_path = public as $$
  select p is not null and exists (
    select 1 from public.docs where tenant_id = t and kind = 'projects' and id = p and data ? 'closed')
$$;
revoke execute on function public.proj_closed(uuid, text) from public, anon;
grant execute on function public.proj_closed(uuid, text) to authenticated;

create or replace function public.guard_closed_project() returns trigger
language plpgsql security definer set search_path = public as $$
declare t uuid; p text;
begin
  if tg_op = 'DELETE' then
    t := old.tenant_id; p := coalesce(old.project_id, case when old.kind = 'projects' then old.id end);
    if public.proj_closed(t, p) and coalesce(public.my_role(t), '') not in ('admin', 'spravca') then
      return null;                       -- mazať ukončenú stavbu smie len administrátor alebo správca
    end if;
    return old;
  end if;

  t := new.tenant_id;
  if new.kind = 'projects' then
    if tg_op = 'UPDATE' and old.data ? 'closed' then
      return null;                       -- ukončená stavba sa už nemení ani neodomyká
    end if;
    return new;
  end if;
  if public.proj_closed(t, new.project_id) then
    return null;                         -- denné záznamy, náklady a pod. ukončenej stavby sa nemenia
  end if;
  return new;
end $$;

drop trigger if exists docs_closed_project on public.docs;
create trigger docs_closed_project before insert or update or delete on public.docs
  for each row execute function public.guard_closed_project();

-- Dokumentácia v Storage: do ukončenej stavby sa nedá nahrávať; mazať súbory smie len administrátor alebo správca
drop policy if exists "dokumentacia_nahranie" on storage.objects;
create policy "dokumentacia_nahranie" on storage.objects for insert to authenticated
  with check (bucket_id = 'dokumentacia' and case
    when (storage.foldername(name))[2] = 'naklady'
      then public.can_write(public.try_uuid((storage.foldername(name))[1]), 'costs', null)
           and not public.proj_closed(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[3])
    else public.doc_can_upload(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[2])
         and not public.proj_closed(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[2]) end);

drop policy if exists "dokumentacia_mazanie" on storage.objects;
create policy "dokumentacia_mazanie" on storage.objects for delete to authenticated
  using (bucket_id = 'dokumentacia' and case
    when (storage.foldername(name))[2] = 'naklady'
      then public.can_write(public.try_uuid((storage.foldername(name))[1]), 'costs', null)
           and (not public.proj_closed(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[3])
                or coalesce(public.my_role(public.try_uuid((storage.foldername(name))[1])), '') in ('admin', 'spravca'))
    else public.doc_can_upload(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[2])
         and (not public.proj_closed(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[2])
              or coalesce(public.my_role(public.try_uuid((storage.foldername(name))[1])), '') in ('admin', 'spravca')) end);

-- Admin platformy: prehľad všetkých registrovaných firiem pre prevádzkovateľa (Kalimis s.r.o.).
-- Prístup má iba účet s e-mailom v tabuľke platform_admins, a to len s overeným (potvrdeným) e-mailom.
-- Tabuľka nie je dostupná cez API (RLS bez pravidiel); údaje vydáva len funkcia platform_overview().
-- Dá sa spustiť opakovane.

create table if not exists public.platform_admins (email text primary key);
alter table public.platform_admins enable row level security;
insert into public.platform_admins(email) values ('info@stavebnafirma.eu') on conflict do nothing;

create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from auth.users u join public.platform_admins a on lower(a.email) = lower(u.email)
    where u.id = auth.uid() and u.email_confirmed_at is not null)
$$;

create or replace function public.platform_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Prístup len pre správcu platformy';
  end if;
  return coalesce((
    select jsonb_agg(x order by (x->>'created_at') desc) from (
      select jsonb_build_object(
        'id', t.id, 'name', t.name, 'created_at', t.created_at, 'trial_ends_at', t.trial_ends_at,
        'complimentary', t.complimentary, 'paid_modules', t.paid_modules, 'billing', t.billing, 'modules', t.modules,
        'active', jsonb_build_object(
          'personal', public.module_active(t.id, 'personal'), 'doprava', public.module_active(t.id, 'doprava'),
          'stavba', public.module_active(t.id, 'stavba'), 'pozicovna', public.module_active(t.id, 'pozicovna')),
        'firm', (select jsonb_build_object('ico', d.data->'v'->>'ico', 'street', d.data->'v'->>'street', 'zip', d.data->'v'->>'zip',
                   'city', d.data->'v'->>'city', 'phone', d.data->'v'->>'phone', 'email', d.data->'v'->>'email', 'web', d.data->'v'->>'web')
                 from public.docs d where d.tenant_id = t.id and d.kind = 'meta' and d.id = 'firm'),
        'founder', (select jsonb_build_object('email', u.email,
                      'name', coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), u.raw_user_meta_data->>'name'),
                      'phone', p.phone, 'last_sign_in', u.last_sign_in_at)
                    from public.members m join auth.users u on u.id = m.user_id left join public.profiles p on p.id = m.user_id
                    where m.tenant_id = t.id and m.role = 'admin' order by m.created_at limit 1),
        'counts', jsonb_build_object(
          'projects_active', (select count(*) from public.docs where tenant_id = t.id and kind = 'projects' and not (data ? 'closed')),
          'projects_closed', (select count(*) from public.docs where tenant_id = t.id and kind = 'projects' and data ? 'closed'),
          'diary',           (select count(*) from public.docs where tenant_id = t.id and kind = 'diary'),
          'workers_active',  (select count(*) from public.docs where tenant_id = t.id and kind = 'workers' and coalesce(data->>'active', 'true') <> 'false'),
          'machines',        (select count(*) from public.docs where tenant_id = t.id and kind = 'machines'),
          'jobs',            (select count(*) from public.docs where tenant_id = t.id and kind = 'jobs'),
          'rent_items',      (select count(*) from public.docs where tenant_id = t.id and kind = 'rentItems'),
          'rentals',         (select count(*) from public.docs where tenant_id = t.id and kind = 'rentals'),
          'members',         (select count(*) from public.members where tenant_id = t.id)),
        'last_activity', (select max(updated_at) from public.docs where tenant_id = t.id)
      ) x
      from public.tenants t) s), '[]'::jsonb);
end $$;

revoke execute on function public.is_platform_admin(), public.platform_overview() from public, anon;
grant execute on function public.is_platform_admin(), public.platform_overview() to authenticated;
