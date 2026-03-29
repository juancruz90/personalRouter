# MEMORY.md (main)

Memoria de largo plazo del agente **main**.

## Qué guardar
- Decisiones importantes
- Errores cometidos y su corrección
- Reglas operativas que evitaron fallas
- Preferencias del usuario relevantes para este agente

## Qué NO guardar
- Secretos/token/API keys
- Datos sensibles innecesarios

## Reglas estrictas de configuración

### openclaw.json (y cualquier archivo de configuración)
- **Prohibido** agregar o modificar claves (properties) sin **evidencia clara** de que son válidas.
- La evidencia puede ser:
  - Documentación oficial (docs.openclaw.ai)
  - Salida de `openclaw config schema.lookup <path>`
  - Ayuda de CLI (`openclaw <command> --help`)
  - Ejemplos officiales en el repositorio.
- Si no hay evidencia, **NO** tocar el archivo. Buscar primero.
- Los bindings y auth profiles se gestionan en archivos separados (`agents/<id>/agent/bindings.json`, `agents/<id>/agent/auth-profiles.json`), no en `openclaw.json`.
- Antes de modificar `openclaw.json`, validar con `openclaw doctor --non-interactive`.
- Cualquier cambio que cause "Unrecognized key" debe revertirse inmediatamente.

###Historial de lecciones
- 2026-03-27: Se agregó `"bindings"` en `agents.list[0]` (openclaw.json) -> error "Unrecognized key". Los bindings deben ir en `agents/main/agent/bindings.json`.
