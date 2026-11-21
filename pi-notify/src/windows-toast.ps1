# Windows PowerShell 5.1 ships the WinRT projections used here; PowerShell 7 does not.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Title,

    [Parameter(Mandatory = $false)]
    [AllowEmptyString()]
    [string] $Body = "",

    [Parameter(Mandatory = $true)]
    [string] $Urgency,

    # Prints the toast XML instead of showing it, so the test suite can exercise
    # this script without a notification host.
    [switch] $DryRun
)

$ErrorActionPreference = "Stop"
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$duration = if ($Urgency -eq "critical") { "long" } else { "short" }

$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]

$toastXml = New-Object Windows.Data.Xml.Dom.XmlDocument
$toastXml.LoadXml("<toast duration=`"$duration`"><visual><binding template=`"ToastGeneric`"></binding></visual></toast>")

# GetElementsByTagName returns a live WinRT node list: any mutation of the
# document invalidates its enumerator, so the binding node has to be captured
# once and up front. Enumerating the list again after appending fails with
# "Collection was modified" (BadEnumeration).
$binding = @($toastXml.GetElementsByTagName("binding"))[0]

function ConvertTo-XmlText([string] $Value) {
    # XML 1.0 rejects most C0 controls and the two noncharacters below.
    return $Value -replace '[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]', ''
}

function Add-XmlText([string] $Value) {
    # Text is attached as a text node rather than interpolated into markup, so a
    # title or body can never inject elements or attributes.
    if ([string]::IsNullOrEmpty($Value)) { return }
    $node = $toastXml.CreateElement("text")
    $null = $node.AppendChild($toastXml.CreateTextNode((ConvertTo-XmlText $Value)))
    $null = $binding.AppendChild($node)
}

Add-XmlText $Title
$bodyLines = @($Body -split '\r?\n', 2)
if ($bodyLines.Count -gt 0) { Add-XmlText $bodyLines[0] }
if ($bodyLines.Count -gt 1) { Add-XmlText $bodyLines[1] }

if ($DryRun) {
    Write-Output $toastXml.GetXml()
    return
}

# Loaded only when actually notifying, so -DryRun works on hosts without the
# notification stack (Server SKUs, CI runners).
$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
