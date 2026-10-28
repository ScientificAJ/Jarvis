$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$project = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $project '.runtime'
$pythonDir = Join-Path $runtime 'python'
$python = Join-Path $pythonDir 'python.exe'
$marker = Join-Path $runtime 'installed-v1.txt'
$env:HF_HOME = Join-Path $runtime 'huggingface'
$env:HF_HUB_DISABLE_SYMLINKS_WARNING = '1'
# Standard HTTPS is more reliable than the optional Xet transport on some
# Windows networks. The pinned repository and file checks still apply.
$env:HF_HUB_DISABLE_XET = '1'

function Run-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "A setup step failed (exit code $LASTEXITCODE)." }
}

try {
    if ((Test-Path -LiteralPath $marker) -and (Test-Path -LiteralPath $python) -and
        (Test-Path -LiteralPath (Join-Path $runtime 'bark-model\model.bark')) -and
        (Test-Path -LiteralPath (Join-Path $runtime 'bark-model\bark_loader.py'))) {
        exit 0
    }

    New-Item -ItemType Directory -Force -Path $runtime, $pythonDir | Out-Null
    if (-not (Test-Path -LiteralPath $python)) {
        Write-Host 'Downloading a private Python 3.11 runtime for Jarvis...'
        $zip = Join-Path $runtime 'python-3.11.9-embed-amd64.zip'
        Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip' -OutFile $zip
        Expand-Archive -LiteralPath $zip -DestinationPath $pythonDir -Force
        Remove-Item -LiteralPath $zip -Force
    }

    # The embeddable distribution disables the site-packages directory by default.
    $pth = Join-Path $pythonDir 'python311._pth'
    $pthText = Get-Content -LiteralPath $pth -Raw
    $pthText = $pthText -replace '(?m)^\s*#\s*import site\s*$', 'import site'
    Set-Content -LiteralPath $pth -Value $pthText -Encoding ascii

    if (-not (Test-Path -LiteralPath (Join-Path $pythonDir 'Lib\site-packages\pip'))) {
        Write-Host 'Installing the private Python package manager...'
        $getPip = Join-Path $runtime 'get-pip.py'
        Invoke-WebRequest -Uri 'https://bootstrap.pypa.io/get-pip.py' -OutFile $getPip
        Run-Checked $python @($getPip, '--no-warn-script-location')
        Remove-Item -LiteralPath $getPip -Force
    }

    Write-Host 'Installing the Bark 3.0 runtime. This can take a while on the first run...'
    $torchIndex = 'https://download.pytorch.org/whl/cpu'
    if (($env:JARVIS_DEVICE -ne 'cpu') -and (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue)) {
        $torchIndex = 'https://download.pytorch.org/whl/cu128'
        Write-Host 'NVIDIA graphics detected; installing the CUDA-enabled runtime.'
    } else {
        Write-Host 'Installing the CPU runtime.'
    }
    Run-Checked $python @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location', 'torch==2.8.0', '--index-url', $torchIndex)
    Run-Checked $python @('-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location',
        'huggingface_hub==2.2.0', 'constriction==0.5.0', 'numpy==2.4.6', 'soundfile==0.14.0',
        'soxr==1.1.0', 'transformers==5.19.0', 'librosa==0.11.0')

    Write-Host 'Downloading Underdog Bark 3.0 and its speech processor...'
    Run-Checked $python @((Join-Path $PSScriptRoot 'prepare_model.py'))
    Set-Content -LiteralPath $marker -Value 'Bark 3.0 dependencies and model prepared.' -Encoding ascii
    Write-Host 'Local speech model is ready.'
} catch {
    Write-Host "Setup could not complete: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Check your internet connection and available disk space, then run Jarvis.cmd again.'
    exit 1
}
