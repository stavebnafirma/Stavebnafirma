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
        'firm', (select jsonb_build_object('ico', d.data->'v'->>'ico', 'city', d.data->'v'->>'city',
                   'phone', d.data->'v'->>'phone', 'email', d.data->'v'->>'email')
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
