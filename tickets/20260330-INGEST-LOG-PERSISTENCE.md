---
title: Persistir eventos de OCOM a metrics_events vía ingest de logs
priority: critical
assigned: Claude (backend)
project: personal-provider
status: open
created: 2026-03-30
reporter: Juan (main workspace)
---

## Problema

El sistema de eventos en tiempo real de OCOM (`RealtimeEventsHub`) solo guarda eventos en memoria RAM. No hay persistencia en la base de datos `metrics_events`. Como consecuencia:

- El endpoint `/events/recent` devuelve solo eventos en memoria; tras un reinicio de OCOM se pierde el historial.
- La tabla de eventos en el monitor (`/ui/monitor`) aparece vacía, dificultando el diagnóstico.
- No hay forma de analizar eventos pasados (rate limits, errores, cambios de estado de cuentas).

## Solución propuesta

1. **Endpoint de ingest**  
   Agregar `POST /ingest/log-line` en OCOM que reciba líneas de log del Gateway, las parsee con `EmbeddedLogEnricher` y las publique como eventos.

2. **Persistencia en DB**  
   Modificar `RealtimeEventsHub.publish` para insertar también en `metrics_events`, o bien que el endpoint llame a una función `persistEvent` que inserte directamente.

3. **Actualizar `/events/recent`**  
   Cambiar el endpoint para que lea desde `metrics_events` (DB) y utilice la memoria solo como fallback si la DB está vacía. Devolver eventos ordenados por ID descendente.

## Diffs referenciales

### `src/server.ts` (fragmentos clave)

```diff
+import DatabaseConstructor, { Database } from 'better-sqlite3';
...
const events = new RealtimeEventsHub(200, profileMetaStore, enricher, profileResolver);
+
+const metricsDb = new DatabaseConstructor(dbPath);
+const insertMetricEvent = metricsDb.prepare(
+  `INSERT INTO metrics_events (type, agent_slug, account_id, value, metadata, created_at)
+   VALUES (?, ?, ?, ?, ?, datetime('now'))`
+);
+
+function persistEvent(type, agentSlug, accountId, value, metadata) {
+  try {
+    insertMetricEvent.run(type, agentSlug, accountId, value, JSON.stringify(metadata));
+  } catch (err) {
+    server.log.warn({ err }, 'metrics_events insert failed');
+  }
+}
...
+server.post('/ingest/log-line', async (request, reply) => {
+  const body = parseWithZod(
+    reply,
+    z.object({
+      line: z.string().min(1),
+      source: z.string().optional(),
+    }),
+    request.body || {},
+    'body',
+  );
+  if (!body) return;
+
+  const line = body.line.trim();
+  if (!line.includes('[agent/embedded]')) {
+    return { ok: true, skipped: true };
+  }
+
+  const enriched = enricher.enrich('agent/embedded', { raw: line });
+  const profile = typeof enriched.profile === 'string' ? enriched.profile : null;
+  const email = profile ? profileMetaStore.get(profile)?.email ?? null : null;
+
+  const agentSlug = typeof enriched.runId === 'string' ? enriched.runId : null;
+  const isError = enriched.isError === 'true' || enriched.isError === true;
+  const value = isError ? 1 : 0;
+  const eventType = typeof enriched.event === 'string' ? enriched.event : 'agent/embedded';
+  const metadata = {
+    ...enriched,
+    email: email ?? enriched.email ?? null,
+    source: body.source ?? 'gateway',
+    raw: line,
+  };
+
+  persistEvent(eventType, agentSlug, null, value, metadata);
+
+  events.publish('agent/embedded', { ...metadata });
+
+  return { ok: true, type: eventType, persisted: true };
+});
...
-server.get('/events/recent', async (request, reply) => {
+server.get('/events/recent', async (request, reply) => {
   ...
-  return { ok: true, listeners: events.listenerCount(), events: events.listRecent(limit) };
+  // Leer de DB (persistidos) + memoria (in-flight recientes), deduplicar por id
+  let dbEvents = [];
+  try {
+    const rows = metricsDb.prepare(
+      `SELECT id, type, metadata, created_at FROM metrics_events ORDER BY id DESC LIMIT ?`
+    ).all(limit);
+    dbEvents = rows.reverse().map(row => {
+      let payload = {};
+      try { payload = JSON.parse(row.metadata); } catch {}
+      return { id: row.id, type: row.type, ts: row.created_at, payload };
+    });
+  } catch (err) {
+    server.log.warn({ err }, 'metrics_events read failed, falling back to memory');
+  }
+
+  const memEvents = events.listRecent(limit);
+  const combined = dbEvents.length ? dbEvents : memEvents;
+
+  return { ok: true, listeners: events.listenerCount(), events: combined };
+});
...
server.addHook('onClose', async () => {
+  metricsDb.close();
   if (refreshTimer) { ... }
});
```

