import hashlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts import prepare_model


class ModelDownloadTests(unittest.TestCase):
    def test_checks_size_and_hash_before_using_a_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "model.onnx"
            path.write_bytes(b"good model")
            digest = hashlib.sha256(b"good model").hexdigest()
            self.assertTrue(prepare_model.valid_file(path, 10, digest))
            self.assertFalse(prepare_model.valid_file(path, 9, digest))
            self.assertFalse(prepare_model.valid_file(path, 10, "0" * 64))

    def test_corrupt_download_is_not_installed(self):
        with tempfile.TemporaryDirectory() as directory:
            data = b"verified"
            manifest = {"model.onnx": (len(data), hashlib.sha256(data).hexdigest())}
            with patch.object(prepare_model, "MODEL_DIR", Path(directory)), \
                 patch.object(prepare_model, "FILES", manifest), \
                 patch.object(prepare_model.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: io.BytesIO(b"corrupt!")), \
                 patch.object(prepare_model.time, "sleep"):
                with self.assertRaises(ValueError):
                    prepare_model.prepare()
            self.assertFalse((Path(directory) / "model.onnx").exists())
            self.assertFalse((Path(directory) / "model.onnx.part").exists())

    def test_verified_download_is_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            data = b"verified"
            manifest = {"model.onnx": (len(data), hashlib.sha256(data).hexdigest())}
            with patch.object(prepare_model, "MODEL_DIR", Path(directory)), \
                 patch.object(prepare_model, "FILES", manifest), \
                 patch.object(prepare_model.urllib.request, "urlopen", side_effect=lambda *args, **kwargs: io.BytesIO(data)) as download:
                prepare_model.prepare()
                prepare_model.prepare()
            self.assertEqual(download.call_count, 1)
            self.assertEqual((Path(directory) / "model.onnx").read_bytes(), data)


if __name__ == "__main__":
    unittest.main()
