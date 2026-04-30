$ErrorActionPreference = "Stop"

Write-Host "Starting build process..."

# Run Vite build
pnpm vite build
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

# Inject timestamp into sw.js for versioning
$swPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\dist\sw.js"))
if (Test-Path $swPath) {
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
    $content = [System.IO.File]::ReadAllText($swPath)
    $updatedContent = $content.Replace("SW_VERSION_PLACEHOLDER", $timestamp)

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($swPath, $updatedContent, $utf8NoBom)

    Write-Host "Service Worker version updated with timestamp: $timestamp"
}
else {
    Write-Host "Warning: dist/sw.js not found, skipping version injection."
}

Write-Host "Build completed successfully!"
