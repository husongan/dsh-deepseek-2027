param(
  [Parameter(Mandatory = $true)][string]$Job,
  [switch]$Elevated
)
$ErrorActionPreference = 'Stop'
# DeepSeek 2027 — administrator job runner.
#
# Invoked twice:
#
#   * without -Elevated, this script re-launches ITSELF through
#     `Start-Process -Verb RunAs` and waits. That is where the unfiltered
#     administrator token comes from; the caller's process stays at its own
#     integrity level.
#   * with -Elevated, it runs inside that raised token: it reads <job>/job.json,
#     launches the requested argv, then writes <job>/stdout.txt,
#     <job>/stderr.txt and <job>/done.json.
#
# A job directory is used instead of a pipe because an elevated child cannot
# write into a pipe owned by a lower-integrity process. The directory is created
# by the caller under the same account's temp path, which the raised token can
# write back into.
#
# Windows PowerShell 5.1 targets .NET Framework, whose ProcessStartInfo has no
# ArgumentList collection, so the child's command line is quoted here with the
# MSVCRT rules every Windows runtime parses the same way. Console output is
# decoded with the machine's OEM code page — the code page a redirected cmd.exe or
# powershell.exe actually writes — and stored as UTF-8, so the caller never sees
# mojibake for a localized system.

function Quote-Arg([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $slashes = 0
  foreach ($ch in $Value.ToCharArray()) {
    if ($ch -eq '\') { $slashes++; continue }
    if ($ch -eq '"') {
      [void]$sb.Append('\' * (($slashes * 2) + 1))
      [void]$sb.Append('"')
      $slashes = 0
      continue
    }
    if ($slashes -gt 0) { [void]$sb.Append('\' * $slashes); $slashes = 0 }
    [void]$sb.Append($ch)
  }
  if ($slashes -gt 0) { [void]$sb.Append('\' * ($slashes * 2)) }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function Join-Args($Items) {
  if ($Items.Count -eq 0) { return '' }
  return (($Items | ForEach-Object { Quote-Arg ([string]$_) }) -join ' ')
}

# --- Stage 1: raise the token -------------------------------------------------

if (-not $Elevated) {
  $hostExe = (Get-Process -Id $PID).Path
  $self = $MyInvocation.MyCommand.Path
  $relaunch = Join-Args @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', $self, '-Job', $Job, '-Elevated'
  )
  try {
    $raised = Start-Process -FilePath $hostExe -ArgumentList $relaunch -Verb RunAs -WindowStyle Hidden -PassThru
    [void]$raised.WaitForExit(900000)
  } catch {
    # The consent prompt was declined, or no interactive desktop could raise it.
    $done = Join-Path $Job 'done.json'
    $payload = @{
      exitCode  = $null
      error     = "elevation was refused or could not start: $($_.Exception.Message)"
      elapsedMs = 0
      user      = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      hostPid   = $PID
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($done, $payload, (New-Object System.Text.UTF8Encoding($false)))
  }
  exit 0
}

# --- Stage 2: run the job inside the raised token -----------------------------

$oem = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
$utf8 = New-Object System.Text.UTF8Encoding($false)

$jobDir = $Job
$spec = Get-Content -Raw -LiteralPath (Join-Path $jobDir 'job.json') | ConvertFrom-Json

$outPath = Join-Path $jobDir 'stdout.txt'
$errPath = Join-Path $jobDir 'stderr.txt'
$donePath = Join-Path $jobDir 'done.json'

$started = Get-Date
$exitCode = $null
$errorText = $null
$outTask = $null
$errTask = $null
try {
  $argv = @($spec.argv)
  if ($argv.Count -lt 1) { throw 'job.json needs a non-empty argv' }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = [string]$argv[0]
  $psi.Arguments = Join-Args ($argv[1..($argv.Count)] | Where-Object { $null -ne $_ })
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.RedirectStandardInput = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = $oem
  $psi.StandardErrorEncoding = $oem
  if ($spec.cwd) { $psi.WorkingDirectory = [string]$spec.cwd }
  if ($spec.env) {
    foreach ($p in $spec.env.PSObject.Properties) { $psi.Environment[[string]$p.Name] = [string]$p.Value }
  }

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()

  if ($spec.stdinB64) {
    $bytes = [Convert]::FromBase64String([string]$spec.stdinB64)
    $proc.StandardInput.Write($utf8.GetString($bytes))
  }
  $proc.StandardInput.Close()

  # Drain both pipes concurrently: a full pipe would block the child and neither
  # side would ever finish.
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  $timeoutMs = 0
  if ($spec.timeoutMs) { $timeoutMs = [int]$spec.timeoutMs }
  if ($timeoutMs -gt 0) {
    if (-not $proc.WaitForExit($timeoutMs)) {
      try { $proc.Kill() } catch { }
      throw ('timed out after ' + $timeoutMs + ' ms')
    }
  } else {
    $proc.WaitForExit()
  }
  $stdout = $outTask.GetAwaiter().GetResult()
  $stderr = $errTask.GetAwaiter().GetResult()
  $exitCode = $proc.ExitCode
  [System.IO.File]::WriteAllText($outPath, [string]$stdout, $utf8)
  [System.IO.File]::WriteAllText($errPath, [string]$stderr, $utf8)
} catch {
  $errorText = $_.Exception.Message
  try {
    if ($null -ne $outTask -and $outTask.IsCompleted) { [System.IO.File]::WriteAllText($outPath, [string]$outTask.GetAwaiter().GetResult(), $utf8) }
    if ($null -ne $errTask -and $errTask.IsCompleted) { [System.IO.File]::WriteAllText($errPath, [string]$errTask.GetAwaiter().GetResult(), $utf8) }
  } catch { }
}
$elapsed = [int]((Get-Date) - $started).TotalMilliseconds
$payload = @{
  exitCode  = $exitCode
  error     = $errorText
  elapsedMs = $elapsed
  user      = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  hostPid   = $PID
} | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($donePath, $payload, $utf8)
