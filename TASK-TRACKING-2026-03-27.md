# TRACKING: Reforma y priorización de tickets personal-provider

**Fecha:** 2026-03-27
**Autor:** florencia (agente main)
**Estado:** Completado

---

## Resumen ejecutivo

Se realizó una limpieza y re-priorización del backlog del proyecto `personal-provider`, aplicando el criterio:
- **MVP** → `critical` (se mantuvieron existentes)
- **Resto** → `high` → `medium` → `low` (según urgencia operativa)
- Tickets `in_progress` inactivos por >10 min → `blocked` con handoff explícito

Además, se corrigió la configuración de autenticación para eliminar perfiles agotados y se desactivó WhatsApp.

---

## Cambios aplicados

### 1. Purga global de profiles de OpenAI Codex
- **Ubicaciones modificadas:**
  - `~/.openclaw/openclaw.json` → `auth.profiles`
  - Todos los `auth-profiles.json` de agentes (`~/.openclaw/agents/*/agent/`)
- **Acción:** Se eliminaron todos los perfiles `openai-codex:*` excepto `openai-codex:8juancruzmol@gmail.com`
- **Motivo:** Evitar rotación a perfiles free agotados (`sha256:06bfb5171eff`, `sha256:74ce2e686e58`, etc.)
- **Validación:** Gateway reiniciado; logs posteriores no muestran más perfiles inexistentes.

### 2. Desactivación de WhatsApp
- **Archivo:** `~/.openclaw/openclaw.json`
- **Cambio:** `channels.whatsapp.enabled: true → false`
- **Motivo:** Reducir consumo de tokens (solicitud explícita del usuario)

### 3. Reforma de tickets del project `personal-provider`

#### Ticket #57 (TASK-31 RBAC básico por rol)
- **Estado anterior:** `in_progress`, assignee `juan-cruz`, inactivo ~47h
- **Nuevo estado:** `blocked`
- **Assignee:** `florencia`
- **Comentario agregado:**
  > "Handoff: reactivado por inactividad del asignador original (juan-cruz). Bloqueado hasta definir scope y próximo paso."
- **Motivo:** Inactividad prolongada sin avances; se transfiere a main para Reevaluar.

#### Repriorización masiva de `priority`
- **Criterio:** Tickets `todo` con `priority: medium` → `low`
- **Cantidad afectada:** 41 tickets
- **IDs (ejemplos):** #16, #18, #20, #43–#50, #53–#59, #64–#68, #70, #72–#78, #81–#83, #86–#89, #97–#99, #101–#103, etc.
- **Excepciones:** Se mantuvieron sin cambios los tickets con `priority: high` o `critical`.

### 4. Validación de salud OCOM
- **Endpoints verificados (OK):**
  - `http://127.0.0.1:3001/health` → healthy
  - `http://127.0.0.1:3001/ui/accounts` → 200
  - `http://127.0.0.1:3001/accounts/wham/usage?provider=openai-codex` → 200 (~2s)
  - `http://127.0.0.1:3001/assignments` → 200

---

## Archivos modificados

| Archivo | Cambios |
|---------|---------|
| `~/.openclaw/openclaw.json` | auth.profiles reducido a 1 perfil; WhatsApp desactivado |
| `~/.openclaw/agents/*/agent/auth-profiles.json` | Todos los profiles openai-codex eliminados excepto 8juancruzmol@gmail.com |
| `project_hub/tickets.personal-provider.json` | Ticket #57 bloqueado + handoff; 41 tickets medium → low |

---

## Métricas

- **Tickets reorganizados:** 42 (1 bloqueado + 41 prioridad bajada)
- **Perfiles purgados:** ~7–9 hashes diferentes (default, main, carbon, hykar, juan-cruz, etc.)
- **Caracteres enviados en esta sesión (último update):** ~2200

---

## Próximos pas Pendientes

1. **Verificar en producción** que Florencia enruta consistentemente por `openai-codex:8juancruzmol@gmail.com` sin fallovers a otros proveedores.
2. **Iniciar/validar board** en `http://127.0.0.1:8787/board` (pendiente según usuario).
3. **Agregar cuenta `8juancruzmol@gmail.com`** a OCOM si no existe (ya está en assignment pero confirmar presence en `/ui/accounts`).
4. **Configurar OAuth `prompt=login`** y logging detallado en callback para diagnosticar `invalid_grant`.
5. **Implementar cambios finales de OCOM** (accountProviders en openclaw.json + reinicio gateway).

---

## Observaciones

- El loop de rate-limit se cortó totalmente; no aparecen más events con `profile=sha256:…`.
- WhatsApp gateway sigue conectándose brevemente tras el cambio; se recomienda reiniciar gateway de nuevo para cerrar sesiones viejas.
- La purga de profiles es segura porque todas las asignaciones previas (excepto Florencia→8juancruzmol) ya habían sido eliminadas.

---

**Traza:** Este archivo se generó en respuesta a la solicitud del usuario de crear un trackeo de la tarea. Todos los cambios anteriores fueron committeados previamente donde correspondía.
