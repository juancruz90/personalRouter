import json
from pathlib import Path
from datetime import datetime, timezone

path = Path('project_hub/tickets.personal-provider.json')
raw = path.read_text(encoding='utf-8-sig')
db = json.loads(raw)

def now_iso():
    return datetime.now(timezone.utc).isoformat()

spec = [
    ('CLW-A01','critical','Classify openai-codex quota 429 (insufficient_quota / "You exceeded your current quota") as failover-eligible.'),
    ('CLW-A02','critical','Implement auth-profile rotation for openai-codex on quota exhaustion before model fallback chain.'),
    ('CLW-A03','high','Fix cooldown scope to provider:profile-id (avoid full-provider cooldown on per-profile 429).'),
    ('CLW-A04','high','Show fallback candidate chain in session start logs/messages.'),
    ('CLW-B01','critical','Extract email from OAuth JWT and use it in profile IDs (openai-codex:user@example.com).'),
    ('CLW-B02','high','Fix Team/Business deduplication: dedupe by email/chatgpt_user_id, not shared accountId.'),
    ('CLW-B03','high','Persist auth profile metadata to DB (profile/email/account/token hash/encrypted refresh/quota/health timestamps).'),
    ('CLW-B04','medium','Prevent models status from overwriting newer creds with stale Codex CLI tokens.'),
    ('CLW-B05','high','Fix OAuth refresh persistence: write new tokens atomically and verify post-write.'),
    ('CLW-C01','high','Build lightweight account verification probe for openai-codex OAuth accounts.'),
    ('CLW-C02','high','Schedule periodic verification for all registered accounts (default every 30m).'),
    ('CLW-C03','high','Expose authenticated API endpoint: GET /api/auth/profiles/status.'),
    ('CLW-C04','high','Build Control UI account health dashboard + verify-now action + auto-refresh.'),
    ('CLW-C05','medium','Support multi-team/custom alias during account registration and in dashboard.'),
    ('CLW-D01','medium','Separate openai-api-key vs openai-codex OAuth in onboarding UX with actionable validation.'),
    ('CLW-D02','medium','Update docs/examples to include openai-codex/gpt-5.3 guidance and OAuth/API distinctions.'),
]

existing_titles = {t.get('title','') for t in db.get('tickets',[])}
next_id = int(db.get('next_id', 1))
created = 0
for key, prio, desc in spec:
    title = f'[{key}] Claude solution - {desc.split(".")[0]}'
    if any(key in t for t in existing_titles):
        continue
    ts = now_iso()
    ticket = {
        'id': next_id,
        'title': title,
        'description': desc,
        'priority': prio,
        'status': 'todo',
        'created_at': ts,
        'updated_at': ts,
        'created_by': 'florencia',
        'assignee': 'florencia',
        'tags': ['personal-provider','claude-solution','openai-codex','oauth'],
        'comments': [],
        'resolution': None,
    }
    db['tickets'].append(ticket)
    existing_titles.add(title)
    next_id += 1
    created += 1

db['next_id'] = next_id
path.write_text(json.dumps(db, ensure_ascii=False, indent=4), encoding='utf-8')
print(f'created={created} next_id={next_id}')
