# Reads the UI Automation element under the mouse cursor. Read-only. Prints one JSON line.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File uia-probe.ps1 [-X 100 -Y 200]
param([int]$X = -1, [int]$Y = -1)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($X -lt 0) { $p = [System.Windows.Forms.Cursor]::Position; $X = $p.X; $Y = $p.Y }
try {
  $pt = New-Object System.Windows.Point($X, $Y)
  $el = [System.Windows.Automation.AutomationElement]::FromPoint($pt)
  $r = $el.Current.BoundingRectangle
  $pid_ = $el.Current.ProcessId
  $proc = Get-Process -Id $pid_ -ErrorAction SilentlyContinue
  $text = $null
  try { $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $text = $vp.Current.Value } catch {}
  [pscustomobject]@{
    ok = $true; ms = $sw.ElapsedMilliseconds; x = $X; y = $Y
    name = $el.Current.Name; controlType = $el.Current.ControlType.ProgrammaticName; className = $el.Current.ClassName
    automationId = $el.Current.AutomationId; framework = $el.Current.FrameworkId
    rect = @($r.X, $r.Y, $r.Width, $r.Height); process = $proc.ProcessName; valueLen = if ($text) { $text.Length } else { $null }
  } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; ms = $sw.ElapsedMilliseconds; x = $X; y = $Y; error = $_.Exception.Message } | ConvertTo-Json -Compress
}
