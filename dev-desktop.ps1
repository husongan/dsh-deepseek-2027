param([switch]$Once)
$ErrorActionPreference = 'Stop'
# DeepSeek 2027 — desktop control worker.
#
# Loads the Win32 interop once, then serves JSON commands on stdin/stdout: one
# request object per line in, one result object per line out, matched by `id`.
#
# This worker deliberately runs at the *current* integrity level, not elevated:
# Windows UIPI blocks input injection from a higher-integrity process into
# ordinary applications, so an administrator-level sender would appear to work
# while nothing actually reaches the target window. Administrator *commands*
# use the separate elevated runner (dev-exec.ps1); desktop input stays on the
# user's own token.
#
# NOTE: PowerShell variable names are case-INSENSITIVE. Never name a parameter the
# same as a script-scope hashtable ($BTN / $VK), or the parameter silently clobbers it.

[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class DS27 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INP[] a, int cb);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EP cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetClassNameW(IntPtr h, StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RC { public int L; public int T; public int R; public int B; }
  public delegate bool EP(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KI { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct HI { public uint msg; public ushort lo; public ushort hi; }
  [StructLayout(LayoutKind.Explicit)] public struct UN { [FieldOffset(0)] public MI mi; [FieldOffset(0)] public KI ki; [FieldOffset(0)] public HI hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INP { public uint type; public UN u; }
  public static INP Mouse(int dx,int dy,uint data,uint flags){ INP i=new INP(); i.type=0; i.u.mi.dx=dx; i.u.mi.dy=dy; i.u.mi.data=data; i.u.mi.flags=flags; return i; }
  public static INP Kbd(ushort vk,ushort scan,uint flags){ INP i=new INP(); i.type=1; i.u.ki.vk=vk; i.u.ki.scan=scan; i.u.ki.flags=flags; return i; }
  public static uint Send(INP[] a){ return SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INP))); }
  public static IntPtr Fore(){ return GetForegroundWindow(); }
  public static string ClassOf(IntPtr h){ var sb=new StringBuilder(256); GetClassNameW(h,sb,sb.Capacity); return sb.ToString(); }
  public static string[] Wins(){
    var list=new List<string>();
    EnumWindows((h,p)=>{
      if(!IsWindowVisible(h)) return true;
      int n=GetWindowTextLengthW(h);
      if(n < 1) return true;
      var sb=new StringBuilder(n+1); GetWindowTextW(h,sb,sb.Capacity);
      RC r; GetWindowRect(h,out r);
      list.Add(((long)h).ToString()+"\t"+sb.ToString()+"\t"+r.L+"\t"+r.T+"\t"+(r.R-r.L)+"\t"+(r.B-r.T));
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
}
'@

[void][DS27]::SetProcessDPIAware()

# Button flags. $BTN is script scope: do NOT name any parameter $btn.
$BTN = @{ 'left' = @(0x0002, 0x0004); 'right' = @(0x0008, 0x0010); 'middle' = @(0x0020, 0x0040) }

$VK = @{
  'BACKSPACE'=0x08;'TAB'=0x09;'ENTER'=0x0D;'RETURN'=0x0D;'SHIFT'=0x10;'CTRL'=0x11;'CONTROL'=0x11;
  'ALT'=0x12;'PAUSE'=0x13;'CAPSLOCK'=0x14;'ESC'=0x1B;'ESCAPE'=0x1B;'SPACE'=0x20;'PAGEUP'=0x21;
  'PAGEDOWN'=0x22;'END'=0x23;'HOME'=0x24;'LEFT'=0x25;'UP'=0x26;'RIGHT'=0x27;'DOWN'=0x28;
  'PRINTSCREEN'=0x2C;'INSERT'=0x2D;'DELETE'=0x2E;'DEL'=0x2E;'LWIN'=0x5B;'WIN'=0x5B;'RWIN'=0x5C;
  'NUMLOCK'=0x90;'SCROLLLOCK'=0x91;'APPS'=0x5D;'SLEEP'=0x5F;
  '`'=0xC0;'-'=0xBD;'='=0xBB;'['=0xDB;']'=0xDD;'\'=0xDC;';'=0xBA;"'"=0xDE;','=0xBC;'.'=0xBE;'/'=0xBF
}
for ($i = 1; $i -le 24; $i++) { $VK["F$i"] = 0x6F + $i }
for ($i = 0; $i -le 9; $i++) { $VK["$i"] = 0x30 + $i }
for ($c = 65; $c -le 90; $c++) { $VK[[string][char]$c] = $c }

function Move-To([int]$targetX, [int]$targetY, [int]$durationMs) {
  if ($durationMs -le 0) { [void][DS27]::SetCursorPos($targetX, $targetY); return }
  $pt = New-Object DS27+PT
  [void][DS27]::GetCursorPos([ref]$pt)
  $startX = $pt.X; $startY = $pt.Y
  $steps = [Math]::Max(1, [int]($durationMs / 15))
  for ($i = 1; $i -le $steps; $i++) {
    $t = $i / $steps; $e = $t * $t * (3 - 2 * $t)
    [void][DS27]::SetCursorPos([int]($startX + ($targetX - $startX) * $e), [int]($startY + ($targetY - $startY) * $e))
    Start-Sleep -Milliseconds 15
  }
}

function Button-Flags([string]$buttonName) {
  if ([string]::IsNullOrEmpty($buttonName)) { $buttonName = 'left' }
  $flags = $BTN[$buttonName]
  if ($null -eq $flags) { throw "unknown button: $buttonName" }
  return $flags
}

function Click-At([int]$atX, [int]$atY, [string]$buttonName, [int]$times) {
  if ($atX -ge 0 -and $atY -ge 0) { [void][DS27]::SetCursorPos($atX, $atY) }
  $flags = Button-Flags $buttonName
  if ($times -lt 1) { $times = 1 }
  for ($i = 0; $i -lt $times; $i++) {
    [void][DS27]::Send(@([DS27]::Mouse(0, 0, 0, [uint32]$flags[0])))
    Start-Sleep -Milliseconds 30
    [void][DS27]::Send(@([DS27]::Mouse(0, 0, 0, [uint32]$flags[1])))
    if ($times -gt 1) { Start-Sleep -Milliseconds 80 }
  }
}

function Hold-At([int]$atX, [int]$atY, [string]$buttonName, [int]$holdMs) {
  if ($atX -ge 0 -and $atY -ge 0) { [void][DS27]::SetCursorPos($atX, $atY) }
  $flags = Button-Flags $buttonName
  if ($holdMs -le 0) { $holdMs = 800 }
  [void][DS27]::Send(@([DS27]::Mouse(0, 0, 0, [uint32]$flags[0])))
  Start-Sleep -Milliseconds $holdMs
  [void][DS27]::Send(@([DS27]::Mouse(0, 0, 0, [uint32]$flags[1])))
}

function Wheel([int]$atX, [int]$atY, [int]$notches, [int]$hNotches) {
  if ($atX -ge 0 -and $atY -ge 0) { [void][DS27]::SetCursorPos($atX, $atY) }
  if ($notches -ne 0) {
    $dir = 1
    if ($notches -lt 0) { $dir = -1 }
    for ($i = 0; $i -lt [Math]::Abs($notches); $i++) {
      [void][DS27]::Send(@([DS27]::Mouse(0, 0, [uint32]([int]($dir * 120) + 4294967296 * [int]($dir -lt 0)), 0x0800)))
      Start-Sleep -Milliseconds 25
    }
  }
  if ($hNotches -ne 0) {
    $hdir = 1
    if ($hNotches -lt 0) { $hdir = -1 }
    for ($i = 0; $i -lt [Math]::Abs($hNotches); $i++) {
      [void][DS27]::Send(@([DS27]::Mouse(0, 0, [uint32]([int]($hdir * 120) + 4294967296 * [int]($hdir -lt 0)), 0x1000)))
      Start-Sleep -Milliseconds 25
    }
  }
}

function Key-Code([int]$code, [bool]$down) {
  $flags = 0
  if (-not $down) { $flags = 2 }
  [void][DS27]::Send(@([DS27]::Kbd([uint16]$code, 0, [uint32]$flags)))
}

function Type-Text([string]$s) {
  foreach ($ch in $s.ToCharArray()) {
    $code = [uint16][int]$ch
    [void][DS27]::Send(@([DS27]::Kbd(0, $code, 4)))
    [void][DS27]::Send(@([DS27]::Kbd(0, $code, 6)))
  }
}

function Get-CursorPoint() {
  $pt = New-Object DS27+PT
  [void][DS27]::GetCursorPos([ref]$pt)
  return @($pt.X, $pt.Y)
}

# Capture [rx,ry,rw,rh] and burn in a coordinate grid, scaled by $scale.
# Reported image pixels map back as: screen = origin + pixel / scale.
function Shot([string]$outPath, [int]$rx, [int]$ry, [int]$rw, [int]$rh, [int]$grid, [int]$cx, [int]$cy, [double]$scale) {
  if ($scale -le 0) { $scale = 1 }
  $tw = [int][Math]::Max(1, [Math]::Round($rw * $scale))
  $th = [int][Math]::Max(1, [Math]::Round($rh * $scale))

  $src = New-Object System.Drawing.Bitmap($rw, $rh)
  $sg = [System.Drawing.Graphics]::FromImage($src)
  $sg.CopyFromScreen($rx, $ry, 0, 0, (New-Object System.Drawing.Size($rw, $rh)))
  $sg.Dispose()

  $bmp = New-Object System.Drawing.Bitmap($tw, $th)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $tw, $th)
  $src.Dispose()

  if ($grid -gt 0) {
    $font = New-Object System.Drawing.Font('Consolas', 9)
    $gp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(80, 70, 170, 255), 1)
    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(185, 0, 0, 0))
    $fg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 130, 225, 255))
    $lx = [Math]::Ceiling($rx / $grid) * $grid
    while ($lx -lt ($rx + $rw)) {
      $px = [int](($lx - $rx) * $scale)
      $g.DrawLine($gp, $px, 0, $px, $th)
      $g.FillRectangle($bg, $px + 1, 1, 50, 13)
      $g.DrawString("$lx", $font, $fg, [single]($px + 2), [single]1)
      $lx += $grid
    }
    $ly = [Math]::Ceiling($ry / $grid) * $grid
    while ($ly -lt ($ry + $rh)) {
      $py = [int](($ly - $ry) * $scale)
      $g.DrawLine($gp, 0, $py, $tw, $py)
      $g.FillRectangle($bg, 1, $py + 1, 50, 13)
      $g.DrawString("$ly", $font, $fg, [single]2, [single]($py + 1))
      $ly += $grid
    }
  }

  if ($cx -gt -100000 -and $cy -gt -100000) {
    $px = [int](($cx - $rx) * $scale); $py = [int](($cy - $ry) * $scale)
    $cp = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 255, 60, 60), 2)
    $g.DrawLine($cp, 0, $py, $tw, $py)
    $g.DrawLine($cp, $px, 0, $px, $th)
    $g.DrawEllipse($cp, [int]($px - 9), [int]($py - 9), 18, 18)
    $g.Dispose(); $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    return
  }

  $g.Dispose(); $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}

