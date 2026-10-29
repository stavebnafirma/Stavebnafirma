-- Ekonomika stavby: náklady (kind 'costs') a fotky dokladov.
-- Náklady patria do modulu Stavba, ale nevidí ich stavebný dozor ani bežný člen stavby –
-- čítať ich môže administrátor, správca a používateľ s právom vidieť Stavbu, zapisovať administrátor a správca.
-- Fotky dokladov sú v Storage "dokumentacia" v ceste <tenant_id>/naklady/<id stavby>/<súbor>.
-- Predpokladá spustené 004 a 006. Dá sa spustiť opakovane.

create or replace function public.kind_module(k text) returns text
language sql immutable set search_path = public as $$
  select case
    when k in ('att','trips','trainings','payProf','payMon') then 'personal'
    when k in ('jobs','weighs','teams')         then 'doprava'
    when k in ('rentItems','rentals')           then 'pozicovna'
    when k in ('projects','diary','costs')      then 'stavba'
    else 'firma'
  end
$$;

create or replace function public.can_read(t uuid, k text, p text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare r text := public.my_role(t); m text := public.kind_module(k);
begin
  if r is null then return false; end if;
  if m <> 'firma' and not public.module_active(t, m) then return false; end if;
  if r in ('admin','spravca') then return true; end if;
  if k = 'costs' then
    return r = 'clen' and coalesce(public.my_rights(t) ->> 'stavba', '') in ('view','edit');
  end if;
  if r = 'dozor' then
    return (p is not null and p = any(public.my_projects(t))) or (k = 'meta');
  end if;
  if m = 'firma' then return true; end if;
  if m = 'stavba' and p is not null and p = any(public.my_projects(t)) then return true; end if;
  return coalesce(public.my_rights(t) ->> m, '') in ('view','edit');
end $$;

create or replace function public.can_write(t uuid, k text, p text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare r text := public.my_role(t); m text := public.kind_module(k); rt jsonb := public.my_rights(t);
begin
  if r is null then return false; end if;
  if m <> 'firma' and not public.module_active(t, m) then return false; end if;
  if r in ('admin','spravca') then return true; end if;
  if k = 'costs' then return false; end if;
  if r = 'dozor' then
    return k in ('projects','diary') and p is not null and p = any(public.my_projects(t));
  end if;
  if k = 'tasks' then return true; end if;
  if k = 'workers' then return rt ->> 'personal' = 'edit'; end if;
  if k = 'machines' then return rt ->> 'doprava' = 'edit'; end if;
  if m = 'firma' then return false; end if;
  if m = 'stavba' and p is not null and p = any(public.my_projects(t)) then return true; end if;
  return rt ->> m = 'edit';
end $$;

-- Storage: priečinok "naklady" sa riadi právami na náklady, ostatné ako dokumentácia stavby (006)
drop policy if exists "dokumentacia_citanie" on storage.objects;
create policy "dokumentacia_citanie" on storage.objects for select to authenticated
  using (bucket_id = 'dokumentacia' and case
    when (storage.foldername(name))[2] = 'naklady'
      then public.can_read(public.try_uuid((storage.foldername(name))[1]), 'costs', null)
    else public.can_read(public.try_uuid((storage.foldername(name))[1]), 'projects', (storage.foldername(name))[2]) end);

drop policy if exists "dokumentacia_nahranie" on storage.objects;
create policy "dokumentacia_nahranie" on storage.objects for insert to authenticated
  with check (bucket_id = 'dokumentacia' and case
    when (storage.foldername(name))[2] = 'naklady'
      then public.can_write(public.try_uuid((storage.foldername(name))[1]), 'costs', null)
    else public.doc_can_upload(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[2]) end);

drop policy if exists "dokumentacia_mazanie" on storage.objects;
create policy "dokumentacia_mazanie" on storage.objects for delete to authenticated
  using (bucket_id = 'dokumentacia' and case
    when (storage.foldername(name))[2] = 'naklady'
      then public.can_write(public.try_uuid((storage.foldername(name))[1]), 'costs', null)
    else public.doc_can_upload(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[2]) end);
