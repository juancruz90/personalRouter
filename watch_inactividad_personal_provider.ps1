# Watcher de Inactividad para personal-provider
# Analiza tickets con estado "in_progress" y detecta inactividad

$ticketsFile = "C:\Users\juanc\.openclaw\workspace\orquestacion\project_hub\tickets.personal-provider.json"
$currentTime = Get-Date "2026-03-27T18:02:00Z"  # Current time in UTC as per task
$discordChannel = "1486027340805836982"

# Load tickets JSON
$ticketsData = Get-Content $ticketsFile -Raw | ConvertFrom-Json
$tickets = $ticketsData.tickets

# Filter in_progress tickets
$inProgressTickets = $tickets | Where-Object { $_.status -eq "in_progress" }

if ($inProgressTickets.Count -eq 0) {
    Write-Output "NO_REPLY"
    exit 0
}

$warnings = @()
$alerts = @()

foreach ($ticket in $inProgressTickets) {
    $updatedAt = [DateTime]::Parse($ticket.updated_at)
    $inactivityMinutes = ($currentTime - $updatedAt).TotalMinutes

    $assignee = $ticket.assignee
    $title = $ticket.title
    $id = $ticket.id

    if ($inactivityMinutes -ge 10) {
        $alerts += @{
            id = $id
            title = $title
            assignee = $assignee
            inactivity = [math]::Round($inactivityMinutes, 1)
            updated_at = $updatedAt.ToString("yyyy-MM-dd HH:mm:ss UTC")
        }
    } elseif ($inactivityMinutes -ge 5) {
        $warnings += @{
            id = $id
            title = $title
            assignee = $assignee
            inactivity = [math]::Round($inactivityMinutes, 1)
            updated_at = $updatedAt.ToString("yyyy-MM-dd HH:mm:ss UTC")
        }
    }
}

# Build output summary
$output = @"

=== INACTIVIDAD WATCHER - personal-provider ===
Timestamp: $($currentTime.ToString("yyyy-MM-dd HH:mm:ss UTC"))
Tickets 'in_progress' encontrados: $($inProgressTickets.Count)

"@

if ($warnings.Count -eq 0 -and $alerts.Count -eq 0) {
    $output += "No hay tickets con inactividad significativa (>5 min)."
} else {
    if ($warnings.Count -gt 0) {
        $output += "`n--- WARNINGS (5+ min sin cambios) ---`n"
        foreach ($w in $warnings) {
            $output += "[ID $($w.id)] $($w.title)`n"
            $output += "  Assignee: $($w.assignee)`n"
            $output += "  Inactividad: $($w.inactivity) min (última actualización: $($w.updated_at))`n"
            $output += "  Motivo: ticket en 'in_progress' sin cambios recientes`n`n"
        }
    }

    if ($alerts.Count -gt 0) {
        $output += "`n--- ALERTAS (10+ min sin cambios) ---`n"
        foreach ($a in $alerts) {
            $output += "[ID $($a.id)] $($a.title)`n"
            $output += "  Assignee: $($a.assignee)`n"
            $output += "  Inactividad: $($a.inactivity) min (última actualización: $($a.updated_at))`n"
            $output += "  Recomendación: Reasignar o bloquear por stale (ticket sin movimiento)`n`n"
        }
        $output += "`n⚠️ Enviar alerta a Discord canal $discordChannel (formato corto de alerta)`n"
    }
}

Write-Output $output
