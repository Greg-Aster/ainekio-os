import io
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from fastapi import UploadFile
import whisper_server


class TranscriptionHintsTest(unittest.IsolatedAsyncioTestCase):
    async def test_name_hint_reaches_recognizer_without_rewriting_result(self):
        for hotwords in (None, "Ainekio", "A name with 'quotes' and Unicode: Écho"):
            with self.subTest(hotwords=hotwords):
                model = Mock()
                model.transcribe.return_value = (
                    iter([SimpleNamespace(text="And next year.")]),
                    SimpleNamespace(language="en", language_probability=1, duration=1),
                )
                with patch.object(whisper_server, "model", model), patch.object(whisper_server, "model_ready", True):
                    response = await whisper_server.transcribe(
                        UploadFile(io.BytesIO(b"fixture audio"), filename="audio.wav"),
                        language="en", hotwords=hotwords,
                    )
                self.assertEqual(model.transcribe.call_args.kwargs["hotwords"], hotwords)
                self.assertEqual(json.loads(response.body)["text"], "And next year.")


if __name__ == "__main__":
    unittest.main()
