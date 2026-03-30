---
title: Monitor: agregar retry y manejo de errores de red para evitar fallos silenciosos
priority: high
assigned: Claude (frontend)
project: personal-provider
status: open
created: 2026-03-30
reporter: Juan (main workspace)
---

## Problema

El monitor (`/ui/monitor`) hace dos fetch simultáneos (`/accounts/runtime` y `/events/recent`) apenas se carga la página. Si OCOM está arrancando o la conexión WebSocket interfiere, estos endpoints fallan con `net::ERR_...` y la tabla se queda vacía sin indicar al usuario que está ocurriendo un error.

No hay manejo de errores; simplemente se muestra `console.error` y las tablas permanecen vacías. Esto confunde al usuario, que piensa que no hay datos.

## Solución propuesta

- Agregar función `fetchWithRetry(url, retries=3, delayMs=1000)` con backoff lineal.
- En `load()`, usar `Promise.all([fetchWithRetry(...), fetchWithRetry(...)])`.
- Mantener contador `loadErrors` para mostrar mensaje de estado en las tablas.
- Mostrar mensaje "Conectando con OCOM..." en el primer error; en reintentos posteriores: "Error cargando datos (mensaje). Reintentando...".
- Cambiar color a rojo después de 3 errores.
- Retrasar el primer `load()` con `setTimeout(load, 500)` para darle a OCOM tiempo para arrancar.
- Aumentar intervalo de refresco a 10 s (ya aplicado).

## Diff (monitor.ts)

```diff
diff --git a/src/views/monitor.ts b/src/views/monitor.ts
--- a/src/views/monitor.ts
+++ b/src/views/monitor.ts
@@ -47,6 +47,13 @@ export function renderMonitoringBoard(): string {
 eventsTable: document.querySelector('#events tbody'),
 };
 
+let loadErrors = 0;
+
+function showStatus(msg, isError = false) {
+ const color = isError ? 'var(--crit)' : 'var(--muted)';
+ el.runtimeTable.innerHTML = '<tr><td colspan="5" style="color:' + color + ';text-align:center;padding:16px">' + msg + '</td></tr>';
+}
+
+async function fetchWithRetry(url, retries = 3, delayMs = 1000) {
+ for (let i = 0; i < retries; i++) {
+ try {
+ const res = await fetch(url);
+ if (!res.ok) throw new Error('HTTP ' + res.status);
+ return res;
+ } catch (err) {
+ if (i < retries - 1) {
+ await new Promise(r => setTimeout(r, delayMs * (i + 1)));
+ } else {
+ throw err;
+ }
+ }
+ }
+}
+
 // Initial fetch
 async function load() {
 try {
- const [rtRes, evRes] = await Promise.all([
- fetch('/accounts/runtime?provider=openai-codex'),
- fetch('/events/recent?limit=100')
- ]);
+ const [rtRes, evRes] = await Promise.all([
+ fetchWithRetry('/accounts/runtime?provider=openai-codex'),
+ fetchWithRetry('/events/recent?limit=100'),
+ ]);
 const rt = await rtRes.json();
 const ev = await evRes.json();
+loadErrors = 0;
 ...
 } catch (err) {
- console.error('Monitor load error:', err);
+ loadErrors++;
+ const msg = loadErrors === 1
+ ? 'Conectando con OCOM...'
+ : 'Error cargando datos (' + err.message + '). Reintentando...';
+ showStatus(msg, loadErrors > 2);
+ console.warn('Monitor load error (intento ' + loadErrors + '):', err);
 }
 }
 
- load();
- setInterval(load, 10000);
+ // Primer load con pequeño delay para dejar que OCOM termine de arrancar
+ setTimeout(load, 500);
+ setInterval(load, 10000);
```

## Pasos de prueba

1. Compilar: `npm run build` y reiniciar OCOM.
2. Recargar `/ui/monitor` inmediatamente; debería mostrar "Conectando con OCOM..." brevemente, luego datos cuando estén listos.
3. Simular fallo temporal deteniendo OCOM por unos segundos; el monitor debe reintentar y mostrar mensajes de error transitorios.
4. Verificar que transcurridos ~3 errores, el mensaje se muestre en color rojo.
5. Confirmar que al recuperar OCOM, las tablas se llenan automáticamente en el siguiente intervalo.

## Notas

- Se reutiliza la misma lógica para ambas tablas (runtime y eventos) mostrando el mismo mensaje en ambas.
- El `showStatus` es simple y no distingue entre tablas; si se quiere separar, se puede extender.
- El retry es solo en el `fetch`; si OCOM sigue caído tras 3 intentos, se mantiene el error visible hasta el próximo intervalo (que reintentará de nuevo).

---

*Diff y descripción basados en conversación de workspace (2026-03-30).*