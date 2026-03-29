import json
import urllib.request

BASE = "http://127.0.0.1:8787/api/tickets?project=personal-provider"

TICKETS = [
    ("[F0] Scaffold OCOM (TS + Fastify)", "critical", "Crear base del servicio OCOM con scripts dev/build/start. AC: server en :3001 estable."),
    ("[F0] SQLite schema + migraciones", "critical", "Crear tablas core (projects, agents, accounts, assignments, metrics_events, audit_log)."),
    ("[F0] TokenVault AES-256-GCM + tests", "critical", "Cifrado/descifrado de access/refresh tokens con master key por env var."),
    ("[F0] Seed de personal-provider + agentes base", "high", "Seed de datos iniciales y slugs de agentes; operación actual single-agent."),
    ("[F0] Sanitización de logs (redact tokens)", "critical", "Middleware para evitar exposición de secretos en logs."),
    ("[F0] Lock de proyecto reel (read-only)", "critical", "Forzar bloqueo de escritura sobre proyecto reel."),
    ("[F1] OAuth PKCE start + callback", "critical", "Implementar flujo completo de alta de cuenta OAuth (start/callback/exchange/store)."),
    ("[F1] API cuentas (listar/revocar/estado)", "critical", "Endpoints de cuentas sin exponer secretos; estado y health."),
    ("[F1] Asignaciones cuenta↔agente + prioridad", "critical", "CRUD de assignments con prioridad y modo."),
    ("[F1] RouterService + failover automático", "critical", "Resolver cuenta activa y failover por health score/errores."),
    ("[F1] Refresh automático de tokens", "high", "Refresh preventivo de tokens próximos a expirar."),
    ("[F1] Audit log HMAC append-only", "critical", "Registro inmutable de cambios sensibles con hash HMAC."),
    ("[F2] HealthService (cron + scoring)", "high", "Probes periódicos y cálculo de health por cuenta."),
    ("[F2] WebSocket de eventos tiempo real", "high", "Publicar account_status_changed/failover/assignment_changed."),
    ("[F2] Panel board: monitoreo + alertas", "high", "Vista en board de estado de cuentas y alertas DEGRADED/FAILOVER."),
    ("[F2] Panel board: edición de asignaciones", "medium", "UI para editar asignaciones y prioridad de fallback."),
    ("[F3] Backup diario + restore", "high", "Backups con checksums y procedimiento de restore validado."),
    ("[F3] Runbook + API docs", "medium", "Documentación operativa y de endpoints para operación diaria."),
    ("[MEJORA] Modo single-agent explícito", "high", "Operación temporal con owner único florencia para evitar bloqueos."),
    ("[MEJORA] Importador de tickets desde spec HTML", "medium", "Script para crear/actualizar backlog desde openclaw-codex-oauth-project.html."),
]

created = 0
for title, priority, description in TICKETS:
    payload = {
        "title": title,
        "description": description,
        "priority": priority,
        "by": "florencia",
        "assignee": "florencia",
        "tags": ["personal-provider", "ocom", "single-agent"],
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
