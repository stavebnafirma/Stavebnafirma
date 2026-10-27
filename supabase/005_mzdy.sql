-- Podklady pre mzdy: mzdové údaje zamestnancov (payProf) a mesačné doplnenia (payMon) patria do modulu Personalistika,
-- takže ich vidí len ten, kto má prístup k Personalistike (nie každý člen firmy). Dá sa spustiť opakovane.
create or replace function public.kind_module(k text) returns text
language sql immutable set search_path = public as $$
  select case
    when k in ('att','trips','trainings','payProf','payMon') then 'personal'
    when k in ('jobs','weighs','teams')         then 'doprava'
    when k in ('rentItems','rentals')           then 'pozicovna'
    when k in ('projects','diary')              then 'stavba'
    else 'firma'
  end
$$;
