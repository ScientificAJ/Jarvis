import contextlib
import io
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from jarvis_startup import StartupCancelled, request_api_key


class StartupPromptTests(unittest.TestCase):
    def setUp(self):
        # Never touch a real keychain while exercising the startup dialog.
        self.load = patch("jarvis_startup.load_key", return_value=None).start()
        self.save = patch("jarvis_startup.save_key", return_value=True).start()
        self.addCleanup(patch.stopall)

    def test_saved_key_is_used_without_a_dialog(self):
        self.load.return_value = "saved-secret"
        with patch.dict("os.environ", {}, clear=True), patch("jarvis_startup.subprocess.run") as run, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(request_api_key(), "saved-secret")
        run.assert_not_called()
        self.save.assert_not_called()
        self.assertNotIn("saved-secret", output.getvalue())

    def test_storage_failure_falls_back_to_session_only(self):
        self.save.return_value = False
        reply = subprocess.CompletedProcess([], 0, stdout="dialog-secret\n", stderr="")
        with patch.dict("os.environ", {}, clear=True), patch("jarvis_startup.sys.platform", "win32"), \
             patch("jarvis_startup.subprocess.run", return_value=reply), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(request_api_key(), "dialog-secret")
        self.assertIn("session only", output.getvalue())
        self.assertNotIn("dialog-secret", output.getvalue())

    def test_existing_environment_key_needs_no_dialog(self):
        with patch.dict("os.environ", {"OPENROUTER_API_KEY": "existing-secret"}, clear=True), \
             patch("jarvis_startup.subprocess.run") as run, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(request_api_key(), "existing-secret")
        run.assert_not_called()
        self.assertNotIn("existing-secret", output.getvalue())

    def test_windows_dialog_returns_key_without_logging_it(self):
        reply = subprocess.CompletedProcess([], 0, stdout="dialog-secret\n", stderr="")
        with patch.dict("os.environ", {}, clear=True), patch("jarvis_startup.sys.platform", "win32"), \
             patch("jarvis_startup.subprocess.run", return_value=reply) as run, \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(request_api_key(), "dialog-secret")
        self.assertIn("prompt-key.ps1", str(run.call_args))
        self.assertNotIn("dialog-secret", output.getvalue())

    def test_cancelling_dialog_stops_startup(self):
        reply = subprocess.CompletedProcess([], 2, stdout="", stderr="")
        with patch.dict("os.environ", {}, clear=True), patch("jarvis_startup.sys.platform", "win32"), \
             patch("jarvis_startup.subprocess.run", return_value=reply), contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaises(StartupCancelled):
                request_api_key()

    def test_mac_dialog_uses_a_hidden_input(self):
        reply = subprocess.CompletedProcess([], 0, stdout="mac-key\n", stderr="")
        with patch.dict("os.environ", {}, clear=True), patch("jarvis_startup.sys.platform", "darwin"), \
             patch("jarvis_startup.shutil.which", return_value="/usr/bin/osascript"), \
             patch("jarvis_startup.subprocess.run", return_value=reply) as run, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(request_api_key(), "mac-key")
        self.assertIn("with hidden answer", str(run.call_args))

    def test_linux_uses_a_password_dialog_when_available(self):
        reply = subprocess.CompletedProcess([], 0, stdout="linux-key\n", stderr="")
        with patch.dict("os.environ", {"DISPLAY": ":0"}, clear=True), patch("jarvis_startup.sys.platform", "linux"), \
             patch("jarvis_startup.shutil.which", side_effect=lambda name: "/usr/bin/zenity" if name == "zenity" else None), \
             patch("jarvis_startup.subprocess.run", return_value=reply) as run, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(request_api_key(), "linux-key")
        self.assertIn("--password", str(run.call_args))


if __name__ == "__main__":
    unittest.main()
