$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
    $paths = @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object { [string]$_ })
    ConvertTo-Json -Compress -InputObject @{paths=$paths}
} elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
    $image = [System.Windows.Forms.Clipboard]::GetImage()
    $stream = [System.IO.MemoryStream]::new()
    try {
        $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        ConvertTo-Json -Compress -InputObject @{image=[Convert]::ToBase64String($stream.ToArray())}
    } finally { $stream.Dispose(); $image.Dispose() }
} else { '{"paths":[]}' }
