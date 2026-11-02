-- 015 – sprísnenie zabezpečenia (dá sa spustiť opakovane)
-- 1) interné tabuľky: z API sa k nim nedostane nikto okrem servera (už teraz ich chráni RLS bez pravidiel, toto je druhá poistka)
revoke all on public.app_secrets, public.mail_log, public.platform_admins from anon, authenticated;
-- 2) TRUNCATE obchádza RLS – klienti ho nepotrebujú
revoke truncate on all tables in schema public from anon, authenticated;
-- 3) neprihlásený návštevník nemá čo meniť ani čítať priamo v tabuľkách (všetko ide cez prihlásenie)
revoke insert, update, delete on all tables in schema public from anon;
-- 4) funkcie triggerov sa nedajú volať cez API
revoke execute on function public.guard_closed_project() from public, anon, authenticated;
revoke execute on function public.touch_doc() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.cron_key_ok(text) from public, anon, authenticated;
revoke execute on function public.notify_people(uuid) from public, anon, authenticated;
revoke execute on function public.notify_email_known(uuid, text) from public, anon, authenticated;

-- 5) pozvánky: rolu administrátora smie pozvať iba administrátor (správca stavieb si nemôže cez pozvánku zvýšiť práva)
drop policy if exists invites_admin on public.invites;
create policy invites_admin on public.invites for all
  using (public.is_manager(tenant_id))
  with check (public.is_manager(tenant_id) and (role is distinct from 'admin' or public.my_role(tenant_id) = 'admin'));

-- 6) e-mail v profile vždy podľa prihlasovacieho účtu (nedá sa podvrhnúť cudzí e-mail)
create or replace function public.profile_email_sync() returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.email := (select u.email from auth.users u where u.id = new.id);
  return new;
end $$;
revoke execute on function public.profile_email_sync() from public, anon, authenticated;
drop trigger if exists profile_email_sync on public.profiles;
create trigger profile_email_sync before insert or update on public.profiles for each row execute function public.profile_email_sync();

-- 7) nepoužívaný bucket „files“: bez prístupu z aplikácie (súbory sú v buckete „dokumentacia“ s presnými pravidlami)
drop policy if exists files_read on storage.objects;
drop policy if exists files_write on storage.objects;
drop policy if exists files_del on storage.objects;
