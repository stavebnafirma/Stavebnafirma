-- =====================================================================
--  Stavebná firma – databáza pre Supabase
--  Spustenie: Supabase → SQL Editor → New query → vložiť celý súbor → Run
--  Skript je možné spustiť opakovane (nič existujúce nezmaže).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Firmy (nájomcovia aplikácie). Každá registrovaná firma = 1 riadok.
-- ---------------------------------------------------------------------
create table if not exists public.tenants (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  modules     jsonb not null default '{"personal":true,"doprava":true,"pozicovna":true,"stavba":true}',
  created_at  timestamptz not null default now()
);

-- Profil používateľa (meno, telefón, pečiatka). Vzniká automaticky pri registrácii.
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  first_name  text,
  last_name   text,
  phone       text,
  stamp       jsonb,
  updated_at  timestamptz not null default now()
);

-- Členstvo používateľa vo firme a jeho práva.
--   role:     admin (majiteľ účtu), spravca (všetko), clen (podľa rights), dozor (externý, len svoje stavby)
--   rights:   {"personal":"view|edit","doprava":"view|edit","pozicovna":"view|edit","stavba":"view|edit"}
--   projects: id stavieb, na ktoré má prístup (tím stavby, stavebný dozor)
create table if not exists public.members (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'clen' check (role in ('admin','spravca','clen','dozor')),
  rights      jsonb not null default '{}',
  projects    text[] not null default '{}',
  created_at  timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index if not exists members_user_idx on public.members(user_id);

-- Pozvánky: pozvaný sa zaregistruje s týmto e-mailom a automaticky sa pridá do firmy.
create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  email       text not null,
  role        text not null default 'clen' check (role in ('spravca','clen','dozor')),
  rights      jsonb not null default '{}',
  projects    text[] not null default '{}',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  accepted_at timestamptz
);
create index if not exists invites_email_idx on public.invites(lower(email));

-- Údaje aplikácie. Každá položka (zamestnanec, stroj, úloha, váženie, výpožička, stavba…) = 1 riadok.
--   kind:       druh údaju (workers, machines, jobs, weighs, projects, diary, rentals, meta …)
--   project_id: pri údajoch stavby – kvôli prístupu tímu stavby a dozoru
create table if not exists public.docs (
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  kind        text not null,
  id          text not null,
  project_id  text,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid(),
  primary key (tenant_id, kind, id)
);
create index if not exists docs_kind_idx on public.docs(tenant_id, kind);
create index if not exists docs_project_idx on public.docs(tenant_id, project_id) where project_id is not null;

-- ---------------------------------------------------------------------
-- Pomocné funkcie pre prístupové práva
-- ---------------------------------------------------------------------

-- Do ktorého modulu patrí daný druh údajov ('firma' = základ, vidí každý zamestnanec firmy).
create or replace function public.kind_module(k text) returns text
language sql immutable as $$
  select case
    when k in ('att','trips','trainings')       then 'personal'
    when k in ('jobs','weighs','teams')         then 'doprava'
    when k in ('rentItems','rentals')           then 'pozicovna'
    when k in ('projects','diary')              then 'stavba'
    else 'firma'
  end
$$;

