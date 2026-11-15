"""HTTP, inference ownership and voicepack contracts without model downloads."""
import asyncio
import io
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
import soundfile as sf
import torch
import kokoro_server as server


class FakeModel:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.active = 0
        self.max_active = 0
        self.guard = threading.Lock()
        self.calls = []
        self.audio = np.full(240, 0.1, dtype=np.float32)

    def create(self, phonemes, **options):
        with self.guard:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.calls.append((phonemes, options))
        try:
            self.started.set()
            if not self.release.wait(5):
                raise RuntimeError("Fixture synthesis was not released")
            time.sleep(0.02)
            return self.audio, 24000
        finally:
            with self.guard:
                self.active -= 1


class FakeFrontend:
    def __init__(self, lang_code, **options):
        if options.get("model") is not False:
            raise AssertionError("A second speech model must never load")
        self.lang_code = lang_code

    def __call__(self, text, **options):
        yield SimpleNamespace(phonemes=f"phonemes:{self.lang_code}:{text}")


class KokoroServerTests(unittest.TestCase):
    def setUp(self):
        from fastapi.testclient import TestClient
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.model = FakeModel()
        self.stack.enter_context(patch.object(server, "detect_cuda_contention", return_value=None))
        self.stack.enter_context(patch.object(server, "load_model", return_value=self.model))
        self.stack.enter_context(patch.object(server, "KPipeline", side_effect=FakeFrontend))
        self.client = self.stack.enter_context(TestClient(server.app))

    def test_health_remains_responsive_during_inference(self):
        self.model.release.clear()
        with ThreadPoolExecutor(max_workers=2) as workers:
            synthesis = workers.submit(self.client.post, "/synthesize", json={"text": "Synthetic speech."})
            try:
                self.assertTrue(self.model.started.wait(5))
                health = workers.submit(self.client.get, "/health")
                response = health.result(timeout=2)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["engine"], "onnx")
                self.assertFalse(synthesis.done())
            finally:
                self.model.release.set()
            response = synthesis.result(timeout=5)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.content[:4], b"RIFF")

    def test_both_synthesis_routes_serialize_access_to_the_shared_model(self):
        with ThreadPoolExecutor(max_workers=2) as workers:
            calls = [workers.submit(self.client.post, route, json={"text": "Synthetic speech."})
                     for route in ["/synthesize", "/synthesize-default"]]
            for call in calls:
                self.assertEqual(call.result(timeout=5).status_code, 200)
        self.assertEqual(self.model.max_active, 1)

    def test_request_language_voice_speed_and_phonemes_reach_onnx(self):
        response = self.client.post("/synthesize", json={
            "text": "Synthetic speech.", "lang_code": "i", "voice": "im_nicola", "speed": 0.9,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.model.calls, [("phonemes:i:Synthetic speech.", {
            "voice": "im_nicola", "speed": 0.9, "is_phonemes": True,
            "trim": True, "sentence_pause": 0.2, "clause_pause": 0.08,
        })])
        samples, rate = sf.read(io.BytesIO(response.content))
        self.assertEqual(rate, 24000)
        self.assertGreater(np.abs(samples).max(), 0)

    def test_custom_pt_voicepacks_are_loaded_as_styles_and_normalized(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "voice.pt"
            torch.save(torch.ones((510, 1, 256)), filename)
            response = self.client.post("/synthesize", json={
                "text": "Synthetic speech.", "custom_voicepack": str(filename), "normalize": True,
            })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.model.calls[0][1]["voice"].shape, (510, 1, 256))
        samples, _ = sf.read(io.BytesIO(response.content))
        self.assertAlmostEqual(float(np.abs(samples).max()), 0.707, places=3)

    def test_missing_custom_voicepack_fails_instead_of_using_builtin_voice(self):
        response = self.client.post("/synthesize", json={
            "text": "Synthetic speech.", "custom_voicepack": "/missing/synthetic-voice.pt",
        })
        self.assertEqual(response.status_code, 500)
        self.assertIn("Synthesis failed", response.json()["detail"])
        self.assertEqual(self.model.calls, [])

    def test_invalid_custom_voicepack_and_nonfinite_audio_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / "voice.pt"
            torch.save(torch.ones(256), filename)
            response = self.client.post("/synthesize", json={
                "text": "Synthetic speech.", "custom_voicepack": str(filename),
            })
            self.assertEqual(response.status_code, 500)
            self.assertIn("voice styles", response.json()["detail"])
        self.model.audio = np.array([np.nan], dtype=np.float32)
        response = self.client.post("/synthesize", json={"text": "Synthetic speech."})
        self.assertEqual(response.status_code, 500)
        self.assertIn("invalid audio", response.json()["detail"])

    def test_inference_failure_is_visible_and_does_not_poison_next_request(self):
        with patch.object(self.model, "create", side_effect=RuntimeError("Synthetic inference failure")):
            response = self.client.post("/synthesize", json={"text": "Synthetic speech."})
            self.assertEqual(response.status_code, 500)
            self.assertIn("Synthetic inference failure", response.json()["detail"])
        self.assertEqual(self.client.post("/synthesize", json={"text": "Synthetic speech."}).status_code, 200)


class OnnxStartupTests(unittest.TestCase):
    def test_auto_mode_prefers_cuda_and_reports_cpu_fallback(self):
        with patch.object(server, "detect_cuda_contention", return_value=None), \
             patch.object(server, "load_model", return_value="gpu-model") as load:
            self.assertEqual(server.load_selected_model("auto"), ("gpu-model", "cuda", None))
        load.assert_called_once_with("cuda")

        def unavailable(device):
            if device == "cuda":
                raise RuntimeError("CUDAExecutionProvider unavailable")
            return "cpu-model"

        with patch.object(server, "detect_cuda_contention", return_value=None), \
             patch.object(server, "load_model", side_effect=unavailable) as load:
            self.assertEqual(server.load_selected_model("auto"), (
                "cpu-model", "cpu", "cuda_initialization_failed"))
        self.assertEqual([call.args[0] for call in load.call_args_list], ["cuda", "cpu"])

    def test_auto_mode_selects_cpu_without_cuda_init_when_gpu_is_contended(self):
        with patch.object(server, "detect_cuda_contention", return_value="cuda_training_active"), \
             patch.object(server, "load_model", return_value="cpu-model") as load:
            self.assertEqual(
                server.load_selected_model("auto"),
                ("cpu-model", "cpu", "cuda_training_active"),
            )
        load.assert_called_once_with("cpu")

    def test_explicit_cuda_ignores_auto_contention_probe(self):
        with patch.object(server, "detect_cuda_contention", return_value="cuda_training_active") as probe, \
             patch.object(server, "load_model", return_value="gpu-model") as load:
            self.assertEqual(server.load_selected_model("cuda"), ("gpu-model", "cuda", None))
        probe.assert_not_called()
        load.assert_called_once_with("cuda")

    def test_detect_cuda_contention_distinguishes_training_from_inference_and_vram_pressure(self):
        calls = []

        def fake_run(free_mib_line: str, proc_lines: str):
            def runner(cmd, **_kwargs):
                calls.append(list(cmd))
                if "--query-gpu=memory.free" in cmd:
                    return SimpleNamespace(stdout=free_mib_line)
                return SimpleNamespace(stdout=proc_lines)
            return runner

        # (a) High GPU utilization from llama-server / blender / depth_motion_worker does NOT downgrade CUDA,
        # and cuda_already_loaded=True spawns only 1 nvidia-smi subprocess (--query-compute-apps).
        cmdlines = {
            2001: "llama-server --model Qwen3.5-9B.gguf -ngl 99",
            2002: "/home/greggles/blender-5.0.0-linux-x64/blender front-shell-fixes.blend",
            2003: "/home/greggles/ComfyUI/venv/bin/python /home/greggles/Ainekio/Master/gateway/depth_motion_worker.py",
        }
        proc_table = (
            "1000, /home/greggles/metahuman/external/kokoro/venv/bin/python3\n"
            "2001, llama-server\n"
            "2002, /home/greggles/blender-5.0.0-linux-x64/blender\n"
            "2003, /home/greggles/ComfyUI/venv/bin/python"
        )
        calls.clear()
        with patch.object(server.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             patch.object(server.os, "getpid", return_value=1000), \
             patch.object(server, "_read_process_cmdline", side_effect=lambda pid: cmdlines.get(pid, "")), \
             patch.object(server.subprocess, "run", side_effect=fake_run("10240", proc_table)):
            self.assertIsNone(server.detect_cuda_contention(cuda_already_loaded=True))
            self.assertEqual(len(calls), 1)
            self.assertIn("--query-compute-apps=pid,process_name", calls[0])
            calls.clear()
            self.assertIsNone(server.detect_cuda_contention(cuda_already_loaded=False))
            self.assertEqual(len(calls), 2)

        # (b) Inference server inside a *-training-env venv (-m gateway.neural_gait.server) does NOT trigger training contention.
        gait_server_cmdline = "/home/greggles/Ainekio/build/gait-training-env/bin/python -m gateway.neural_gait.server --port 9910"
        with patch.object(server.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             patch.object(server.os, "getpid", return_value=1000), \
             patch.object(server, "_read_process_cmdline", return_value=gait_server_cmdline), \
             patch.object(
                 server.subprocess,
                 "run",
                 side_effect=fake_run("8192", "2010, /home/greggles/Ainekio/build/gait-training-env/bin/python"),
             ):
            self.assertIsNone(server.detect_cuda_contention(cuda_already_loaded=False))
            self.assertIsNone(server.detect_cuda_contention(cuda_already_loaded=True))

        # (c) Freestyle curriculum training in ComfyUI venv and neural_pose.trainer DO trigger cuda_training_active.
        curriculum_cmdline = "/home/greggles/ComfyUI/venv/bin/python -m experiments.freestyle.freestyle_curriculum --device cuda:0"
        calls.clear()
        with patch.object(server.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             patch.object(server.os, "getpid", return_value=1000), \
             patch.object(server, "_read_process_cmdline", return_value=curriculum_cmdline), \
             patch.object(
                 server.subprocess,
                 "run",
                 side_effect=fake_run("8192", "2020, /home/greggles/ComfyUI/venv/bin/python"),
             ):
            self.assertEqual(server.detect_cuda_contention(cuda_already_loaded=False), "cuda_training_active")
            self.assertEqual(server.detect_cuda_contention(cuda_already_loaded=True), "cuda_training_active")
            self.assertEqual(len(calls), 2)

        with patch.object(server.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             patch.object(server.os, "getpid", return_value=1000), \
             patch.object(server, "_read_process_cmdline", return_value="python -m experiments.freestyle.neural_pose.trainer"), \
             patch.object(
                 server.subprocess,
                 "run",
                 side_effect=fake_run("8192", "2021, /opt/microduck-training-env/bin/python"),
             ):
            self.assertEqual(server.detect_cuda_contention(cuda_already_loaded=True), "cuda_training_active")

        # Startup VRAM pressure (< 2560 MiB) selects CPU before CUDA loads, without downgrading an already-allocated CUDA session.
        with patch.object(server.shutil, "which", return_value="/usr/bin/nvidia-smi"), \
             patch.object(server.os, "getpid", return_value=1000), \
             patch.object(server, "_read_process_cmdline", return_value="llama-server"), \
             patch.object(server.subprocess, "run", side_effect=fake_run("1800", "2001, llama-server")):
            self.assertEqual(server.detect_cuda_contention(cuda_already_loaded=False), "cuda_memory_pressure")
            self.assertIsNone(server.detect_cuda_contention(cuda_already_loaded=True))

    def test_unavailable_cuda_is_not_silently_replaced_with_cpu(self):
        with patch.object(server.ort, "get_available_providers", return_value=["CPUExecutionProvider"]):
            with self.assertRaisesRegex(RuntimeError, "CUDAExecutionProvider"):
                server.load_model("cuda")

    def test_session_fallback_is_rejected(self):
        session = Mock()
        session.get_providers.return_value = ["CPUExecutionProvider"]
        with patch.object(server.ort, "get_available_providers", return_value=["CUDAExecutionProvider"]), \
             patch.object(Path, "is_file", return_value=True), \
             patch.object(server.ort, "InferenceSession", return_value=session):
            with self.assertRaisesRegex(RuntimeError, "could not activate"):
                server.load_model("cuda")

    def test_cpu_session_uses_bounded_threads_without_spinning_or_runtime_fallback(self):
        session = Mock()
        session.get_providers.return_value = ["CPUExecutionProvider"]
        with patch.dict("os.environ", {"OMP_NUM_THREADS": "2"}), \
             patch.object(Path, "is_file", return_value=True), \
             patch.object(server.ort, "InferenceSession", return_value=session) as factory, \
             patch.object(server.Kokoro, "from_session", return_value="onnx-model"):
            self.assertEqual(server.load_model("cpu"), "onnx-model")
        options = factory.call_args.kwargs["sess_options"]
        self.assertEqual(options.intra_op_num_threads, 2)
        self.assertEqual(options.inter_op_num_threads, 1)
        self.assertEqual(options.get_session_config_entry("session.intra_op.allow_spinning"), "0")
        self.assertEqual(options.get_session_config_entry("session.inter_op.allow_spinning"), "0")
        session.disable_fallback.assert_called_once()


class AutoDeviceTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.previous = (
            server.pipeline, server.model, server.cuda_model, server.cpu_model,
            server.cuda_permanently_disabled, server.requested_device,
            server.processing_device, server.fallback_reason,
        )
        self.addCleanup(self.restore_state)
        self.stack.enter_context(patch.object(server, "detect_cuda_contention", return_value=None))
        server.pipeline = FakeFrontend("a", model=False)
        server.cuda_model = None
        server.cpu_model = None
        server.cuda_permanently_disabled = False
        server.requested_device = "auto"
        server.processing_device = "cuda"
        server.fallback_reason = None

    def restore_state(self):
        (server.pipeline, server.model, server.cuda_model, server.cpu_model,
         server.cuda_permanently_disabled, server.requested_device,
         server.processing_device, server.fallback_reason) = self.previous

    def test_cuda_inference_failure_switches_to_cpu_for_later_requests(self):
        gpu = Mock()
        gpu.create.side_effect = RuntimeError("CUDA out of memory")
        cpu = Mock()
        cpu.create.return_value = (np.full(240, 0.1, dtype=np.float32), 24000)
        server.model = gpu

        with patch.object(server, "load_model", return_value=cpu) as load:
            first = server.render_speech("First.", lang_code="a", voice="af_heart", speed=1,
                                         custom_voicepack=None, normalize=False)
            second = server.render_speech("Second.", lang_code="a", voice="af_heart", speed=1,
                                          custom_voicepack=None, normalize=False)
        self.assertEqual(first[:4], b"RIFF")
        self.assertEqual(second[:4], b"RIFF")
        load.assert_called_once_with("cpu")
        gpu.create.assert_called_once()
        self.assertEqual(cpu.create.call_count, 2)
        health = asyncio.run(server.health())
        self.assertEqual(health["requested_device"], "auto")
        self.assertEqual(health["device"], "cpu")
        self.assertEqual(health["fallback_reason"], "cuda_inference_failed")

    def test_auto_mode_routes_to_cpu_during_training_and_resumes_cuda_after_training_exits(self):
        gpu = Mock()
        gpu.create.return_value = (np.full(240, 0.2, dtype=np.float32), 24000)
        cpu = Mock()
        cpu.create.return_value = (np.full(240, 0.1, dtype=np.float32), 24000)
        server.model = gpu

        contention_sequence = ["cuda_training_active", "cuda_training_active", None]
        with patch.object(server, "detect_cuda_contention", side_effect=contention_sequence) as probe, \
             patch.object(server, "load_model", return_value=cpu) as load:
            first = server.render_speech("During training 1.", lang_code="a", voice="af_heart", speed=1,
                                         custom_voicepack=None, normalize=False)
            health_during = asyncio.run(server.health())
            second = server.render_speech("During training 2.", lang_code="a", voice="af_heart", speed=1,
                                          custom_voicepack=None, normalize=False)
            third = server.render_speech("After training.", lang_code="a", voice="af_heart", speed=1,
                                         custom_voicepack=None, normalize=False)
            health_after = asyncio.run(server.health())

        self.assertEqual(first[:4], b"RIFF")
        self.assertEqual(second[:4], b"RIFF")
        self.assertEqual(third[:4], b"RIFF")
        self.assertEqual(probe.call_count, 3)
        for call in probe.call_args_list:
            self.assertEqual(call.kwargs, {"cuda_already_loaded": True})
        load.assert_called_once_with("cpu")
        self.assertEqual(cpu.create.call_count, 2)
        gpu.create.assert_called_once()
        self.assertEqual(health_during["device"], "cpu")
        self.assertEqual(health_during["fallback_reason"], "cuda_training_active")
        self.assertEqual(health_after["device"], "cuda")
        self.assertIsNone(health_after["fallback_reason"])

    def test_auto_mode_started_on_cpu_during_training_promotes_to_cuda_when_training_exits(self):
        cpu = Mock()
        cpu.create.return_value = (np.full(240, 0.1, dtype=np.float32), 24000)
        gpu = Mock()
        gpu.create.return_value = (np.full(240, 0.2, dtype=np.float32), 24000)
        server.model = cpu
        server.cpu_model = cpu
        server.cuda_model = None
        server.processing_device = "cpu"
        server.fallback_reason = "cuda_training_active"

        with patch.object(server, "detect_cuda_contention", side_effect=["cuda_training_active", None]) as probe, \
             patch.object(server, "load_model", return_value=gpu) as load:
            server.render_speech("Still training.", lang_code="a", voice="af_heart", speed=1,
                                 custom_voicepack=None, normalize=False)
            server.render_speech("Training finished.", lang_code="a", voice="af_heart", speed=1,
                                 custom_voicepack=None, normalize=False)

        self.assertEqual(probe.call_count, 2)
        self.assertEqual(probe.call_args_list[0].kwargs, {"cuda_already_loaded": False})
        self.assertEqual(probe.call_args_list[1].kwargs, {"cuda_already_loaded": False})
        load.assert_called_once_with("cuda")
        cpu.create.assert_called_once()
        gpu.create.assert_called_once()
        health = asyncio.run(server.health())
        self.assertEqual(health["device"], "cuda")
        self.assertIsNone(health["fallback_reason"])

    def test_non_cuda_failure_remains_visible(self):
        server.model = Mock()
        server.model.create.side_effect = RuntimeError("Invalid voice")

        with patch.object(server, "load_model") as load:
            with self.assertRaisesRegex(RuntimeError, "Invalid voice"):
                server.render_speech("Hello.", lang_code="a", voice="af_heart", speed=1,
                                     custom_voicepack=None, normalize=False)
        load.assert_not_called()
        self.assertEqual(server.processing_device, "cuda")


if __name__ == "__main__":
    unittest.main()
