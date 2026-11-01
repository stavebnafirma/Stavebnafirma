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
