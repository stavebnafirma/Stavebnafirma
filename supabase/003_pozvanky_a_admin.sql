-- Stavebná firma – doplnok 3: meno v pozvánke, kto pozvánku prijal, správa administrátorov
-- Spustenie: SQL Editor → New query → vložiť → Run (dá sa spustiť aj opakovane)

alter table public.invites add column if not exists name text;
alter table public.invites add column if not exists accepted_by uuid references auth.users(id) on delete set null;

-- Administrátor smie spravovať všetkých členov (aj iných administrátorov),
-- správca (spravca) všetkých okrem administrátorov.
drop policy if exists members_admin on public.members;
create policy members_admin on public.members for all
  using (public.my_role(tenant_id) = 'admin' or (public.my_role(tenant_id) = 'spravca' and role <> 'admin'))
  with check (public.my_role(tenant_id) = 'admin' or (public.my_role(tenant_id) = 'spravca' and role <> 'admin'));

-- Pri prijatí pozvánky sa zapíše, kto ju prijal (aplikácia podľa toho priradí človeka na stavby).
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
    update public.invites set accepted_at = now(), accepted_by = auth.uid() where id = i.id;
    -- meno z pozvánky do profilu, ak ho ešte nemá
    if i.name is not null then
      update public.profiles set
        first_name = coalesce(first_name, split_part(i.name, ' ', 1)),
        last_name  = coalesce(last_name, nullif(substr(i.name, length(split_part(i.name, ' ', 1)) + 2), ''))
      where id = auth.uid();
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function public.accept_invites() from public, anon;
grant execute on function public.accept_invites() to authenticated;

-- Profil si používateľ smie aj vytvoriť (ak by chýbal), nie len upraviť.
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert with check (id = auth.uid());

select 'Doplnok 3 hotový' as stav;
