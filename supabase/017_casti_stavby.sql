-- 017 – Stavba rozdelená na časti (úseky) so subdodávateľmi – dá sa spustiť opakovane
-- Nové druhy riadkov v docs:
--   projfin – rozpočet a súpisy generálneho zhotoviteľa (vyčlenené z riadku stavby)
--   subs    – rozpočet, súpisy a priečinok dokumentov subdodávateľa jednej časti stavby (data.areaId)
-- Subdodávateľ = externý člen (rola „dozor“ v members) s pridelenými časťami v members.rights.areas = { "<id stavby>": ["<id časti>", …] }.
-- Vidí len denné záznamy svojich častí, nevidí rozpočet a súpisy generálneho zhotoviteľa, nemení riadok stavby.
-- Údaje subdodávateľov (subs) nevidí stavebný dozor ani iný externý člen.

create or replace function public.kind_module(k text) returns text language sql immutable set search_path to 'public' as $$
  select case
    when k in ('att','trips','trainings','payProf','payMon') then 'personal'
    when k in ('jobs','weighs','teams','gpsPlaces','carriers','wInit') then 'doprava'
    when k in ('rentItems','rentals')                          then 'pozicovna'
    when k in ('projects','diary','costs','projfin','subs')    then 'stavba'
    else 'firma'
  end
$$;

-- zápis externého člena: stavba, denník, rozpočet/súpisy (dozor odsúhlasuje) a časť subdodávateľa
create or replace function public.can_write(t uuid, k text, p text)
 returns boolean language plpgsql stable security definer set search_path to 'public' as $$
declare r text := public.my_role(t); m text := public.kind_module(k); rt jsonb := public.my_rights(t);
begin
  if r is null then return false; end if;
  if m <> 'firma' and not public.module_active(t, m) then return false; end if;
  if r in ('admin','spravca') then return true; end if;
  if k = 'costs' then return false; end if;
  if r = 'dozor' then
    return k in ('projects','diary','projfin','subs') and p is not null and p = any(public.my_projects(t));
  end if;
  if k = 'tasks' then return true; end if;
  if k = 'workers' then return rt ->> 'personal' = 'edit'; end if;
  if k = 'machines' then return rt ->> 'doprava' = 'edit'; end if;
  if m = 'firma' then return false; end if;
  if m = 'stavba' and p is not null and p = any(public.my_projects(t)) then return true; end if;
  return rt ->> m = 'edit';
end $$;

-- časti stavby pridelené prihlásenému externému členovi (null = nie je subdodávateľ s časťou na tejto stavbe)
create or replace function public.my_areas(t uuid, p text) returns text[] language sql stable security definer set search_path to 'public' as $$
  select case when public.my_role(t) = 'dozor' and p is not null
               and jsonb_typeof(public.my_rights(t) -> 'areas' -> p) = 'array'
               and jsonb_array_length(public.my_rights(t) -> 'areas' -> p) > 0
    then array(select jsonb_array_elements_text(public.my_rights(t) -> 'areas' -> p)) end
$$;

create or replace function public.area_read(t uuid, k text, p text, d jsonb) returns boolean language plpgsql stable security definer set search_path to 'public' as $$
declare a text[] := public.my_areas(t, p);
begin
  if k = 'subs' then
    if coalesce(public.my_role(t), '') <> 'dozor' then return true; end if;     -- generálny zhotoviteľ (zamestnanci firmy)
    return a is not null and coalesce(d ->> 'areaId', '') = any(a);           -- subdodávateľ len svoju časť; dozor nič
  end if;
  if a is null then return true; end if;
  if k = 'projfin' then return false; end if;
  if k = 'diary' then return coalesce(d ->> 'areaId', '') = any(a); end if;
  return true;
end $$;

create or replace function public.area_write(t uuid, k text, p text, d jsonb) returns boolean language plpgsql stable security definer set search_path to 'public' as $$
declare a text[] := public.my_areas(t, p);
begin
  if k = 'subs' then return public.area_read(t, k, p, d); end if;
  if a is null then return true; end if;
  if k in ('projects','projfin') then return false; end if;
  if k = 'diary' then return coalesce(d ->> 'areaId', '') = any(a); end if;
  return true;
end $$;

revoke execute on function public.my_areas(uuid, text) from public, anon;
revoke execute on function public.area_read(uuid, text, text, jsonb) from public, anon;
revoke execute on function public.area_write(uuid, text, text, jsonb) from public, anon;
grant execute on function public.my_areas(uuid, text) to authenticated;
grant execute on function public.area_read(uuid, text, text, jsonb) to authenticated;
grant execute on function public.area_write(uuid, text, text, jsonb) to authenticated;

drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select
  using (public.can_read(tenant_id, kind, project_id) and public.area_read(tenant_id, kind, project_id, data));
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert
  with check (public.can_write(tenant_id, kind, project_id) and public.area_write(tenant_id, kind, project_id, data));
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update
  using (public.can_write(tenant_id, kind, project_id) and public.area_write(tenant_id, kind, project_id, data))
  with check (public.can_write(tenant_id, kind, project_id) and public.area_write(tenant_id, kind, project_id, data));
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete
  using (public.can_write(tenant_id, kind, project_id) and public.area_write(tenant_id, kind, project_id, data));
