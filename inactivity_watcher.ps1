$json = Get-Content 'C:\Users\juanc\.openclaw\workspace\orquestacion\project_hub\tickets.personal-provider.json' -Raw | ConvertFrom-Json
$now = [DateTime]::UtcNow
$inProgress = $json.tickets | Where-Object { $_.status -eq 'in_progress' }

if ($inProgress.Count -eq 0) {
    Write-Output "NO_REPLY"
    exit 0
}

$warnings = @()
$alerts = @()

foreach ($ticket in $inProgress) {
    $updated = [DateTime]$ticket.updated_at
    $minutesInactive = [int](($now - $updated).TotalMinutes)
    $hasComments = $ticket.comments -and $ticket.comments.Count -gt 0
    $lastComment = if ($hasComments) { $ticket.comments[-1].ts } else { $null }
    $commentDelta = if ($lastComment) { [int](($now - ([DateTime]$lastComment)).TotalMinutes) } else { $null }
    
    # Determine if there's a recent comment that might indicate activity
    $effectiveInactivity = if ($hasComments -and $commentDelta -lt $minutesInactive) { $commentDelta } else { $minutesInactive }
    
    if ($effectiveInactivity -ge 10) {
        $alerts += [PSCustomObject]@{
            id = $ticket.id
            title = $ticket.title
            assignee = $ticket.assignee
            minutes = $effectiveInactivity
        }
    } elseif ($effectiveInactivity -ge 5) {
        $warnings += [PSCustomObject]@{
            id = $ticket.id
            title = $ticket.title
            assignee = $ticket.assignee
            minutes = $effectiveInactivity
        }
    }
}

$output = ""

if ($warnings.Count -gt 0) {
    $output += "=== WARNING (5+ min inactivity) ===`n"
    foreach ($w in $warnings) {
        $output += "Ticket #$($w.id): $($w.title) | Assignee: $($w.assignee) | Inactive: $($w.minutes) min`n"
    }
    $output += "`n"
}

if ($alerts.Count -gt 0) {
    $output += "=== ALERT (10+ min inactivity) ===`n"
    foreach ($a in $alerts) {
        $output += "Ticket #$($a.id): $($a.title) | Assignee: $($a.assignee) | Inactive: $($a.minutes) min`n"
    }
    $output += "Recommendation: Consider reassigning or marking as stale/blocked`n"
    $output += "`n"
}

if ($output -eq "") {
    Write-Output "NO_REPLY"
} else {
    Write-Output $output
}
