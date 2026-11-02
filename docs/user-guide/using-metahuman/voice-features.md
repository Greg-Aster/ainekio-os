# Voice Features

MetaHuman OS supports microphone transcription, conversational speech synthesis, voice-asset collection, and selected voice-cloning workflows. These are separate stages with separate owners.

## Open Voice

Select **Voice** in the left sidebar. The page has:

- **Voice Settings** for speech-to-text, text-to-speech, provider, device, voice, speed, and voice-activity settings.
- **Voice Clone Training** for supported dataset, reference, export, and training workflows.

Save settings before testing a provider.

Voice preferences and the audio cache belong to the selected profile. A complete
profile voice configuration works without a global `etc/voice.json`; if that
installation defaults file exists, profile settings override it. Missing or
invalid configuration is reported as an error. Shared Kokoro/Whisper process and
device settings remain in `etc/voice-servers.json`.

## Providers and Roles

- **Whisper** transcribes microphone audio for the Site. The maintained React
  Native shell may use device-native speech recognition instead.
- **Piper** synthesizes speech from an installed ONNX voice.
- **Kokoro** synthesizes speech with installed or imported voicepacks.
- **RVC** converts Piper-generated speech with a trained profile model.

Whisper and Kokoro use the shared voice-service lifecycle. RVC conversion runs on demand and does not have a second MetaHuman RVC server.

## Start and Check Shared Voice Services

```bash
./bin/mh voice-server status --all
./bin/mh voice-server start whisper
./bin/mh voice-server start kokoro
./bin/mh voice-server stop --all
```

The optional `--boot` flag on `voice-server start` starts only services enabled for system boot in `etc/voice-servers.json`.

## Use Voice Chat

In Chat:

- tap the microphone for a single recording and review its transcript before sending;
- long-press or right-click to toggle continuous conversation listening;
- enable the speaker control to request TTS for conversational replies.

The complete path is:

1. Site browser microphone capture;
2. managed Whisper transcription;
3. normal chat submission and model response;
4. TTS synthesis;
5. TTS queue delivery;
6. authenticated browser playback.

Check each stage independently. HTTP success from a speech provider proves synthesis only; it does not prove queue consumption or audible playback.

On the maintained React Native shell, the input side may use native device
speech recognition. The normal chat and response paths remain separate from
that platform-specific transcription step.

## Configure and Test a Provider

### Piper

Piper requires its executable, an `.onnx` model, and the matching model configuration. It is also the base synthesizer used by the RVC conversion path.

### Kokoro

```bash
./bin/mh kokoro status
./bin/mh kokoro voices
./bin/mh kokoro test --text "Hello"
```

MetaHuman OS supports Kokoro synthesis and voice selection. It does not provide a maintained custom Kokoro voicepack trainer.

Chat and the Kokoro voice preview play the first short phrase as soon as it is
generated. Later phrases buffer on the same browser audio timeline while the
server continues synthesizing. Previews use the same speech text cleanup as chat
and no longer append a timestamp. Playback completion and interruption use audio/stream events,
not a polling timer.

This reduces the wait before speech starts. It cannot prevent pauses when CPU
synthesis produces later phrases more slowly than they can be spoken; a larger
initial buffer would trade a longer startup wait for fewer pauses.

The managed server uses [Kokoro ONNX](https://github.com/thewh1teagle/kokoro-onnx)
with the full v1.0 model and voice bundle. Install or update it with
`./bin/install-kokoro.sh --yes`. Model downloads are verified with SHA-256 and
stored under ignored `external/kokoro/models/`. Pronunciation uses the existing
Kokoro/Misaki frontend without loading its PyTorch speech model. PyTorch remains
installed to support that frontend and read imported `.pt` voicepack tensors.

CPU is the default. NVIDIA CUDA requires installation with `--device cuda` and
working CUDA/cuDNN libraries, followed by selecting CUDA through the existing
voice-server controls. An unavailable requested provider fails visibly. The device
selector does not enable a Qualcomm NPU.

ONNX inference uses two CPU threads by default, sequential execution, and no
spinning while idle. Override the thread count through the existing local, ignored
`.env` loaded by `./start.sh`, for example:

```dotenv
OMP_NUM_THREADS=2
```

Restart MetaHuman to apply this to its managed process. This is an installation
setting, not a profile preference or a guarantee of faster speech. Cooling, core
layout, and other workloads affect latency. The language selector chooses the
pronunciation language explicitly; `a` means American English, not auto-detection.
Missing or malformed imported voicepacks fail instead of selecting another voice.

### RVC

```bash
./bin/mh rvc status --name MODEL_NAME
./bin/mh rvc train --name MODEL_NAME --device cuda
```

RVC requires Applio, Piper, an exported dataset, and enough local compute and storage for training. Choose the appropriate device for the installation.

## Voice Samples and Exports

The profile-owned sample commands are:

```bash
./bin/mh voice status
./bin/mh voice list
./bin/mh voice delete SAMPLE_ID
./bin/mh voice export
```

`voice export` prepares a dataset; it is not proof that a model was trained. Use the maintained RVC workflow described in [Voice Training](/user-guide#voice-training).

## Diagnose Failures

### No transcript

Check browser microphone permission, input device, audio level, and Whisper status.

### Text response but no sound

Check the selected TTS provider, its required artifacts, Queue state, browser autoplay/audio permission, and the active output device.

### Wrong voice

Confirm the active profile, selected provider, selected voice or model, and whether a provider-specific fallback is enabled. Fallbacks should be visible in configuration; do not assume the requested provider produced the audio.

### Training does not start

Confirm that the selected training path is supported, its addon is installed, the dataset exists, and the device has sufficient resources. Kokoro and Piper synthesis support must not be read as built-in custom training support.

## Runtime Data

Recordings, transcripts, datasets, reference audio, model weights, caches, logs, and generated audio are private runtime data. Keep them outside maintained source and do not commit them.

## Related Guides

- [Chat](/user-guide#chat-interface)
- [Voice Training](/user-guide#voice-training)
- [AI Training and Audio Data](/user-guide#ai-training)
- [Troubleshooting](/user-guide#troubleshooting)
