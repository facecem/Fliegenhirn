"""
build_app.py — bäckt brain.json in app.src.html ein und schreibt die
fertige, doppelklickbare index.html (funktioniert von file://).
"""
import json, pathlib

root = pathlib.Path(__file__).parent
brain = json.loads((root / "brain.json").read_text(encoding="utf-8"))
tpl = (root / "app.src.html").read_text(encoding="utf-8")

# kompakt einbetten (JSON ist gültiges JS-Literal)
payload = json.dumps(brain, ensure_ascii=False, separators=(",", ":"))
assert "</script" not in payload, "Sicherheits-Check: kein </script> im Daten-Payload"

out = tpl.replace("__BRAIN_JSON__", payload)
(root / "index.html").write_text(out, encoding="utf-8")
kb = len((root / "index.html").read_bytes()) / 1024
print(f"OK -> index.html ({kb:.0f} KB, {brain['meta']['regions']} Regionen, "
      f"{brain['meta']['edges']} Kanten eingebettet)")
