param(
    [ValidateSet('Start', 'Stop', 'Status', 'Restore')]
    [string]$Action = 'Start',
    [string]$LabDirectory = 'F:\freeisprouteros\artifacts\local-lab'
)
$ErrorActionPreference = 'Stop'
$vbox = Join-Path $env:ProgramFiles 'Oracle\VirtualBox\VBoxManage.exe'
$labRoot = [IO.Path]::GetFullPath($LabDirectory).TrimEnd('\') + '\'
$names = @('FreeISP Router Lab', 'FreeISP Customer Lab')
function Invoke-VBox {
    param([string[]]$Arguments)
    $output = & $vbox @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($output -join "`n") }
    return $output
}
function Get-LabVM {
    param([string]$Name)
    $info = Invoke-VBox @('showvminfo', $Name, '--machinereadable')
    $config = (($info | Where-Object { $_ -match '^CfgFile=' }) -replace '^CfgFile="|"$', '') -replace '\\\\', '\'
    if (-not ([IO.Path]::GetFullPath($config).StartsWith($labRoot, [StringComparison]::OrdinalIgnoreCase))) {
        throw "Refusing to change a VM outside the lab folder: $Name"
    }
    return (($info | Where-Object { $_ -match '^VMState=' }) -replace '^VMState="|"$', '')
}
foreach ($name in $names) { $null = Get-LabVM $name }
if ($Action -eq 'Restore') {
    Write-Host 'This discards your lab changes and restores both VMs to the verified starting point.'
    if ((Read-Host 'Type RESTORE to continue') -cne 'RESTORE') { return }
}
foreach ($name in $names) {
    $state = Get-LabVM $name
    switch ($Action) {
        'Status' { Write-Host "${name}: $state" }
        'Start' {
            if ($state -in @('poweroff', 'saved', 'aborted')) {
                Invoke-VBox @('startvm', $name, '--type', 'headless')
            } elseif ($state -eq 'paused') { Invoke-VBox @('controlvm', $name, 'resume') }
        }
        'Stop' {
            if ($state -in @('running', 'paused')) { Invoke-VBox @('controlvm', $name, 'savestate') }
        }
        'Restore' {
            if ($state -in @('running', 'paused')) { Invoke-VBox @('controlvm', $name, 'savestate') }
            Invoke-VBox @('snapshot', $name, 'restore', 'Ready for testing')
            Invoke-VBox @('startvm', $name, '--type', 'headless')
        }
    }
}
if ($Action -in @('Start', 'Restore')) {
    Write-Host 'FreeISP router: http://127.0.0.1:18874/cgi-bin/luci/admin/freeisp'
    Write-Host 'In FreeISP Desk use http://127.0.0.1:18874 and username root.'
    Write-Host 'A cold boot can take about a minute. Your normal Windows network is unchanged.'
}
