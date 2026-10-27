-- Dokumentácia stavby (výkresy): súkromný priečinok v Storage "dokumentacia".
-- Cesta súboru: <tenant_id>/<id stavby>/<súbor>. Čítať môže každý, kto vidí stavbu (can_read),
-- nahrávať a mazať administrátor, správca, používateľ s právom upravovať Stavbu alebo stavbyvedúci danej stavby.
-- Dá sa spustiť opakovane.
insert into storage.buckets (id, name, public, file_size_limit)
values ('dokumentacia', 'dokumentacia', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create or replace function public.doc_can_upload(t uuid, p text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare r text := public.my_role(t);
begin
  if r is null or p is null then return false; end if;
  if not public.module_active(t, 'stavba') then return false; end if;
  if r in ('admin','spravca') then return true; end if;
  if coalesce(public.my_rights(t) ->> 'stavba', '') = 'edit' then return true; end if;
  return exists (
    select 1 from public.docs d, jsonb_array_elements(coalesce(d.data -> 'members', '[]'::jsonb)) m
    where d.tenant_id = t and d.kind = 'projects' and d.id = p
      and m ->> 'userId' = auth.uid()::text and m ->> 'role' = 'stavbyveduci');
end $$;
revoke execute on function public.doc_can_upload(uuid, text) from public, anon;
grant execute on function public.doc_can_upload(uuid, text) to authenticated;

drop policy if exists "dokumentacia_citanie" on storage.objects;
create policy "dokumentacia_citanie" on storage.objects for select to authenticated
  using (bucket_id = 'dokumentacia'
    and public.can_read(public.try_uuid((storage.foldername(name))[1]), 'projects', (storage.foldername(name))[2]));

drop policy if exists "dokumentacia_nahranie" on storage.objects;
create policy "dokumentacia_nahranie" on storage.objects for insert to authenticated
  with check (bucket_id = 'dokumentacia'
    and public.doc_can_upload(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[2]));

drop policy if exists "dokumentacia_mazanie" on storage.objects;
create policy "dokumentacia_mazanie" on storage.objects for delete to authenticated
  using (bucket_id = 'dokumentacia'
    and public.doc_can_upload(public.try_uuid((storage.foldername(name))[1]), (storage.foldername(name))[2]));
