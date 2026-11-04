# Set the title of the visible console that an ancestor process owns.
# Used when a hook runs without a console of its own (Qwen Code spawns hooks
# with CREATE_NO_WINDOW). Walks up from $env:SN_START_PID, attaching to the
# first ancestor that owns a console, sets its title and detaches again.
# Input via environment only (no command-line quoting): SN_TITLE, SN_START_PID.
# SN_MODE=resolve: print the PID of that console-owning ancestor instead of
# setting a title (the hook resolves it once while its process chain is alive).
# SN_MODE=cmdlines: print the command lines of SN_START_PID and its ancestors,
# one per line, nearest first (used to detect headless `gemini -p` / `qwen -p`).
$ErrorActionPreference = 'Stop'
if (([string]$env:SN_MODE) -eq 'cmdlines') {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  $p = 0
  [void][int]::TryParse([string]$env:SN_START_PID, [ref]$p)
  # One query for all processes, then walk the parent links in memory.
  $all = @{}
  foreach ($x in (Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CommandLine -ErrorAction SilentlyContinue)) { $all[[int]$x.ProcessId] = $x }
  for ($i = 0; $i -lt 8 -and $p -gt 0; $i++) {
    $proc = $all[$p]
    if (-not $proc) { break }
    $line = ([string]$proc.CommandLine) -replace '[\r\n]', ' '
    [Console]::Out.WriteLine($line)
    $p = [int]$proc.ParentProcessId
  }
  exit 0
}
$resolve = ([string]$env:SN_MODE) -eq 'resolve'
$sig = @'
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint dwProcessId);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool SetConsoleTitleW(string lpConsoleTitle);
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
'@
$k = Add-Type -MemberDefinition $sig -Name ConsoleTitle -Namespace SessionNamer -PassThru
$title = [string]$env:SN_TITLE
$p = 0
[void][int]::TryParse([string]$env:SN_START_PID, [ref]$p)
if ((-not $title -and -not $resolve) -or $p -le 0) { exit 2 }
for ($i = 0; $i -lt 8 -and $p -gt 0; $i++) {
  [void]$k::FreeConsole()
  # Skip windowless consoles: CREATE_NO_WINDOW children (the hook and its shell) get their own.
  if ($k::AttachConsole([uint32]$p) -and $k::GetConsoleWindow() -ne [IntPtr]::Zero) {
    if ($resolve) { [void]$k::FreeConsole(); [Console]::Out.Write($p); exit 0 }
    $ok = $k::SetConsoleTitleW($title)
    [void]$k::FreeConsole()
    if ($ok) { exit 0 } else { exit 3 }
  }
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue
  if (-not $proc) { break }
  $p = [int]$proc.ParentProcessId
}
exit 1
