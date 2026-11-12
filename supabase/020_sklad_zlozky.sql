-- Sklad: zložky (umiestnenie materiálu) – kind skFolders, čítať a zapisovať len administrátor (a správca) firmy.
-- Údaje sú v tabuľke docs (kind = názov poľa). Čítať a zapisovať ich smie len administrátor (a správca) firmy.
-- Skript sa dá spustiť opakovane.
create or replace function public.can_read(t uuid, k text, p text)
 returns boolean language plpgsql stable security definer set search_path to 'public' as $function$
declare r text := public.my_role(t); m text := public.kind_module(k);
begin
  if r is null then return false; end if;
  if m <> 'firma' and not public.module_active(t, m) then return false; end if;
  if r in ('admin','spravca') then return true; end if;
  if k in ('finExp','finInc','partners','quotes','orders','cennik','stock','skFolders') then return false; end if;
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
