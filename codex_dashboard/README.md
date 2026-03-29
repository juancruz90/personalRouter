# Codex Multi-Cuenta Dashboard (MVP)

Panel local para:

- Detectar perfiles OAuth de `openai-codex` por agente.
- Ver qué accountId está realmente en uso.
- Definir asignación de perfiles por agente (1..N).
- Cargar proyectos separados (auto por workspace + proyectos custom).
- Guardar routing por proyecto.
- Aplicar `auth order` por agente (`openclaw models auth order set`).

## Ejecutar

```powershell
cd C:\Users\juanc\.openclaw\workspace\orquestacion\codex_dashboard
python app.py
```

Abrir: <http://127.0.0.1:8787>

## Notas

- Es un MVP operativo: no crea logins OAuth todavía desde UI.
- Para login OAuth por agente se usa CLI y luego el panel detecta perfiles.
- Estado de tokens en tiempo real exacto por billing OAuth no siempre está disponible; el panel muestra estado operativo/routing y perfiles detectados.
