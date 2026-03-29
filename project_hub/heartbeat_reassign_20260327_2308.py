import json
from pathlib import Path
from datetime import datetime, timezone

path = Path('project_hub/tickets.personal-provider.json')
raw = path.read_text(encoding='utf-8-sig')
db = json.loads(raw)

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def add_comment(t, text, by='florencia'):
    t.setdefault('comments', [])
    t['comments'].append({'ts': now_iso(), 'by': by, 'text': text})

by_id = {t['id']: t for t in db['tickets']}

# Critical flow ownership for throughput
if 199 in by_id:
    t = by_id[199]
    t['assignee'] = 'hykar'
    t['status'] = 'in_progress'
    t['updated_at'] = now_iso()
    add_comment(t, 'HEARTBEAT START: owner=hykar. Motivo: scope de estabilidad/rate-limit classifier. Siguiente paso verificable: mapear insufficient_quota + "You exceeded your current quota" a failover-eligible=true y subir diff + test unitario.')

if 203 in by_id:
    t = by_id[203]
    t['assignee'] = 'juan-cruz'
    t['status'] = 'in_progress'
    t['updated_at'] = now_iso()
    add_comment(t, 'HEARTBEAT START: owner=juan-cruz. Motivo: implementación core OAuth/JWT. Siguiente paso verificable: extraer claim email del JWT en writeOAuthCredentials y generar profile_id openai-codex:<email> con fallback default-N.')

if 200 in by_id:
    t = by_id[200]
    t['assignee'] = 'juan-cruz'
    t['status'] = 'todo'
    t['updated_at'] = now_iso()
    add_comment(t, 'HANDOFF DEPENDENCIA: queda en cola para juan-cruz tras #199. Motivo: requiere señal failover-eligible de A01. Siguiente paso verificable: implementar rotación auth.order por profile con cooldown provider:profile-id antes de model.fallbacks.')

if 211 in by_id:
    t = by_id[211]
    t['assignee'] = 'carbon'
    t['status'] = 'todo'
    t['updated_at'] = now_iso()
    add_comment(t, 'HEARTBEAT PLAN: owner=carbon para diseño/QA UI dashboard de cuentas. Siguiente paso verificable: definir columnas/badges + flujo Verify now y criterios de UX con payload de /api/auth/profiles/status.')

if 121 in by_id:
    t = by_id[121]
    t['assignee'] = 'florencia'
    t['updated_at'] = now_iso()
    add_comment(t, 'HEARTBEAT CHECK: ticket directivo sigue owner=florencia para coordinación. Próximo paso verificable: consolidar plan de ejecución CLW y reporte de hitos por ticket.')

path.write_text(json.dumps(db, ensure_ascii=False, indent=4), encoding='utf-8')
print('updated tickets: 121,199,200,203,211')
