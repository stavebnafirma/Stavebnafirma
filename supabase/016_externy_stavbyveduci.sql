-- 016 – Externý stavbyvedúci (napr. stavbyvedúci objednávateľa) – dá sa spustiť opakovane
-- V databáze je to externý člen firmy s rolou „dozor“ (vidí a zapisuje len do stavieb, na ktoré je pozvaný).
-- Na stavbe má v tíme rolu „extsv“: smie nahrávať dokumenty, mazať však len tie, ktoré sám nahral.

create or replace function public.doc_can_upload(t uuid, p text)
 returns boolean language plpgsql stable security definer set search_path to 'public' as $$
declare r text := public.my_role(t);
begin
  if r is null or p is null then return false; end if;
  if not public.module_active(t, 'stavba') then return false; end if;
  if r in ('admin','spravca') then return true; end if;
  if r = 'dozor' and not (p = any(public.my_projects(t))) then return false; end if;
  if r <> 'dozor' and coalesce(public.my_rights(t) ->> 'stavba', '') = 'edit' then return true; end if;
  return exists (
    select 1 from public.docs d, jsonb_array_elements(coalesce(d.data -> 'members', '[]'::jsonb)) m
    where d.tenant_id = t and d.kind = 'projects' and d.id = p
      and m ->> 'userId' = auth.uid()::text and m ->> 'role' in ('stavbyveduci', 'extsv'));
end $$;

-- mazanie súborov stavby: externý člen (rola „dozor“) iba vlastné súbory
drop policy if exists dokumentacia_mazanie on storage.objects;
create policy dokumentacia_mazanie on storage.objects for delete to authenticated using (
  bucket_id = 'dokumentacia' and
  case
    when (storage.foldername(name))[2] = 'naklady' then
      public.can_write(public.try_uuid((storage.foldername(name))[1]), 'costs', null)
      and ((not public.proj_closed(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[3]))
           or coalesce(public.my_role(public.try_uuid((storage.foldername(name))[1])), '') in ('admin','spravca'))
    else
      public.doc_can_upload(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[2])
      and ((not public.proj_closed(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[2]))
           or coalesce(public.my_role(public.try_uuid((storage.foldername(name))[1])), '') in ('admin','spravca'))
      and (coalesce(public.my_role(public.try_uuid((storage.foldername(name))[1])), '') <> 'dozor' or owner_id = auth.uid()::text)
  end);
