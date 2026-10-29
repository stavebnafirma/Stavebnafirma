-- Vlastné nastavenie nástenky každého používateľa (ktoré udalosti chce vidieť).
-- Ukladá sa do profilu používateľa; profil si upravuje každý sám. Dá sa spustiť opakovane.
alter table public.profiles add column if not exists prefs jsonb;
