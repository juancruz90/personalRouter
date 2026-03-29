param(
    [string]$TicketsPath = "C:\Users\juanc\.openclaw\workspace\orquestacion\project_hub\tickets.personal-provider.json"
)

$now = Get-Date "2026-03-27T01:14:00Z"

$json = Get-Content $TicketsPath -Raw | ConvertFrom-Json

$inProgress = $json.tickets | Where-Object { $_.status -eq 'in_progress' }

$warnings = @()
$alerts = @()

foreach ($ticket in $inProgress) {
    # Find events for this ticket
    $events = $json.events | Where-Object { $_.ticket_id -eq $ticket.id }

    if ($events) {
        $lastEvent = $events | Sort-Object { [DateTime]::Parse($_.ts) } -Descending | Select-Object -First 1
        $lastTime = [DateTime]::Parse($lastEvent.ts)
    } else {
        $lastTime = [DateTime]::Parse($ticket.created_at)
    }

    $diff = $now - $lastTime
    $minutes = $diff.TotalMinutes

    $info = [PSCustomObject]@{
        id = $ticket.id
        title = $ticket.title
        assignee = $ticket.assignee
        minutes = [math]::Round($minutes, 2)
        lastAction = if ($lastEvent) { $lastEvent.action } else { 'created' }
        lastTs = $lastTime.ToString('yyyy-MM-dd HH:mm:ss')
    }

    if ($minutes -ge 10) {
        $alerts += $info
    } elseif ($minutes -ge 5) {
        $warnings += $info
    }
}

Write-Host "=== WARNINGS (>=5 min) ==="
if ($warnings.Count -eq 0) { Write-Host "None" } else { $warnings | Format-Table -AutoSize | Out-String }

Write-Host "`n=== ALERTS (>=10 min) ==="
if ($alerts.Count -eq 0) { Write-Host "None" } else { $alerts | Format-Table -AutoSize | Out-String }
