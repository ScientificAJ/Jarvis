"""Remember an OpenRouter key in the operating system's credential store.

Keys are never written to the project, a temporary file, or command arguments.
If no secure store is available the caller can continue for this session only.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import re
import shutil
import subprocess
import sys


TARGET = "Jarvis/OpenRouter"
ACCOUNT = "OpenRouter"


class _Credential(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
        ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR),
    ]


def _windows_api():
    api = ctypes.WinDLL("Advapi32", use_last_error=True)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                              ctypes.POINTER(ctypes.POINTER(_Credential))]
    api.CredReadW.restype = wintypes.BOOL
    api.CredWriteW.argtypes = [ctypes.POINTER(_Credential), wintypes.DWORD]
    api.CredWriteW.restype = wintypes.BOOL
    api.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
    api.CredDeleteW.restype = wintypes.BOOL
    api.CredFree.argtypes = [ctypes.c_void_p]
    api.CredFree.restype = None
    return api


def _windows_load() -> str | None:
    api = _windows_api()
    result = ctypes.POINTER(_Credential)()
    if not api.CredReadW(TARGET, 1, 0, ctypes.byref(result)):
        if ctypes.get_last_error() == 1168:  # ERROR_NOT_FOUND
            return None
        raise OSError("Windows Credential Manager could not read the key.")
    try:
        value = result.contents
        return ctypes.string_at(value.CredentialBlob, value.CredentialBlobSize).decode("utf-8")
    finally:
        api.CredFree(result)


def _windows_save(key: str) -> None:
    raw = key.encode("utf-8")
    if not raw or len(raw) > 2560:
        raise ValueError("Invalid credential length.")
    blob = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    credential = _Credential()
    credential.Type = 1  # CRED_TYPE_GENERIC
    credential.TargetName = TARGET
    credential.CredentialBlobSize = len(raw)
    credential.CredentialBlob = ctypes.cast(blob, ctypes.POINTER(ctypes.c_ubyte))
    credential.Persist = 2  # CRED_PERSIST_LOCAL_MACHINE, for this Windows user
    credential.UserName = ACCOUNT
    if not _windows_api().CredWriteW(ctypes.byref(credential), 0):
        raise OSError("Windows Credential Manager could not save the key.")


def _windows_delete() -> None:
    if not _windows_api().CredDeleteW(TARGET, 1, 0) and ctypes.get_last_error() != 1168:
        raise OSError("Windows Credential Manager could not remove the key.")


def _command(args, *, input_text=None):
    return subprocess.run(args, input=input_text, capture_output=True, text=True,
                          check=False, timeout=30)


def _mac_load() -> str | None:
    result = _command(["security", "find-generic-password", "-a", ACCOUNT, "-s", TARGET, "-w"])
    return result.stdout.rstrip("\r\n") if result.returncode == 0 else None


def _mac_save(key: str) -> None:
    # security -i reads commands from a private stdin pipe, keeping the key out
    # of the process list. Reject metacharacters rather than interpreting them.
    if not re.fullmatch(r"[A-Za-z0-9._-]+", key):
        raise ValueError("The key cannot be safely passed to Keychain.")
    script = f"add-generic-password -U -a {ACCOUNT} -s {TARGET} -w {key}\n"
    result = _command(["security", "-i"], input_text=script)
    if result.returncode != 0:
        raise OSError("macOS Keychain could not save the key.")


def _mac_delete() -> None:
    if _mac_load() is None:
        return
    result = _command(["security", "delete-generic-password", "-a", ACCOUNT, "-s", TARGET])
    if result.returncode != 0:
        raise OSError("macOS Keychain could not remove the key.")


def _linux_tool() -> str:
    path = shutil.which("secret-tool")
    if not path:
        raise OSError("The desktop secret service is unavailable.")
    return path


def _linux_load() -> str | None:
    result = _command([_linux_tool(), "lookup", "application", "jarvis", "service", "openrouter"])
    return result.stdout.rstrip("\r\n") if result.returncode == 0 else None


def _linux_save(key: str) -> None:
    result = _command([_linux_tool(), "store", "--label=Jarvis OpenRouter API key",
                       "application", "jarvis", "service", "openrouter"], input_text=key)
    if result.returncode != 0:
        raise OSError("The desktop secret service could not save the key.")


def _linux_delete() -> None:
    result = _command([_linux_tool(), "clear", "application", "jarvis", "service", "openrouter"])
    if result.returncode != 0:
        raise OSError("The desktop secret service could not remove the key.")


def _backend(operation: str):
    if sys.platform == "win32":
        return {"load": _windows_load, "save": _windows_save, "delete": _windows_delete}[operation]
    if sys.platform == "darwin":
        return {"load": _mac_load, "save": _mac_save, "delete": _mac_delete}[operation]
    if sys.platform.startswith("linux"):
        return {"load": _linux_load, "save": _linux_save, "delete": _linux_delete}[operation]
    raise OSError("No secure credential store is available on this platform.")


def load_key() -> str | None:
    try:
        return _backend("load")() or None
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        return None


def save_key(key: str) -> bool:
    try:
        _backend("save")(key)
        # Some command-line keychain tools report success even if the actual
        # write failed. Confirm the value can be retrieved before promising it.
        return load_key() == key
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        return False


def delete_key() -> bool:
    try:
        _backend("delete")()
        return True
    except (OSError, ValueError, UnicodeError, subprocess.SubprocessError):
        return False
