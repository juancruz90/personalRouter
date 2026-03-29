import json
import urllib.request

BASE = "http://127.0.0.1:8787/api/tickets?project=personal-provider"

BOARD_READY = [
    ("TASK-01", "Scaffold proyecto OCOM (TS + Fastify)", "critical"),
    ("TASK-02", "Schema SQLite + migración", "critical"),
    ("TASK-03", "TokenVault AES-256-GCM + tests", "critical"),
    ("TASK-04", "Seed: personal-provider + agentes", "high"),
    ("TASK-12", "Log sanitizer middleware (redacta tokens)", "critical"),
    ("TASK-17", "Bloqueo proyecto reel (locked=1)", "critical"),
    ("US-01", "OAuth PKCE inicio de flujo", "critical"),
    ("US-02", "OAuth callback + cifrado + storage", "critical"),
    ("US-03", "GET /accounts sin exponer tokens", "critical"),
    ("US-04", "Revocar cuenta (DELETE /accounts/:id)", "high"),
    ("US-05", "Refresh automático de tokens", "high"),
    ("US-06", "POST /assignments cuenta→agente", "critical"),
    ("US-07", "GET /agents/:slug/active-account", "critical"),
    ("US-08", "DELETE /assignments/:id", "high"),
    ("US-09", "Failover automático por health score", "critical"),
    ("TASK-13", "Audit log con HMAC-SHA256", "critical"),
    ("TASK-14", "Trigger SQLite append-only audit_log", "high"),
    ("TASK-15", "Middleware permisos por X-Agent-Slug", "high"),
    ("TASK-18", "Tests E2E happy path", "high"),
    ("TASK-10", "HealthService cron + scoring", "high"),
    ("TASK-11", "WebSocket /ws tiempo real", "high"),
    ("US-10", "Panel monitoreo en board.html", "high"),
    ("US-11", "Panel asignaciones en board.html", "medium"),
    ("TASK-23", "Alertas DEGRADED/FAILOVER", "medium"),
    ("TASK-19", "GET /audit-log con filtros", "medium"),
    ("TASK-20", "CLI ocom resolve <slug>", "medium"),
    ("TASK-16", "Backup diario 03:00 + checksums", "high"),
    ("TASK-21", "Restore desde backup", "medium"),
    ("TASK-22", "Documentación API + Runbook", "medium"),
    ("TASK-24", "Rotación master key (re-encrypt)", "low"),
]


def get_tickets():
    with urllib.request.urlopen(BASE, timeout=10) as r:
        return json.loads(r.read().decode("utf-8")).get("tickets", [])

existing = get_tickets()
existing_prefixes = set()
for t in existing:
    title = t.get("title", "")
    if " " in title:
        prefix = title.split(" ", 1)[0].strip()
        if "-" in prefix:
            existing_prefixes.add(prefix)

created = 0
for code, title, priority in BOARD_READY:
    if code in existing_prefixes:
        continue
    payload = {
        "title": f"{code} {title}",
        "description": f"Ticket importado desde definición board-ready ({code}). Ejecutar en modo single-agent (florencia) y ajustar luego si hace falta.",
        "priority": priority,
        "by": "florencia",
        "assignee": "florencia",
        "tags": ["personal-provider", "ocom", "single-agent", "import-board-ready"],
    }
    req = urllib.request.Request(
        BASE,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        if resp.status in (200, 201):
            created += 1

print(created)
print(len(get_tickets()))
