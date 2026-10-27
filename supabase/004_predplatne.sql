-- Stavebná firma – doplnok 4: predplatné modulov (Stripe) a skúšobné obdobie
-- Spustenie: SQL Editor → New query → vložiť → Run (dá sa spustiť aj opakovane)
--
-- Moduly: personal, doprava, pozicovna, stavba. Karta Firma je zadarmo.
-- Modul je dostupný, ak: firma je v skúšobnom období, alebo má modul zaplatený (paid_until v budúcnosti),
-- alebo má firma bezplatný prístup (complimentary).
-- Zapnuté moduly mení len server (Stripe webhook so service_role), nie administrátor firmy.

alter table public.tenants add column if not exists trial_ends_at   timestamptz;
alter table public.tenants add column if not exists paid_modules    jsonb not null default '{}';  -- {"doprava":{"until":"2026-12-01T00:00:00Z","status":"active"}}
alter table public.tenants add column if not exists billing         jsonb not null default '{}';  -- {"interval":"month","subscription_id":"…","status":"active"}
alter table public.tenants add column if not exists stripe_customer_id text;
alter table public.tenants add column if not exists complimentary   boolean not null default false;

-- existujúce firmy bez skúšobného obdobia dostanú 14 dní od teraz
update public.tenants set trial_ends_at = now() + interval '14 days' where trial_ends_at is null;
alter table public.tenants alter column trial_ends_at set default now() + interval '14 days';

-- je modul vo firme dostupný?
create or replace function public.module_active(t uuid, m text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select complimentary
        or (trial_ends_at is not null and trial_ends_at > now())
        or coalesce((paid_modules -> m ->> 'until')::timestamptz > now(), false)
    from public.tenants where id = t), false)
$$;

-- stav predplatného pre kartu Moduly (len pre členov firmy)
create or replace function public.billing_status(t uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'trial_ends_at', trial_ends_at,
    'complimentary', complimentary,
    'paid_modules', paid_modules,
    'billing', billing,
    'has_customer', stripe_customer_id is not null,
    'active', jsonb_build_object(
      'personal',  public.module_active(t,'personal'),
      'doprava',   public.module_active(t,'doprava'),
      'pozicovna', public.module_active(t,'pozicovna'),
      'stavba',    public.module_active(t,'stavba')),
    'now', now())
  from public.tenants where id = t and public.my_role(t) is not null
$$;

-- pravidlá prístupu: údaje modulu len ak je modul dostupný (Firma vždy)
create or replace function public.can_read(t uuid, k text, p text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare r text := public.my_role(t); m text := public.kind_module(k);
begin
  if r is null then return false; end if;
  if m <> 'firma' and not public.module_active(t, m) then return false; end if;
  if r in ('admin','spravca') then return true; end if;
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

-- administrátor firmy už nemení stĺpce firmy priamo (moduly a platby mení len server)
drop policy if exists tenants_update on public.tenants;

-- nová firma: skúšobné obdobie 14 dní, zvolené moduly si len pamätáme
create or replace function public.create_tenant(p_name text, p_modules jsonb default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'Nie si prihlásený'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Chýba názov firmy'; end if;
  insert into public.tenants(name, modules, trial_ends_at)
    values (trim(p_name), coalesce(p_modules, '{"personal":true,"doprava":true,"pozicovna":true,"stavba":true}'), now() + interval '14 days')
    returning id into t;
  insert into public.members(tenant_id, user_id, role) values (t, auth.uid(), 'admin');
  return t;
end $$;

revoke execute on function public.module_active(uuid,text), public.billing_status(uuid), public.create_tenant(text,jsonb),
  public.can_read(uuid,text,text), public.can_write(uuid,text,text) from public, anon;
grant execute on function public.module_active(uuid,text), public.billing_status(uuid), public.create_tenant(text,jsonb),
  public.can_read(uuid,text,text), public.can_write(uuid,text,text) to authenticated;

-- Vlastná firma prevádzkovateľa bez platby (odkomentuj a doplň názov, ak chceš):
-- update public.tenants set complimentary = true where name = 'Kalimis s.r.o.';

select 'Doplnok 4 hotový' as stav;
