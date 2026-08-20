# dev-link.ps1 -- point the installed frozen AEYE at this source tree via junctions
# so C:\aeye edits to static/ and plugins/ are live in the frozen app (no copy step).
# Re-run after a fresh reinstall (installing a new setup.exe replaces the junctions
# with real files). Backend (server.py) changes still need a rebuild -- it's compiled.
$ErrorActionPreference = 'Stop'
$src = 'C:\aeye'
$links = @{
  'C:\Program Files\AEYE\_internal\static' = "$src\static"
  "$env:APPDATA\AEYE\plugins"              = "$src\plugins"
}
foreach ($path in $links.Keys) {
  $target = $links[$path]
  if ((Test-Path $path) -and (Get-Item $path).LinkType) {
    "already linked: $path -> $((Get-Item $path).Target)"; continue
  }
  if (Test-Path $path) {
    $bak = "$path.orig"
    if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
    Rename-Item $path $bak
  }
  New-Item -ItemType Junction -Path $path -Target $target | Out-Null
  "linked: $path -> $target"
}
