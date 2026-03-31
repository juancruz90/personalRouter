# OpenClaw — Sistema de Orquestación de Cuentas

Sistema para interceptar requests salientes, enrutar tráfico entre múltiples cuentas OAuth y aplicar estrategias de fallback, backoff, cuota, tracking y monitoreo.

## Módulos

- `proxy/` — capa HTTP de entrada e interceptación
- `auth/` — captura OAuth, refresh y gestión de credenciales
- `routing/` — selección de cuenta, fallback y clasificación de errores
- `backoff/` — cooldowns, Retry-After y recuperación de cuentas
- `quota/` — seguimiento y límites de consumo
- `agents/` — asignación de cuentas por agente
- `tracking/` — logs de requests e intentos
- `monitor/` — UI y vistas operativas
- `db/` — esquema, migraciones y acceso SQLite
- `src/` — bootstrap de la aplicación
- `config/` — configuración base del sistema

## Estado

Proyecto inicializado. La tarea 1 cubre la estructura base, documentación mínima y configuración semilla.
