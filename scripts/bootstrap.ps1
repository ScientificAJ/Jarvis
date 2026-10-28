$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$project = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $project '.runtime'
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($architecture -eq 'Arm64') {
    $pythonDir = Join-Path $runtime 'python-arm64'
    $pythonArch = 'arm64'
} elseif ($architecture -eq 'X64') {
    # Keep existing Windows installs and their saved settings usable.
    $pythonDir = Join-Path $runtime 'python'
    $pythonArch = 'amd64'
} else {
    throw 'Jarvis requires 64-bit Windows on an x64 or ARM64 processor.'
}
$python = Join-Path $pythonDir 'python.exe'
$marker = Join-Path $runtime "installed-streaming-$pythonArch-v1.txt"
$model = Join-Path $runtime 'streaming-model'
$modelFiles = @('encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx',
                'decoder-epoch-99-avg-1-chunk-16-left-128.onnx',
                'joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx', 'tokens.txt')

function Run-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "A setup step failed (exit code $LASTEXITCODE)." }
}

try {
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    Set-Content -LiteralPath (Join-Path $runtime 'python-arch.txt') -Value $pythonArch -Encoding ascii
    $allModelFiles = @($modelFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $model $_)) }).Count -eq 0
    if ((Test-Path -LiteralPath $marker) -and (Test-Path -LiteralPath $python) -and $allModelFiles) {
        exit 0
    }
    New-Item -ItemType Directory -Force -Path $runtime, $pythonDir | Out-Null
    if (-not (Test-Path -LiteralPath $python)) {
        Write-Host "Downloading a private Python runtime for Windows $pythonArch..."
        $zip = Join-Path $runtime "python-3.11.9-embed-$pythonArch.zip"
        Invoke-WebRequest -Uri "https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-$pythonArch.zip" -OutFile $zip
        Expand-Archive -LiteralPath $zip -DestinationPath $pythonDir -Force
        Remove-Item -LiteralPath $zip -Force
    }

    $pth = Join-Path $pythonDir 'python311._pth'
    $pthText = Get-Content -LiteralPath $pth -Raw
    $pthText = $pthText -replace '(?m)^\s*#\s*import site\s*$', 'import site'
    Set-Content -LiteralPath $pth -Value $pthText -Encoding ascii
    if (-not (Test-Path -LiteralPath (Join-Path $pythonDir 'Lib\site-packages\pip'))) {
        Write-Host 'Preparing the private Python package manager...'
        $getPip = Join-Path $runtime 'get-pip.py'
        Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip
        Run-Checked $python @($getPip, '--no-warn-script-location')
        Remove-Item -LiteralPath $getPip -Force
    }

    Write-Host 'Installing the lightweight speech runtime...'
    Run-Checked $python @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location',
        '--only-binary=:all:', 'sherpa-onnx==1.13.8', 'numpy>=1.26.4,<3')
    Write-Host 'Preparing the lightweight streaming speech model...'
    Run-Checked $python @((Join-Path $PSScriptRoot 'prepare_model.py'))
    Set-Content -LiteralPath $marker -Value 'Streaming speech runtime and model prepared.' -Encoding ascii
    Write-Host 'Local speech model is ready.'
} catch {
    Write-Host "Setup could not complete: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Check your internet connection and available disk space, then run Jarvis.cmd again.'
    exit 1
}
