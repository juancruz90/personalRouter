from pathlib import Path
import json

p = Path(r"C:\Users\juanc\.openclaw\workspace\orquestacion\project_hub\tickets.json")
s = p.read_text(encoding="utf-8")

in_str = False
esc = False
depth = 0
end = None
started = False

for i, ch in enumerate(s):
    if not started:
        if ch.isspace():
            continue
        if ch == "{":
            started = True
            depth = 1
        else:
            raise SystemExit("not object start")
        continue

    if in_str:
        if esc:
            esc = False
        elif ch == "\\":
            esc = True
        elif ch == '"':
            in_str = False
        continue

    if ch == '"':
        in_str = True
    elif ch == "{":
        depth += 1
    elif ch == "}":
        depth -= 1
        if depth == 0:
            end = i + 1
            break

if end is None:
    raise SystemExit("no end found")

fixed = s[:end] + "\n"
obj = json.loads(fixed)
p.write_text(fixed, encoding="utf-8")
print(f"fixed {len(s)} -> {len(fixed)} | tickets={len(obj.get('tickets', []))} events={len(obj.get('events', []))}")
