# Workflow de Mejora Continua (Hykar -> Florencia)

Objetivo: que cada mejora propuesta tenga evaluación clara antes de ejecución.

## Regla
Toda propuesta de mejora se crea como ticket nuevo en Project Hub con prefijo:
- `[MEJORA] ...`

## Campos mínimos del ticket
- **Problema actual**
- **Propuesta de mejora**
- **Métrica objetivo** (qué debería mejorar)
- **Impacto esperado** (Alto/Medio/Bajo)
- **Esfuerzo estimado** (Alto/Medio/Bajo)
- **Riesgo** (Alto/Medio/Bajo)

## Evaluación (Florencia)
Florencia evalúa cada ticket `[MEJORA]` con este criterio:

1. **Necesidad real**
   - ¿Resuelve un problema existente o evita un problema probable?
2. **Impacto**
   - ¿Mejora conversión, calidad, velocidad o confiabilidad?
3. **Factibilidad**
   - ¿Es implementable con recursos actuales?
4. **Prioridad**
   - ¿Debe entrar ahora o backlog?

## Decisión
- **Aprobada:** se mueve a `in_progress` y se asigna owner.
- **Postergada:** se mantiene en `todo` con comentario de cuándo re-evaluar.
- **No implementable / no necesaria:** se cierra con resolución explicando por qué.

## Plantilla de comentario de evaluación
```text
Evaluación Florencia:
- Necesidad: [alta/media/baja]
- Impacto esperado: [alto/medio/bajo]
- Factibilidad: [alta/media/baja]
- Riesgo: [alto/medio/bajo]
- Decisión: [aprobar/postergar/no implementar]
- Motivo:
- Próxima revisión (si aplica):
```
