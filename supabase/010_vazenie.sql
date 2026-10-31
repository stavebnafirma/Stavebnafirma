-- Váženie: zapamätaní prepravcovia (kind 'carriers') a počiatočné stavy skladu (kind 'wInit') patria do modulu Doprava,
-- aby ich mohol zapisovať každý, kto smie upravovať Dopravu (nielen administrátor). Dá sa spustiť opakovane.
create or replace function public.kind_module(k text) returns text
language sql immutable set search_path = public as $$
  select case
    when k in ('att','trips','trainings','payProf','payMon') then 'personal'
    when k in ('jobs','weighs','teams','gpsPlaces','carriers','wInit') then 'doprava'
    when k in ('rentItems','rentals')           then 'pozicovna'
    when k in ('projects','diary','costs')      then 'stavba'
    else 'firma'
  end
$$;
