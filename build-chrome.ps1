$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$distRoot = Join-Path $root "dist"
$target = Join-Path $distRoot "chrome"

if (Test-Path $target) {
  Remove-Item -LiteralPath $target -Recurse -Force
}

New-Item -ItemType Directory -Path $target | Out-Null
New-Item -ItemType Directory -Path (Join-Path $target "src") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $target "src\\shared") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $target "src\\vendor") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $target "src\\vendor\\ffmpeg") | Out-Null
New-Item -ItemType Directory -Path (Join-Path $target "src\\vendor\\ffmpeg-core") | Out-Null

Copy-Item -LiteralPath (Join-Path $root "manifest.chrome.json") -Destination (Join-Path $target "manifest.json")
Copy-Item -LiteralPath (Join-Path $root "LICENSE") -Destination (Join-Path $target "LICENSE")
Copy-Item -LiteralPath (Join-Path $root "README.md") -Destination (Join-Path $target "README.md")
Copy-Item -LiteralPath (Join-Path $root "src\\background.js") -Destination (Join-Path $target "src\\background.js")
Copy-Item -LiteralPath (Join-Path $root "src\\browser-api.js") -Destination (Join-Path $target "src\\browser-api.js")
Copy-Item -LiteralPath (Join-Path $root "src\\content-script.js") -Destination (Join-Path $target "src\\content-script.js")
Copy-Item -LiteralPath (Join-Path $root "src\\page-proxy.js") -Destination (Join-Path $target "src\\page-proxy.js")
Copy-Item -LiteralPath (Join-Path $root "src\\player.html") -Destination (Join-Path $target "src\\player.html")
Copy-Item -LiteralPath (Join-Path $root "src\\player.js") -Destination (Join-Path $target "src\\player.js")
Copy-Item -LiteralPath (Join-Path $root "src\\shared\\constants.js") -Destination (Join-Path $target "src\\shared\\constants.js")
Copy-Item -LiteralPath (Join-Path $root "src\\shared\\gsm-decoder.js") -Destination (Join-Path $target "src\\shared\\gsm-decoder.js")
Copy-Item -LiteralPath (Join-Path $root "src\\shared\\ms-gsm.js") -Destination (Join-Path $target "src\\shared\\ms-gsm.js")
Copy-Item -LiteralPath (Join-Path $root "src\\shared\\processing.js") -Destination (Join-Path $target "src\\shared\\processing.js")
Copy-Item -LiteralPath (Join-Path $root "src\\shared\\wav.js") -Destination (Join-Path $target "src\\shared\\wav.js")
Copy-Item -LiteralPath (Join-Path $root "node_modules\\@ffmpeg\\ffmpeg\\dist\\esm\\classes.js") -Destination (Join-Path $target "src\\vendor\\ffmpeg\\classes.js")
Copy-Item -LiteralPath (Join-Path $root "node_modules\\@ffmpeg\\ffmpeg\\dist\\esm\\const.js") -Destination (Join-Path $target "src\\vendor\\ffmpeg\\const.js")
Copy-Item -LiteralPath (Join-Path $root "node_modules\\@ffmpeg\\ffmpeg\\dist\\esm\\errors.js") -Destination (Join-Path $target "src\\vendor\\ffmpeg\\errors.js")
Copy-Item -LiteralPath (Join-Path $root "node_modules\\@ffmpeg\\ffmpeg\\dist\\esm\\index.js") -Destination (Join-Path $target "src\\vendor\\ffmpeg\\index.js")
Copy-Item -LiteralPath (Join-Path $root "node_modules\\@ffmpeg\\ffmpeg\\dist\\esm\\types.js") -Destination (Join-Path $target "src\\vendor\\ffmpeg\\types.js")
Copy-Item -LiteralPath (Join-Path $root "node_modules\\@ffmpeg\\ffmpeg\\dist\\esm\\utils.js") -Destination (Join-Path $target "src\\vendor\\ffmpeg\\utils.js")
Copy-Item -LiteralPath (Join-Path $root "node_modules\\@ffmpeg\\ffmpeg\\dist\\esm\\worker.js") -Destination (Join-Path $target "src\\vendor\\ffmpeg\\worker.js")
Copy-Item -LiteralPath (Join-Path $root "node_modules\\@ffmpeg\\core\\dist\\esm\\ffmpeg-core.js") -Destination (Join-Path $target "src\\vendor\\ffmpeg-core\\ffmpeg-core.js")
Copy-Item -LiteralPath (Join-Path $root "node_modules\\@ffmpeg\\core\\dist\\esm\\ffmpeg-core.wasm") -Destination (Join-Path $target "src\\vendor\\ffmpeg-core\\ffmpeg-core.wasm")

Write-Host "Chrome build ready at $target"
