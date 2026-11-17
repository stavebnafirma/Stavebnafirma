-- Harmonogramy (kind harms): harmonogram v Obchode (bez stavby) vidí a upravuje len administrátor (a správca) firmy,
-- harmonogram priradený stavbe (project_id) vidia tí, čo majú prístup k stavbe, a upravujú členovia tímu stavby.
-- Skript sa dá spustiť opakovane.
create or replace function public.can_read(t uuid, k text, p text)
 returns boolean language plpgsql stable security definer set search_path to 'public' as $function$
declare r text := public.my_role(t); m text := public.kind_module(k);
begin
  if r is null then return false; end if;
  if m <> 'firma' and not public.module_active(t, m) then return false; end if;
  if r in ('admin','spravca') then return true; end if;
  if k in ('finExp','finInc','partners','quotes','orders','cennik','stock','skFolders') then return false; end if;
  if k = 'harms' then
    if nullif(p, '') is null then return false; end if;
    return p = any(public.my_projects(t)) or (r <> 'dozor' and coalesce(public.my_rights(t) ->> 'stavba', '') in ('view','edit'));
  end if;
  if k = 'costs' then
    return r = 'clen' and coalesce(public.my_rights(t) ->> 'stavba', '') in ('view','edit');
  end if;
  if r = 'dozor' then
    return (p is not null and p = any(public.my_projects(t))) or (k = 'meta');
  end if;
  if m = 'firma' then return true; end if;
  if m = 'stavba' and p is not null and p = any(public.my_projects(t)) then return true; end if;
  return coalesce(public.my_rights(t) ->> m, '') in ('view','edit');
end $function$;

create or replace function public.can_write(t uuid, k text, p text)
 returns boolean language plpgsql stable security definer set search_path to 'public' as $function$
declare r text := public.my_role(t); m text := public.kind_module(k); rt jsonb := public.my_rights(t);
begin
  if r is null then return false; end if;
  if m <> 'firma' and not public.module_active(t, m) then return false; end if;
  if r in ('admin','spravca') then return true; end if;
  if k = 'costs' then return false; end if;
  if k = 'harms' then return r <> 'dozor' and nullif(p, '') is not null and (p = any(public.my_projects(t)) or rt ->> 'stavba' = 'edit'); end if;
  if r = 'dozor' then
    return k in ('projects','diary','projfin','subs') and p is not null and p = any(public.my_projects(t));
  end if;
  if k = 'tasks' then return true; end if;
  if k = 'workers' then return rt ->> 'personal' = 'edit'; end if;
  if k = 'machines' then return rt ->> 'doprava' = 'edit'; end if;
  if m = 'firma' then return false; end if;
  if m = 'stavba' and p is not null and p = any(public.my_projects(t)) then return true; end if;
  return rt ->> m = 'edit';
end $function$;
