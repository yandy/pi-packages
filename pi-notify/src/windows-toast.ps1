# Windows PowerShell 5.1 ships the WinRT projections used here; PowerShell 7 does not.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Title,

    [Parameter(Mandatory = $false)]
    [AllowEmptyString()]
    [string] $Body = "",

    [Parameter(Mandatory = $true)]
    [string] $Urgency
)

$ErrorActionPreference = "Stop"
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$duration = if ($Urgency -eq "critical") { "long" } else { "short" }

$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

$toastXml = New-Object Windows.Data.Xml.Dom.XmlDocument
$toastXml.LoadXml("<toast duration=`"$duration`"><visual><binding template=`"ToastGeneric`"><text></text><text></text><text></text></binding></visual></toast>")

function ConvertTo-XmlText([string] $Value) {
    # XML 1.0 rejects most C0 controls and the two noncharacters below.
    return $Value -replace '[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]', ''
}

$textNodes = $toastXml.GetElementsByTagName("text")
$null = $textNodes[0].AppendChild($toastXml.CreateTextNode((ConvertTo-XmlText $Title)))
$bodyLines = @($Body -split '\r?\n', 2)
if ($bodyLines.Count -gt 0 -and $bodyLines[0].Length -gt 0) {
    $null = $textNodes[1].AppendChild($toastXml.CreateTextNode((ConvertTo-XmlText $bodyLines[0])))
}
if ($bodyLines.Count -gt 1 -and $bodyLines[1].Length -gt 0) {
    $null = $textNodes[2].AppendChild($toastXml.CreateTextNode((ConvertTo-XmlText $bodyLines[1])))
}

$toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
