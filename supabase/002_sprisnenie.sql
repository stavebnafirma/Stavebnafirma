-- Stavebná firma – doplnok 2: sprísnenie podľa bezpečnostnej kontroly Supabase
-- Spustenie: SQL Editor → New query → vložiť → Run (dá sa spustiť aj opakovane)

-- 1) pevná search_path aj pri pomocných funkciách
alter function public.touch_doc()          set search_path = public;
alter function public.kind_module(text)    set search_path = public;
alter function public.try_uuid(text)       set search_path = public;

-- 2) funkcie nesmie volať neprihlásený návštevník (anon) ani ktokoľvek cez PUBLIC
revoke execute on function public.my_role(uuid), public.my_rights(uuid), public.my_projects(uuid), public.is_manager(uuid),
  public.can_read(uuid,text,text), public.can_write(uuid,text,text), public.create_tenant(text,jsonb),
  public.accept_invites(), public.tenant_people(uuid), public.handle_new_user(), public.try_uuid(text), public.kind_module(text)
  from public, anon;

-- 3) prihlásení používatelia potrebujú pomocné funkcie (používajú ich pravidlá prístupu) a tri akcie aplikácie
grant execute on function public.my_role(uuid), public.my_rights(uuid), public.my_projects(uuid), public.is_manager(uuid),
  public.can_read(uuid,text,text), public.can_write(uuid,text,text), public.try_uuid(text), public.kind_module(text),
  public.create_tenant(text,jsonb), public.accept_invites(), public.tenant_people(uuid)
  to authenticated;

-- 4) funkciu pre registráciu volá len databáza sama (trigger), nikto cez API
revoke execute on function public.handle_new_user() from authenticated;

select 'Sprísnenie hotové' as stav;
