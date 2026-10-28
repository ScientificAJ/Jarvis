"""Get a session-only OpenRouter key with a native prompt where available."""
from __future__ import annotations

import getpass
import os
from pathlib import Path
import shutil
import subprocess
import sys


class StartupCancelled(Exception):
    pass


def request_api_key() -> str:
    existing = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if existing:
        print("Using the OpenRouter key from the environment.", flush=True)
        return existing

    root = Path(__file__).resolve().parent
    command = None
    if sys.platform == "win32":
        command = ["powershell.exe", "-NoLogo", "-NoProfile", "-STA", "-ExecutionPolicy", "Bypass",
                   "-File", str(root / "scripts" / "prompt-key.ps1")]
    elif sys.platform == "darwin" and shutil.which("osascript"):
        command = ["osascript", "-e", 'text returned of (display dialog "Enter your OpenRouter API key for this session:" default answer "" with hidden answer buttons {"Cancel", "Prepare Jarvis"} default button "Prepare Jarvis" with title "Start Jarvis")']
    elif (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")) and shutil.which("zenity"):
        command = ["zenity", "--password", "--title=Start Jarvis"]
    elif (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")) and shutil.which("kdialog"):
        command = ["kdialog", "--password", "Enter your OpenRouter API key for this session:", "--title", "Start Jarvis"]

    if command:
        print("Enter your OpenRouter API key in the startup dialog.", flush=True)
        try:
            result = subprocess.run(command, capture_output=True, text=True, check=False)
        except OSError:
            result = None
        if result is not None:
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
            if result.returncode == 2 or sys.platform != "win32":
                raise StartupCancelled("Startup was cancelled; no API key was provided.")
            # A Windows dialog infrastructure failure may still be recoverable
            # via the terminal; never print the captured dialog output.

    if not sys.stdin.isatty():
        raise StartupCancelled("No interactive key prompt is available. Set OPENROUTER_API_KEY and start Jarvis again.")
    key = getpass.getpass("OpenRouter API key (input is hidden): ").strip()
    if not key:
        raise StartupCancelled("Startup was cancelled; no API key was provided.")
    return key
