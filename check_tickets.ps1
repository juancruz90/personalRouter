$json = Get-Content 'C:\Users\juanc\.openclaw\workspace\orquestacion\project_hub\tickets.personal-provider.json' -Raw
$tickets = ConvertFrom-Json $json
$inProgress = @()
foreach ($t in $tickets) {
    if ($t.status -eq 'in_progress') {
        $inProgress += $t
    }
}
Write-Host "Found $($inProgress.Count) in_progress tickets"
$now = [datetime]::Parse('2026-03-27T19:21:00Z')
foreach ($t in $inProgress) {
    $updated = [datetime]::Parse($t.updated_at)
    $mins = [math]::Round(($now - $updated).TotalMinutes, 1)
    [PSCustomObject]@{
        ID = $t.id
        Title = $t.title
        Assignee = $t.assignee
        Updated = $t.updated_at
        InactiveMins = $mins
    } | Format-Table -AutoSize
}
