-- Zrušenie firmy a účtu: robí to serverová funkcia "account" (Edge Function so service_role).
-- Pri mazaní celej firmy nesmie ochrana ukončených stavieb (011) zablokovať vymazanie ich záznamov,
-- preto ju server (service_role) obchádza. Bežní používatelia ju neobídu.
-- Predpokladá spustené 001–011. Dá sa spustiť opakovane.

create or replace function public.guard_closed_project() returns trigger
language plpgsql security definer set search_path = public as $$
declare t uuid; p text;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
              nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role' then
    return case when tg_op = 'DELETE' then old else new end;   -- server (napr. zrušenie celej firmy)
  end if;
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