### `src/realtimeEvents.ts` (opcional: si se prefiere persistir desde publish)

```diff
+import type { Database } from 'better-sqlite3';
...
 export class RealtimeEventsHub {
   ...
+  private readonly insertStmt: ReturnType<Database['prepare']> | null = null;
   constructor(
     ...,
-    db?: Database
+    db?: Database
   ) {
+    if (db) {
+      this.insertStmt = db.prepare(
+        `INSERT INTO metrics_events (type, agent_slug, account_id, value, metadata, created_at)
+         VALUES (?, ?, ?, ?, ?, datetime('now'))`
+      );
+    }
   }
   publish(type, payload = {}) {
     ...
+    if (this.insertStmt) {
+      try {
+        const agentSlug = typeof enriched.agentSlug === 'string' ? enriched.agentSlug : null;
+        const accountId = typeof enriched.accountId === 'number' ? enriched.accountId : null;
+        const value = typeof enriched.usedPercent === 'number' ? enriched.usedPercent : null;
+        const metadata = JSON.stringify({ type, ...enriched });
+        this.insertStmt.run(type, agentSlug, accountId, value, metadata);
+      } catch {
+        // never block pipeline on DB failure
+      }
+    }
     ...
   }
 }
```

## Pasos de prueba

1. Compilar: `npm run build` y reiniciar OCOM.
2. Enviar una línea de prueba:
   ```powershell
   $line = '[agent/embedded] embedded run agent end: runId=test-123 isError=true model=openrouter/free provider=openrouter error=rate_limit rawError=429 Rate limit exceeded'
   Invoke-RestMethod -Uri 'http://127.0.0.1:3001/ingest/log-line' -Method POST -ContentType 'application/json' -Body (ConvertTo-Json @{ line = $line; source = 'test' })
   ```
3. Verificar en SQLite:
   ```bash
   sqlite3 data/ocom.db "SELECT * FROM metrics_events ORDER BY id DESC LIMIT 1;"
   ```
4. Llamar `GET /events/recent?limit=10` y confirmar que devuelve el evento con `ts` y `payload`.
5. Reiniciar OCOM y verificar que el evento persiste (la DB no se borra).

## Implementación sugerida

- Aplicar los diffs en `src/server.ts` y (opcional) `src/realtimeEvents.ts`.
- Asegurar que `dbPath` apunte a `data/ocom.db` (ya existe).
- Revisar que `EmbeddedLogEnricher` maneje correctamente la línea de ejemplo.
- Considerar rate limiting en `/ingest/log-line` si el gateway lo llamará con alta frecuencia.
- Probar con líneas reales del Gateway (ej. las que contienen `[agent/embedded]` y `rate_limit`).

## Exito

- `/events/recent` muestra eventos históricos (no solo desde el último arranque).
- El monitor muestra tabla de eventos con entradas.
- Las cuentas exhaustas aparecen con evento tipo `account.runtime.event` y pueden correlacionarse.

---

*Diff generado a partir de la conversación de workspace (2026-03-30).*