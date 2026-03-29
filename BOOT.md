# BOOT.md — Startup checklist for personal-provider

Objetivo: asegurar que los servicios custom de OCOM queden arriba cada vez que inicia el Gateway.

## Servicios críticos a validar

1. OCOM HTTP server (`:3001`)
2. OAuth callback bridge (se inicializa dentro de OCOM)
3. Project Hub Board server (`:8787`)

## Pasos (determinísticos)

1. Verificar health de OCOM:
   - URL: `http://127.0.0.1:3001/health`
2. Si no responde, iniciar OCOM con entrypoint absoluto:
   - `node C:/Users/juanc/.openclaw/workspace/orquestacion/dist/server.js`
3. Esperar 2-4 segundos y revalidar OCOM:
   - `http://127.0.0.1:3001/health` debe devolver `healthy: true`
   - `http://127.0.0.1:3001/ui/accounts` debe responder `200`
   - `http://127.0.0.1:3001/accounts/wham/usage?provider=openai-codex` debe responder `200`
   - `http://127.0.0.1:3001/assignments` debe responder `200`
4. Verificar Board de Project Hub:
   - URL: `http://127.0.0.1:8787/board`
5. Si no responde, iniciar Board con entrypoint absoluto:
   - `python C:/Users/juanc/.openclaw/workspace/orquestacion/project_hub/server.py`
6. Esperar 2-4 segundos y revalidar Board:
   - `http://127.0.0.1:8787/board` debe responder `200`
   - `http://127.0.0.1:8787/api/tickets?project=personal-provider` debe responder `200`
7. Si falla cualquier validación, reportar error con causa concreta (puerto ocupado, excepción de arranque, etc.) y no asumir éxito.

## Notas

- No arrancar múltiples instancias en paralelo.
- Priorizar idempotencia: si ya está saludable, no reiniciar.
- Este boot es solo para entorno local Windows del workspace `orquestacion`.
- Referencia funcional para agentes: `CUSTOM_FLOW.md`.
- Trigger de arranque: este BOOT.md se ejecuta automáticamente al iniciar Gateway vía hook interno `boot-md` (enabled=true).
