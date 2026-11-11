param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Dest,
  [string]$Base = ''
)
# Cree un zip conforme (separateurs "/", dossier racine $Base optionnel) lisible par l'Explorateur Windows, 7-Zip, unzip, etc.
# Enumeration .NET : le prefixe du chemin reste celui fourni (sur meme avec un chemin 8.3 comme STIMOI~1).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = [System.IO.Path]::GetFullPath($Source).TrimEnd('\')
if (-not [System.IO.Directory]::Exists($src)) { throw "Dossier source introuvable : $src" }
$Dest = [System.IO.Path]::GetFullPath($Dest)
if ([System.IO.File]::Exists($Dest)) { [System.IO.File]::Delete($Dest) }
$stream = [System.IO.File]::Create($Dest)
$zip = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in [System.IO.Directory]::EnumerateFiles($src, '*', [System.IO.SearchOption]::AllDirectories)) {
    $rel = $file.Substring($src.Length + 1).Replace('\', '/')
    $name = if ($Base) { "$Base/$rel" } else { $rel }
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file, $name, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally {
  $zip.Dispose()
  $stream.Dispose()
}
