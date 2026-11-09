param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Dest,
  [string]$Base = 'JARVIS'
)
# Cree un zip conforme (separateurs "/", dossier racine $Base) lisible par l'Explorateur Windows, 7-Zip, unzip, etc.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$srcFull = (Resolve-Path $Source).Path.TrimEnd('\')
if (Test-Path $Dest) { Remove-Item $Dest -Force }
$stream = [System.IO.File]::Create($Dest)
$zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  Get-ChildItem -LiteralPath $srcFull -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($srcFull.Length + 1).Replace('\', '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, "$Base/$rel", [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally {
  $zip.Dispose()
  $stream.Dispose()
}
