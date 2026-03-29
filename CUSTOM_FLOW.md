# OCOM Custom Flow (OpenClaw + Codex OAuth)

Este documento es la referencia rápida para cualquier agente/modelo nuevo.

## 1) Arquitectura

- OpenClaw Gateway usa modelo `openai-codex/...`.
- OCOM (este repo) corre en `http://127.0.0.1:3001`.
- OCOM administra cuentas OAuth múltiples y expone UI/API para routing/estado.

## 2) Endpoints clave

- Health: `GET /health`
- UI cuentas: `GET /ui/accounts`
- Runtime cuentas: `GET /accounts/runtime?provider=openai-codex`
- Cuota real Codex (WHAM): `GET /accounts/wham/usage?provider=openai-codex`
- Probe + persist runtime: `POST /accounts/runtime/probe`
- Asignaciones por agente: `GET /assignments`

## 3) Regla crítica de cuota

NO usar `https://api.openai.com/v1/models` para medir cuota de este flujo.

Fuente válida para cuota en este custom provider:
- `https://chatgpt.com/backend-api/wham/usage`

Mapeo de cuota:
- `allowed=true` => cuota `yes`
- `allowed=false` o `limit_reached=true` => cuota `no`
- sin dato/timeout/error => cuota `unknown`

## 4) UI esperada en `/ui/accounts`

Debe mostrar:
- Cuota (yes/no/unknown)
- Uso %
- Última actualización
- Cuentas en uso ahora (asignadas)
- Cuentas sin asignación

## 5) Troubleshooting rápido

1. Si todo falla: verificar `GET /health`.
2. Si no hay % o cuota: verificar `GET /accounts/wham/usage?provider=openai-codex`.
   - Timeout/error → reportar `quota=unknown` (no asumir `no`).
   - Si persiste, reiniciar OCOM (`node dist/server.js`) y reintentar.
3. Si una cuenta no aparece en "en uso ahora": revisar `GET /assignments` (puede estar sin asignación).
4. Si UI cae o falta ruta: reiniciar OCOM con `node dist/server.js`.

## 6) Nota histórica sobre probe de cuota

- El probe inicial contra `/v1/models` (OpenAI) no es confiable para este flujo OAuth custom (devuelve 403 para cuentas funcionales). ✅ Fuente válida: `GET /accounts/wham/usage?provider=openai-codex`.
- Plan futuro: implementar `ProviderProbeAdapter` (Node.js/TypeScript) para soportar múltiples providers y usar eventos de tráfico real como source of truth.
