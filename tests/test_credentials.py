from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import jarvis_credentials as credentials


class CredentialTests(unittest.TestCase):
    def test_linux_sends_key_through_stdin_not_process_arguments(self):
        secret = "fake-secret-for-test"
        def command(args, *, input_text=None):
            self.assertNotIn(secret, args)
            if "store" in args:
                self.assertEqual(input_text, secret)
                return subprocess.CompletedProcess(args, 0, stdout="", stderr="")
            return subprocess.CompletedProcess(args, 0, stdout=secret + "\n", stderr="")
        with patch.object(credentials.sys, "platform", "linux"), \
             patch.object(credentials, "_linux_tool", return_value="secret-tool"), \
             patch.object(credentials, "_command", side_effect=command):
            self.assertTrue(credentials.save_key(secret))

    def test_mac_key_is_written_via_stdin_and_verified(self):
        secret = "fake-secret-for-test"
        calls = []
        def command(args, *, input_text=None):
            calls.append((args, input_text))
            self.assertNotIn(secret, args)
            return subprocess.CompletedProcess(args, 0, stdout=secret + "\n" if "find-generic-password" in args else "", stderr="")
        with patch.object(credentials.sys, "platform", "darwin"), \
             patch.object(credentials, "_command", side_effect=command):
            self.assertTrue(credentials.save_key(secret))
        self.assertEqual(calls[0][0], ["security", "-i"])
        self.assertIn(secret, calls[0][1])

    def test_failed_readback_does_not_claim_storage_succeeded(self):
        with patch.object(credentials, "_backend", side_effect=lambda op: (lambda *args: None)):
            self.assertFalse(credentials.save_key("fake-secret"))

    def test_missing_secret_service_falls_back_gracefully(self):
        with patch.object(credentials.sys, "platform", "linux"), patch.object(credentials.shutil, "which", return_value=None):
            self.assertIsNone(credentials.load_key())
            self.assertFalse(credentials.save_key("fake-secret"))


if __name__ == "__main__":
    unittest.main()
