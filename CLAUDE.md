# Stavebná firma – pokyny pre úpravy

- Aplikácia je jedna stránka `web/index.html`. **Needituj ju priamo** – vzniká skriptom `python3 build/build.py` z:
  - `build/prototype.html` – celé rozhranie a logika (rovnaký súbor ako prototyp v Claude artefakte),
  - `build/live.js` – vrstva pre Supabase (prihlásenie, načítanie a ukladanie údajov, pozvánky, sťahovanie súborov).
- Údaje: tabuľka `docs` (každá položka = 1 riadok, `kind` = názov poľa v stave `S`), používatelia v `members` / `invites` / `profiles`.
  Prístupové práva sú v databáze (RLS) – `supabase/0*.sql`, spúšťajú sa v poradí v Supabase → SQL Editor.
- Nová migrácia = nový súbor `supabase/00X_nazov.sql`, ktorý sa dá spustiť opakovane.
- Texty pre používateľov sú po slovensky.
- Po zmene vždy: `python3 build/build.py`, otestovať, commit a push do `main` (Netlify nasadí automaticky).