# Interop is compiled; announce readiness so the host can warm the worker eagerly.
[Console]::Out.WriteLine('{"id":0,"ok":true,"ready":true,"elevated":false,"user":"' + ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name -replace '\\','\\') + '"}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line -eq '') { continue }
  $id = $null
  try {
    $cmd = $line | ConvertFrom-Json
    $id = $cmd.id
    $act = [string]$cmd.action
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $res = @{ ok = $true }
    switch ($act) {
      'info' {
        $c = Get-CursorPoint
        $res.screen = @{ x = $vs.X; y = $vs.Y; width = $vs.Width; height = $vs.Height }
        $res.cursor = @{ x = $c[0]; y = $c[1] }
        $res.primary = @{ width = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; height = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height }
        $res.foreground = ([long][DS27]::Fore()).ToString()
        $res.monitors = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
            @{ name = $_.DeviceName; primary = $_.Primary; x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height }
          })
      }
      'move' {
        Move-To ([int]$cmd.x) ([int]$cmd.y) ([int]$cmd.durationMs)
        $c = Get-CursorPoint; $res.cursor = @{ x = $c[0]; y = $c[1] }
      }
      'click' {
        $btnName = [string]$cmd.button
        if ([string]::IsNullOrEmpty($btnName)) { $btnName = 'left' }
        Click-At ([int]$cmd.x) ([int]$cmd.y) $btnName ([int]$cmd.count)
        $c = Get-CursorPoint
        $res.button = $btnName; $res.count = [int]$cmd.count
        $res.cursor = @{ x = $c[0]; y = $c[1] }
      }
      'hold' {
        $btnName = [string]$cmd.button
        if ([string]::IsNullOrEmpty($btnName)) { $btnName = 'left' }
        $holdMs = [int]$cmd.holdMs
        if ($holdMs -le 0) { $holdMs = 800 }
        Hold-At ([int]$cmd.x) ([int]$cmd.y) $btnName $holdMs
        $c = Get-CursorPoint
        $res.button = $btnName; $res.holdMs = $holdMs
        $res.cursor = @{ x = $c[0]; y = $c[1] }
      }
      'mouseDown' {
        $btnName = [string]$cmd.button
        if ([string]::IsNullOrEmpty($btnName)) { $btnName = 'left' }
        if ([int]$cmd.x -ge 0 -and [int]$cmd.y -ge 0) { [void][DS27]::SetCursorPos([int]$cmd.x, [int]$cmd.y) }
        $flags = Button-Flags $btnName
        [void][DS27]::Send(@([DS27]::Mouse(0, 0, 0, [uint32]$flags[0])))
        $c = Get-CursorPoint
        $res.button = $btnName; $res.down = $true
        $res.cursor = @{ x = $c[0]; y = $c[1] }
      }
      'mouseUp' {
        $btnName = [string]$cmd.button
        if ([string]::IsNullOrEmpty($btnName)) { $btnName = 'left' }
        if ([int]$cmd.x -ge 0 -and [int]$cmd.y -ge 0) { [void][DS27]::SetCursorPos([int]$cmd.x, [int]$cmd.y) }
        $flags = Button-Flags $btnName
        [void][DS27]::Send(@([DS27]::Mouse(0, 0, 0, [uint32]$flags[1])))
        $c = Get-CursorPoint
        $res.button = $btnName; $res.down = $false
        $res.cursor = @{ x = $c[0]; y = $c[1] }
      }
      'drag' {
        $btnName = [string]$cmd.button
        if ([string]::IsNullOrEmpty($btnName)) { $btnName = 'left' }
        $flags = Button-Flags $btnName
        $sx = [int]$cmd.x; $sy = [int]$cmd.y
        $tx = [int]$cmd.toX; $ty = [int]$cmd.toY
        # Settle on the start point before pressing: a press issued in the same tick as
        # the move is often delivered to the window the cursor just left.
        [void][DS27]::SetCursorPos($sx, $sy)
        Start-Sleep -Milliseconds 60
        [void][DS27]::Send(@([DS27]::Mouse(0, 0, 0, [uint32]$flags[0])))
        Start-Sleep -Milliseconds 80
        $steps = [int]$cmd.steps
        if ($steps -gt 0) {
          for ($i = 1; $i -le $steps; $i++) {
            $t = $i / $steps; $e = $t * $t * (3 - 2 * $t)
            [void][DS27]::SetCursorPos([int]($sx + ($tx - $sx) * $e), [int]($sy + ($ty - $sy) * $e))
            Start-Sleep -Milliseconds 15
          }
        } else {
          Move-To $tx $ty ([int]$cmd.durationMs)
        }
        Start-Sleep -Milliseconds 80
        [void][DS27]::Send(@([DS27]::Mouse(0, 0, 0, [uint32]$flags[1])))
        $res.from = @{ x = $sx; y = $sy }; $res.to = @{ x = $tx; y = $ty }
        $res.button = $btnName
        $c = Get-CursorPoint; $res.cursor = @{ x = $c[0]; y = $c[1] }
      }
      'scroll' {
        Wheel ([int]$cmd.x) ([int]$cmd.y) ([int]$cmd.vertical) ([int]$cmd.horizontal)
        $res.vertical = [int]$cmd.vertical; $res.horizontal = [int]$cmd.horizontal
      }
      'type' {
        if ([string]::IsNullOrEmpty([string]$cmd.textB64)) { throw 'type requires text' }
        $txt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string]$cmd.textB64))
        Type-Text $txt
        $delay = [int]$cmd.perCharacterDelayMs
        if ($delay -gt 0) { Start-Sleep -Milliseconds ($delay * [Math]::Max(1, $txt.Length) / 10) }
        $res.length = $txt.Length
      }
      'key' {
        $k = ([string]$cmd.key).ToUpperInvariant()
        if (-not $VK.ContainsKey($k)) { throw "unknown key: $($cmd.key)" }
        $mods = @()
        if (-not [string]::IsNullOrWhiteSpace([string]$cmd.modifiers)) {
          foreach ($m in ([string]$cmd.modifiers).Split(',')) {
            $mm = $m.Trim().ToUpperInvariant()
            if ($mm -eq '') { continue }
            if (-not $VK.ContainsKey($mm)) { throw "unknown modifier: $m" }
            $mods += $VK[$mm]
          }
        }
        foreach ($m in $mods) { Key-Code $m $true }
        Key-Code $VK[$k] $true
        Key-Code $VK[$k] $false
        for ($i = $mods.Count - 1; $i -ge 0; $i--) { Key-Code $mods[$i] $false }
        $res.key = $k
        $res.modifiers = ([string]$cmd.modifiers)
      }
      'keyDown' {
        $k = ([string]$cmd.key).ToUpperInvariant()
        if (-not $VK.ContainsKey($k)) { throw "unknown key: $($cmd.key)" }
        Key-Code $VK[$k] $true
        $res.key = $k; $res.down = $true
      }
      'keyUp' {
        $k = ([string]$cmd.key).ToUpperInvariant()
        if (-not $VK.ContainsKey($k)) { throw "unknown key: $($cmd.key)" }
        Key-Code $VK[$k] $false
        $res.key = $k; $res.down = $false
      }
      'windows' {
        $list = @()
        foreach ($l in [DS27]::Wins()) {
          $p = $l.Split("`t")
          $list += [pscustomobject]@{ handle = $p[0]; title = $p[1]; x = [int]$p[2]; y = [int]$p[3]; width = [int]$p[4]; height = [int]$p[5] }
        }
        $res.windows = $list
        $res.foreground = (([long][DS27]::Fore()).ToString())
      }
      'focus' {
        $target = [IntPtr]::Zero
        $h = [string]$cmd.handle
        $q = [string]$cmd.query
        if (-not [string]::IsNullOrWhiteSpace($h)) { $target = [IntPtr][long]$h }
        elseif (-not [string]::IsNullOrWhiteSpace($q)) {
          foreach ($l in [DS27]::Wins()) {
            $p = $l.Split("`t")
            if ($p[1].ToLowerInvariant().Contains($q.ToLowerInvariant())) { $target = [IntPtr][long]$p[0]; break }
          }
        }
        if ($target -eq [IntPtr]::Zero) { throw "no window matched: $q$h" }
        if ([DS27]::IsIconic($target)) { [void][DS27]::ShowWindow($target, 9) } else { [void][DS27]::ShowWindow($target, 5) }
        [void][DS27]::SetForegroundWindow($target)
        Start-Sleep -Milliseconds 200
        $res.handle = (([long]$target).ToString())
      }
      'at' {
        $p = New-Object DS27+POINT
        $p.X = [int]$cmd.x; $p.Y = [int]$cmd.y
        $hwnd = [DS27]::WindowFromPoint($p)
        $sb = New-Object System.Text.StringBuilder(512)
        [void][DS27]::GetWindowTextW($hwnd, $sb, $sb.Capacity)
        $res.handle = ([long]$hwnd).ToString()
        $res.title = $sb.ToString()
        $res.className = [DS27]::ClassOf($hwnd)
      }
      'clipboardGet' {
        $res.text = [System.Windows.Forms.Clipboard]::GetText()
      }
      'clipboardSet' {
        if ([string]::IsNullOrEmpty([string]$cmd.textB64)) { [System.Windows.Forms.Clipboard]::Clear(); $res.cleared = $true }
        else {
          $txt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String([string]$cmd.textB64))
          [System.Windows.Forms.Clipboard]::SetText($txt)
          $res.length = $txt.Length
        }
      }
      'shot' {
        $out = [string]$cmd.out
        if ([string]::IsNullOrEmpty($out)) { throw 'shot requires out' }
        $rx = $vs.X; $ry = $vs.Y; $rw = $vs.Width; $rh = $vs.Height
        $w = [int]$cmd.width; $hh = [int]$cmd.height
        if ($w -gt 0 -and $hh -gt 0) { $rx = [int]$cmd.x; $ry = [int]$cmd.y; $rw = $w; $rh = $hh }
        $sc = [double]$cmd.scale
        if ($sc -le 0) { $sc = 1 }
        $grid = [int]$cmd.gridSize
        Shot $out $rx $ry $rw $rh $grid ([int]$cmd.crossX) ([int]$cmd.crossY) $sc
        $res.path = $out
        $res.origin = @{ x = $rx; y = $ry }
        $res.sourceWidth = $rw; $res.sourceHeight = $rh
        $res.width = [int][Math]::Max(1, [Math]::Round($rw * $sc))
        $res.height = [int][Math]::Max(1, [Math]::Round($rh * $sc))
        $res.scale = $sc
        $res.grid = $grid
      }
      default { throw "unknown action: $act" }
    }
    $res.id = $id
    [Console]::Out.WriteLine(($res | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
  } catch {
    $err = @{ ok = $false; id = $id; error = $_.Exception.Message }
    [Console]::Out.WriteLine(($err | ConvertTo-Json -Compress -Depth 8))
    [Console]::Out.Flush()
  }
}
