#!/usr/bin/env python3
"""Spojí každú Edge Function so spoločným súborom _shared/stripe.ts do jedného súboru
(supabase/functions-dist/<meno>.ts) – na nasadenie cez Supabase Dashboard alebo MCP."""
import pathlib,re
F=pathlib.Path(__file__).resolve().parent.parent/"supabase"/"functions"
out=F.parent/"functions-dist";out.mkdir(exist_ok=True)
shared=(F/"_shared"/"stripe.ts").read_text(encoding="utf-8")
for d in sorted(p for p in F.iterdir() if p.is_dir() and not p.name.startswith("_")):
    src=(d/"index.ts").read_text(encoding="utf-8")
    src=re.sub(r'^import \{[^}]*\} from "\.\./_shared/stripe\.ts";\n',"// ---- spoločné (_shared/stripe.ts) ----\n"+shared+"// ---- funkcia ----\n",src,flags=re.M)
    (out/f"{d.name}.ts").write_text(src,encoding="utf-8");print("ok",d.name)
