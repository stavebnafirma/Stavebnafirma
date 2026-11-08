-- 018 – Projektant, geodet a štátny stavebný dohľad na stavbe – dá sa spustiť opakovane
-- V databáze sú to externí členovia firmy s rolou „dozor“ (vidia len stavby, na ktoré sú pozvaní).
-- Na stavbe majú v tíme rolu „projektant“, „geodet“ alebo „ssd“ s rovnakými právami ako externý stavbyvedúci:
-- vlastné denné záznamy, nahrávanie dokumentov, mazanie len vlastných súborov.

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
      and m ->> 'userId' = auth.uid()::text and m ->> 'role' in ('stavbyveduci', 'extsv', 'projektant', 'geodet', 'ssd'));
end $$;