-- Moje členstvo vo firme (security definer, aby pravidlá nevolali samé seba).
create or replace function public.my_role(t uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where tenant_id = t and user_id = auth.uid()
$$;
create or replace function public.my_rights(t uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(rights, '{}'::jsonb) from public.members where tenant_id = t and user_id = auth.uid()
$$;
create or replace function public.my_projects(t uuid) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(projects, '{}') from public.members where tenant_id = t and user_id = auth.uid()
$$;
create or replace function public.is_manager(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.my_role(t) in ('admin','spravca'), false)
$$;

-- Bezpečný prevod textu na uuid (pri neplatnom texte vráti null).
create or replace function public.try_uuid(x text) returns uuid
language plpgsql immutable as $$ begin return x::uuid; exception when others then return null; end $$;

-- Smie čítať riadok?
create or replace function public.can_read(t uuid, k text, p text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare r text := public.my_role(t); m text := public.kind_module(k);
begin
  if r is null then return false; end if;
  if r in ('admin','spravca') then return true; end if;
  if r = 'dozor' then
    return (p is not null and p = any(public.my_projects(t))) or (k = 'meta' );
  end if;
  -- člen firmy
  if m = 'firma' then return true; end if;
  if m = 'stavba' and p is not null and p = any(public.my_projects(t)) then return true; end if;
  return coalesce(public.my_rights(t) ->> m, '') in ('view','edit');
end $$;

-- Smie zapisovať (pridať, upraviť, zmazať) riadok?
create or replace function public.can_write(t uuid, k text, p text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare r text := public.my_role(t); m text := public.kind_module(k); rt jsonb := public.my_rights(t);
begin
  if r is null then return false; end if;
  if r in ('admin','spravca') then return true; end if;
  if r = 'dozor' then
    return k in ('projects','diary') and p is not null and p = any(public.my_projects(t));
  end if;
  if k = 'tasks' then return true; end if;                       -- úlohy si plní každý člen
  if k = 'workers' then return rt ->> 'personal' = 'edit'; end if;
  if k = 'machines' then return rt ->> 'doprava' = 'edit'; end if;
  if m = 'firma' then return false; end if;                      -- údaje firmy mení len správca
  if m = 'stavba' and p is not null and p = any(public.my_projects(t)) then return true; end if;
  return rt ->> m = 'edit';
end $$;

-- ---------------------------------------------------------------------
-- Pravidlá prístupu (Row Level Security)
-- ---------------------------------------------------------------------
alter table public.tenants  enable row level security;
alter table public.profiles enable row level security;
alter table public.members  enable row level security;
alter table public.invites  enable row level security;
alter table public.docs     enable row level security;

drop policy if exists tenants_read   on public.tenants;
drop policy if exists tenants_update on public.tenants;
create policy tenants_read   on public.tenants for select using (public.my_role(id) is not null);
create policy tenants_update on public.tenants for update using (public.my_role(id) = 'admin') with check (public.my_role(id) = 'admin');

drop policy if exists profiles_read  on public.profiles;
drop policy if exists profiles_write on public.profiles;
-- profil vidím svoj a profily ľudí z mojich firiem
create policy profiles_read on public.profiles for select using (
  id = auth.uid() or exists (
    select 1 from public.members a join public.members b on a.tenant_id = b.tenant_id
    where a.user_id = auth.uid() and b.user_id = profiles.id));
create policy profiles_write on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists members_read  on public.members;
drop policy if exists members_admin on public.members;
create policy members_read  on public.members for select using (public.my_role(tenant_id) is not null);
create policy members_admin on public.members for all
  using (public.is_manager(tenant_id) and role <> 'admin')
  with check (public.is_manager(tenant_id) and role <> 'admin');

drop policy if exists invites_read  on public.invites;
drop policy if exists invites_admin on public.invites;
create policy invites_read  on public.invites for select using (public.is_manager(tenant_id) or lower(email) = lower(auth.jwt() ->> 'email'));
create policy invites_admin on public.invites for all using (public.is_manager(tenant_id)) with check (public.is_manager(tenant_id));

drop policy if exists docs_read   on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;
create policy docs_read   on public.docs for select using (public.can_read(tenant_id, kind, project_id));
create policy docs_insert on public.docs for insert with check (public.can_write(tenant_id, kind, project_id));
create policy docs_update on public.docs for update using (public.can_write(tenant_id, kind, project_id)) with check (public.can_write(tenant_id, kind, project_id));
create policy docs_delete on public.docs for delete using (public.can_write(tenant_id, kind, project_id));

-- ---------------------------------------------------------------------
-- Automatika
-- ---------------------------------------------------------------------

-- Čas a autor poslednej zmeny riadku.
create or replace function public.touch_doc() returns trigger language plpgsql as $$
begin new.updated_at := now(); new.updated_by := auth.uid(); return new; end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs for each row execute function public.touch_doc();

-- Pri registrácii sa založí profil.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Založenie novej firmy: prihlásený používateľ sa stane jej adminom.
create or replace function public.create_tenant(p_name text, p_modules jsonb default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  if auth.uid() is null then raise exception 'Nie si prihlásený'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Chýba názov firmy'; end if;
  insert into public.tenants(name, modules)
    values (trim(p_name), coalesce(p_modules, '{"personal":true,"doprava":true,"pozicovna":true,"stavba":true}'))
    returning id into t;
  insert into public.members(tenant_id, user_id, role) values (t, auth.uid(), 'admin');
  return t;
end $$;

-- Prijatie pozvánok: po prihlásení sa používateľ pridá do firiem, kam bol pozvaný na svoj e-mail.
create or replace function public.accept_invites() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; i record; em text := lower(auth.jwt() ->> 'email');
begin
  if auth.uid() is null or em is null then return 0; end if;
  for i in select * from public.invites where lower(email) = em and accepted_at is null loop
    insert into public.members(tenant_id, user_id, role, rights, projects)
      values (i.tenant_id, auth.uid(), i.role, i.rights, i.projects)
      on conflict (tenant_id, user_id) do update
        set projects = (select array(select distinct unnest(public.members.projects || excluded.projects))),
            rights   = public.members.rights || excluded.rights;
    update public.invites set accepted_at = now() where id = i.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Zoznam ľudí vo firme s ich profilom (pre správu používateľov).
create or replace function public.tenant_people(t uuid) returns table(
  user_id uuid, email text, first_name text, last_name text, phone text, role text, rights jsonb, projects text[])
language sql stable security definer set search_path = public as $$
  select m.user_id, p.email, p.first_name, p.last_name, p.phone, m.role, m.rights, m.projects
  from public.members m left join public.profiles p on p.id = m.user_id
  where m.tenant_id = t and public.my_role(t) is not null
$$;

grant execute on function public.create_tenant(text, jsonb) to authenticated;
grant execute on function public.accept_invites() to authenticated;
grant execute on function public.tenant_people(uuid) to authenticated;

-- Živé zmeny (keď niekto iný uloží, ostatným sa údaje obnovia).
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when others then null; end $$;

-- ---------------------------------------------------------------------
-- Úložisko súborov (fotky, OEV II, logá, pečiatky). Cesta: <id firmy>/...
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public) values ('files', 'files', false) on conflict (id) do nothing;

drop policy if exists files_read  on storage.objects;
drop policy if exists files_write on storage.objects;
drop policy if exists files_del   on storage.objects;
create policy files_read on storage.objects for select using (
  bucket_id = 'files' and public.my_role(public.try_uuid((storage.foldername(name))[1])) is not null);
create policy files_write on storage.objects for insert with check (
  bucket_id = 'files' and public.my_role(public.try_uuid((storage.foldername(name))[1])) is not null);
create policy files_del on storage.objects for delete using (
  bucket_id = 'files' and public.my_role(public.try_uuid((storage.foldername(name))[1])) is not null);

-- Hotovo.
select 'Databáza Stavebná firma je pripravená' as stav;
