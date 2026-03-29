# Context Optimization Rules (Squad)

Objetivo: mantener contexto pequeño, enfocado y barato para Florencia, Carbon, Hykar y Juan-cruz.

## Reglas operativas

1. **Contexto por agente (aislado)**
   - Cada agente usa solo su archivo `context/runtime/<agente>.md`.
   - No cargar backlog completo salvo pedido explícito.

2. **Capas mínimas**
   - Capa 1: rol + objetivo (siempre)
   - Capa 2: tickets `in_progress` del agente
   - Capa 3: próximos 3-5 tickets relevantes del agente

3. **Presupuesto de contexto**
   - Máximo recomendado por agente: 1 archivo runtime + 1 ticket detallado a la vez.
   - Evitar pegar historiales largos en prompts.

4. **Salida estructurada obligatoria**
   - Estado actual
   - Bloqueos
   - Próximo paso concreto
   - Resultado verificable (endpoint, test, commit o ticket update)

5. **Ciclo de compactación**
   - Regenerar contexto runtime al inicio de bloque de trabajo.
   - Priorizar tickets `in_progress`, luego `high`, luego `medium`.

## Script de soporte

Ejecutar:

```bash
python scripts/refresh_context.py
```

Genera archivos:
- `context/runtime/florencia.md`
- `context/runtime/carbon.md`
- `context/runtime/hykar.md`
- `context/runtime/juan-cruz.md`

Basado en:
- `project_hub/tickets.personal-provider.json`
