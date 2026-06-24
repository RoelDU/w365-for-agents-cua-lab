# Tiny dependency-free static server for the installed Vite build.
# Uses TcpListener instead of HttpListener so no URL ACL is needed for users.

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [int]$Port = 5173
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $Root "index.html"))) {
    throw "Static root does not contain index.html: $Root"
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse("127.0.0.1"), $Port)
$listener.Start()

$contentTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".js" = "text/javascript; charset=utf-8"
    ".mjs" = "text/javascript; charset=utf-8"
    ".css" = "text/css; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".svg" = "image/svg+xml"
    ".png" = "image/png"
    ".jpg" = "image/jpeg"
    ".jpeg" = "image/jpeg"
    ".ico" = "image/x-icon"
    ".txt" = "text/plain; charset=utf-8"
}

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
            $requestLine = $reader.ReadLine()
            if (-not $requestLine) {
                continue
            }

            while ($reader.ReadLine()) {
                # Drain headers.
            }

            $parts = $requestLine.Split(" ")
            $method = $parts[0]
            $rawPath = if ($parts.Length -gt 1) { $parts[1] } else { "/" }

            if ($method -ne "GET" -and $method -ne "HEAD") {
                $body = [System.Text.Encoding]::UTF8.GetBytes("Method not allowed")
                $header = "HTTP/1.1 405 Method Not Allowed`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
                $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
                $stream.Write($headerBytes, 0, $headerBytes.Length)
                if ($method -ne "HEAD") { $stream.Write($body, 0, $body.Length) }
                continue
            }

            $pathOnly = ($rawPath -split "\?")[0]
            $decoded = [System.Uri]::UnescapeDataString($pathOnly).TrimStart("/")
            $decoded = $decoded -replace "/", "\"

            $file = Join-Path $Root $decoded
            $fullRoot = [System.IO.Path]::GetFullPath($Root)
            $fullFile = [System.IO.Path]::GetFullPath($file)

            if (-not $fullFile.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $fullFile -PathType Leaf)) {
                $fullFile = Join-Path $Root "index.html"
            }

            $bytes = [System.IO.File]::ReadAllBytes($fullFile)
            $ext = [System.IO.Path]::GetExtension($fullFile).ToLowerInvariant()
            $contentType = if ($contentTypes.ContainsKey($ext)) { $contentTypes[$ext] } else { "application/octet-stream" }
            $header = "HTTP/1.1 200 OK`r`nContent-Type: $contentType`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
            $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
            $stream.Write($headerBytes, 0, $headerBytes.Length)
            if ($method -ne "HEAD") {
                $stream.Write($bytes, 0, $bytes.Length)
            }
        } catch {
            # Keep the demo server alive if a browser closes a connection early.
        } finally {
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
