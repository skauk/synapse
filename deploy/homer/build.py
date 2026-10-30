#!/usr/bin/env python3
"""Generate deploy/homer/docker-compose.yml: inline the scripts next to this file as compose `configs`.
Compose interpolates $VAR in inline content, so every $ in the inlined files is escaped as $$."""
import pathlib

src = pathlib.Path(__file__).resolve().parent
out = (src / "compose.template.yml").read_text()
for key, name in [("matrix-init", "matrix-init.sh"), ("element-config", "element-config.json"), ("seed", "seed.mjs")]:
    body = (src / name).read_text().replace("$", "$$").rstrip("\n")
    indented = "\n".join(("      " + line) if line else "" for line in body.split("\n"))
    out = out.replace(f"@@{key}@@", indented)
(src / "docker-compose.yml").write_text(out)
print("wrote deploy/homer/docker-compose.yml")
