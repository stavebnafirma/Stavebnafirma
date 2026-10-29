-- Ponuka strojov: stroje, ktoré firma označí „Stroj v ponuke“, vidia všetci prihlásení používatelia aplikácie.
-- Riadok = jeden stroj firmy (kópia údajov na zobrazenie: názov, fotka, ceny, kontakt, miesto).
-- Zapisovať môže len ten, kto môže upravovať stroje danej firmy. Dá sa spustiť opakovane.
create table if not exists public.offers (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id)
);
alter table public.offers enable row level security;
drop policy if exists offers_read   on public.offers;
drop policy if exists offers_insert on public.offers;
drop policy if exists offers_update on public.offers;
drop policy if exists offers_delete on public.offers;
create policy offers_read   on public.offers for select to authenticated using (true);
create policy offers_insert on public.offers for insert to authenticated with check (public.can_write(tenant_id, 'machines', null));
create policy offers_update on public.offers for update to authenticated using (public.can_write(tenant_id, 'machines', null)) with check (public.can_write(tenant_id, 'machines', null));
create policy offers_delete on public.offers for delete to authenticated using (public.can_write(tenant_id, 'machines', null));
grant select, insert, update, delete on public.offers to authenticated;
