$ticketsFile = "project_hub\tickets.personal-provider.json"
$ticketsJson = Get-Content $ticketsFile -Raw | ConvertFrom-Json
$now = [DateTime]::UtcNow

$inProgressTickets = @()
foreach ($ticket in $ticketsJson.tickets) {
    if ($ticket.status -eq "in_progress") {
        $updated = [DateTime]::Parse($ticket.updated_at)
        $minutesInactive = ($now - $updated).TotalMinutes
        $ticketInfo = [PSCustomObject]@{
            id = $ticket.id
            title = $ticket.title
            assignee = $ticket.assignee
            updated_at = $ticket.updated_at
            minutes_inactive = [math]::Round($minutesInactive, 2)
        }
        $inProgressTickets += $ticketInfo
    }
}

Write-Output "=== IN_PROGRESS TICKETS ANALYSIS ==="
Write-Output "Current time (UTC): $($now.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Output "Total in_progress tickets: $($inProgressTickets.Count)"
Write-Output ""

if ($inProgressTickets.Count -eq 0) {
    Write-Output "NO_INACTIVITY"
    exit 0
}

foreach ($ticket in $inProgressTickets) {
    $status = ""
    if ($ticket.minutes_inactive -ge 10) {
        $status = "[ALERT >10min]"
    } elseif ($ticket.minutes_inactive -ge 5) {
        $status = "[WARNING 5-10min]"
    } else {
        $status = "[ACTIVE <5min]"
    }
    Write-Output "$($status) ID: $($ticket.id) | Title: $($ticket.title) | Assignee: $($ticket.assignee) | Inactive: $($ticket.minutes_inactive) min | Last update: $($ticket.updated_at)"
}

Write-Output ""
Write-Output "=== RECOMMENDATIONS ==="
foreach ($ticket in $inProgressTickets) {
    if ($ticket.minutes_inactive -ge 10) {
        Write-Output "TICKET $($ticket.id) ($($ticket.title)): Recommend REASSIGN or BLOCK as STALE (>10min inactive, assignee: $($ticket.assignee))"
    } elseif ($ticket.minutes_inactive -ge 5) {
        Write-Output "TICKET $($ticket.id) ($($ticket.title)): WARNING - 5+ minutes inactive, assignee: $($ticket.assignee)"
    }
}
