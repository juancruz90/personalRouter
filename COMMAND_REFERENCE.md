# OpenClaw Command Reference

**Propósito:** Lista de comandos validados para usar en sesiones. Si un comando no está aquí, NO lo ejecutes; primero busca documentación oficial.

## openclaw (CLI principal)

### agents
- `openclaw agents list` – Listar agentes configurados
- `openclaw agents add <id>` – Añadir agente aislado
- `openclaw agents delete <id>` – Eliminar agente y limpiar estado
- `openclaw agents set-identity <id> --name <name> [--emoji <emoji>]` – Actualizar identidad
- `openclaw agents bindings <id>` – Listar bindings de enrutamiento
- `openclaw agents bind <id> --provider <provider> --account <accountId>` – Vincular cuenta
- `openclaw agents unbind <id> --provider <provider> --account <accountId>` – Desvincular cuenta

Nota: No existe `openclaw agents auth --provider ...` (esa opción es inválida). La autenticación se gestiona a través de `bind` o via Control UI.

### gateway
- `openclaw gateway status` – Estado del gateway
- `openclaw gateway start` – Iniciar servicio
- `openclaw gateway stop` – Detener servicio
- `openclaw gateway restart` – Reiniciar (SIGUSR1)
- `openclaw gateway logs` – Ver logs en vivo

### config
- `openclaw config get [<path>]` – Obtener valor de config
- `openclaw config apply <file>` – Aplicar config completa (valida + reinicia)
- `openclaw config patch <file>` – Aplicar parche parcial (merge)
- `openclaw config schema.lookup <path>` – Inspeccionar esquema

### doctor
- `openclaw doctor` – Validar configuración
- `openclaw doctor --fix` – Auto-corregir errores comunes
- `openclaw doctor --non-interactive` – Modo no interactivo

### update
- `openclaw update.run` – Actualizar dependencias/git y reiniciar

### logs
- `openclaw logs` – Ver logs recientes
- `openclaw logs --follow` – Seguir logs en vivo
- `openclaw logs --tail <n>` –Últimas n líneas

### status
- `openclaw status` – Tarjeta de estado general
- `openclaw status --deep` – Profundizar en probes

### sessions
- `openclaw sessions list` – Listar sesiones activas
- `openclaw sessions spawn ...` – Lanzar subagente (ver ayuda)

### cron
- `openclaw cron list` – Listar jobs
- `openclaw cron add ...` – Añadir job (ver ayuda)

## Herramientas de soporte (ejecutables externos)
- `node` – Ejecutar scripts Node.js
- `powershell` / `pwsh` – Scripts PowerShell

## Fuentes de verdad
- Ayuda integrada: `openclaw <command> --help`
- Docs oficiales: https://docs.openclaw.ai
- Esquema de config: `openclaw config schema.lookup .`

---

**Regla:** Antes de usar un comando que no aparezca aquí, busca en docs.openclaw.ai y actualiza este archivo con el comando hallado.
