# Project Hub (MVP)

Gestor simple de tickets para que Florencia orqueste y los agentes trabajen en conjunto.

## Archivo de estado
- `project_hub/tickets.json`

## Comandos
Desde `C:\Users\juanc\.openclaw\workspace\orquestacion`:

```powershell
python .\project_hub\ticket_manager.py init
```

Crear ticket:

```powershell
python .\project_hub\ticket_manager.py add --title "Landing v2" --description "Mejorar hero y CTA" --priority high --by juan --tags web conversion
```

Listar:

```powershell
python .\project_hub\ticket_manager.py list
```

Tomar ticket (auto mejor prioridad):

```powershell
python .\project_hub\ticket_manager.py claim --agent carbon
```

Mover estado:

```powershell
python .\project_hub\ticket_manager.py move --id 1 --status review --by carbon
```

Comentar:

```powershell
python .\project_hub\ticket_manager.py comment --id 1 --by florencia --text "Revisar tono del CTA"
```

Resolver:

```powershell
python .\project_hub\ticket_manager.py resolve --id 1 --by carbon --resolution "Copy aprobado y publicado"
```

Ver detalle completo:

```powershell
python .\project_hub\ticket_manager.py show --id 1
```

## Flujo sugerido del squad
1. Juan crea tickets.
2. Florencia prioriza/ordena.
3. Cada agente hace `claim` y trabaja.
4. Florencia mueve a `review` o pide cambios.
5. Al cerrar, el agente deja resolución + lección aprendida en su `memory/LESSONS.md`.
