param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Asar = 'C:\Program Files\DSH NEXT\resources\app.asar'
)

$fs = [System.IO.File]::OpenRead($Asar)
try {
  $head = New-Object byte[] 16
  $null = $fs.Read($head, 0, 16)
  $headerSize = [BitConverter]::ToUInt32($head, 12)
  $hbuf = New-Object byte[] $headerSize
  $null = $fs.Read($hbuf, 0, $headerSize)
  $root = ([System.Text.Encoding]::UTF8.GetString($hbuf)) | ConvertFrom-Json
  $dataBase = 16 + $headerSize

  $node = $root
  foreach ($seg in ($Path -split '/')) {
    if ($seg -eq '') { continue }
    $node = $node.files.$seg
    if ($null -eq $node) { throw "no such entry: $seg in $Path" }
  }
  if ($null -eq $node.files -and $null -ne $node.link) {
    $node = $root
    foreach ($seg in ($node.link -split '/')) { if ($seg) { $node = $node.files.$seg } }
  }
  if ($null -ne $node.size) {
    $fs.Position = $dataBase + [int64]$node.offset
    $bytes = New-Object byte[] ([int64]$node.size)
    $null = $fs.Read($bytes, 0, $bytes.Length)
    [System.Text.Encoding]::UTF8.GetString($bytes)
  }
  else {
    $node.files.PSObject.Properties.Name
  }
}
finally {
  $fs.Close()
}
