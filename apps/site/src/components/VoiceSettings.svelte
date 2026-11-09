<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { useTTS } from '../lib/client/composables/useTTS';
  import { calculateVoiceVolume } from '../lib/client/utils/audio-utils.js';
  import { apiFetch } from '../lib/client/api-config';

  interface PiperVoice {
    id: string;
    name: string;
    language: string;
    quality: string;
    modelPath: string;
    configPath: string;
  }

  interface KokoroVoice {
    id: string;
    name: string;
    lang: string;
    gender: string;
    quality: string;
    isCustom?: boolean;
    voicepackPath?: string;
  }

  interface VoiceConfig {
    systemVoiceControl?: {
      canConfigureDevices: boolean;
      kokoroDeviceLockedByEnvironment: boolean;
      whisperDeviceLockedByEnvironment: boolean;
      kokoroActiveDevice?: 'cpu' | 'cuda' | null;
      kokoroFallbackReason?: string | null;
    };
    provider: 'piper' | 'kokoro';
    outputTarget: 'local' | 'robot';
    piper?: {
      voices: PiperVoice[];
      currentVoice: string;
      speakingRate: number;
    };
    kokoro?: {
      langCode: string;
      voice: string;
      speed: number;
      autoFallbackToPiper: boolean;
      normalizeCustomVoicepacks?: boolean;
      voices?: KokoroVoice[];
      device?: 'cuda' | 'cpu' | 'auto';
    };
    stt?: {
      model: string;
      device: 'cpu' | 'cuda';
      computeType: 'int8' | 'float16' | 'float32';
      language: string;
      useServer: boolean;
      vad: {
        voiceThreshold: number;
        silenceDelay: number;
        minDuration: number;
      };
    };
  }

  let config: VoiceConfig | null = null;
  let loading = true;
  let saving = false;
  let error: string | null = null;
  let successMessage: string | null = null;
  let testText = 'Hello! This is a test of the text to speech system.';
  const ttsApi = useTTS();
  let previewRequestId: string | null = null;
  let testingVoice = false;

  let hardwareButtonsEnabled = false;

  let vadTestRecording = false;
  let vadTestVolume = 0;
  let vadTestSpeaking = false;
  let vadTestTranscription = '';
  let vadTestError: string | null = null;
  interface VADCapture {
    controller: AbortController;
    chunks: Blob[];
    startedAt: number;
    recorder?: MediaRecorder;
    stream?: MediaStream;
    context?: AudioContext;
    analyser?: AnalyserNode;
    frame?: number;
    silenceTimer?: number;
  }
  let vadCapture: VADCapture | null = null;

  const providerInfo = {
    piper: {
      name: 'Piper TTS',
      icon: '🎙️',
      description: 'Fast, neural text-to-speech with multiple voice models',
      color: '#3b82f6',
    },
    kokoro: {
      name: 'Kokoro TTS',
      icon: '🫀',
      description: 'Multilingual synthesis with built-in and imported voicepacks',
      color: '#f59e0b',
    },
  };

  type Provider = keyof typeof providerInfo;
  type ProviderInfo = (typeof providerInfo)[Provider];
  const providerEntries = Object.entries(providerInfo) as [Provider, ProviderInfo][];

  async function loadSettings() {
    try {
      loading = true;
      hardwareButtonsEnabled = localStorage.getItem('mh-hardware-buttons') === 'true';

      const response = await apiFetch('/api/voice-settings');
      if (!response.ok) throw new Error('Failed to load voice settings');
      config = await response.json();

      error = null;
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  async function saveSettings() {
    try {
      saving = true;
      successMessage = null;
      error = null;
      const settings = config?.kokoro ? {
        ...config,
        kokoro: { ...config.kokoro, useCustomVoicepack: config.kokoro.voice.startsWith('custom_') },
      } : config;

      const response = await apiFetch('/api/voice-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Failed to save settings');
      }

      if (config?.kokoro && (result.kokoroDevice === 'cpu' || result.kokoroDevice === 'cuda' || result.kokoroDevice === 'auto')) {
        config.kokoro.device = result.kokoroDevice;
      }
      if (config?.systemVoiceControl) {
        config.systemVoiceControl.kokoroActiveDevice = result.kokoroActiveDevice === 'cpu' || result.kokoroActiveDevice === 'cuda'
          ? result.kokoroActiveDevice
          : null;
        config.systemVoiceControl.kokoroFallbackReason = typeof result.kokoroFallbackReason === 'string'
          ? result.kokoroFallbackReason
          : null;
      }
      if (config?.stt && (result.whisperDevice === 'cpu' || result.whisperDevice === 'cuda')) {
        config.stt.device = result.whisperDevice;
        if (result.whisperComputeType === 'int8' || result.whisperComputeType === 'float16' || result.whisperComputeType === 'float32') {
          config.stt.computeType = result.whisperComputeType;
        }
      }

      successMessage = result.message || 'Settings saved successfully!';
      window.dispatchEvent(new CustomEvent('voice-settings-updated'));
      return true;
    } catch (e) {
      if (!error) error = String(e);
      return false;
    } finally {
      saving = false;
    }
  }

  async function testVoice(forceProvider?: Provider) {
    if (!config) return;
    const provider = forceProvider || config.provider;
    if (previewRequestId) ttsApi.interruptPlaybackRequest(previewRequestId, 'superseded');
    const requestId = `voice-preview-${crypto.randomUUID()}`;
    previewRequestId = requestId;
    testingVoice = true;
    error = null;
    successMessage = null;
    try {
      const options: Parameters<typeof ttsApi.speak>[1] = {
        streaming: provider === 'kokoro', provider, requestId,
      };
      if (provider === 'piper' && config.piper) {
        const piper = config.piper;
        const voice = piper.voices.find(v => v.id === piper.currentVoice);
        if (!voice) throw new Error('Please select a voice');
        options.voice = voice.modelPath;
        options.speed = config.piper.speakingRate;
      } else if (provider === 'kokoro' && config.kokoro) {
        if (config.kokoro.voice.startsWith('custom_')) {
          if (!await saveSettings()) return;
        } else {
          options.voice = config.kokoro.voice;
        }
        options.langCode = config.kokoro.langCode;
        options.speed = config.kokoro.speed;
      }
      if (previewRequestId !== requestId) return;
      const outcome = await ttsApi.speak(testText, options);
      if (outcome === 'failed') throw new Error('Speech preview failed. See the server and browser logs for details.');
    } catch (e) {
      if (previewRequestId === requestId) error = String(e);
    } finally {
      if (previewRequestId === requestId) {
        previewRequestId = null;
        testingVoice = false;
      }
    }
  }

  function switchProvider(newProvider: Provider) {
    if (config) {
      config = { ...config, provider: newProvider };
    }
  }

  async function startVADTest() {
    if (!config?.stt?.vad) return;
    const vad = config.stt.vad;
    cancelVADTest();
    const capture: VADCapture = { controller: new AbortController(), chunks: [], startedAt: Date.now() };
    vadCapture = capture;
    try {
      vadTestError = null;
      vadTestTranscription = '';
      vadTestSpeaking = false;
      vadTestVolume = 0;
      capture.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      capture.controller.signal.throwIfAborted();
      capture.context = new AudioContext();
      const source = capture.context.createMediaStreamSource(capture.stream);
      capture.analyser = capture.context.createAnalyser();
      capture.analyser.fftSize = 2048;
      capture.analyser.smoothingTimeConstant = 0.8;
      source.connect(capture.analyser);

      capture.recorder = new MediaRecorder(capture.stream, { mimeType: 'audio/webm' });
      capture.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) capture.chunks.push(e.data);
      };
      capture.recorder.onerror = (event) => {
        if (capture.controller.signal.aborted) return;
        vadTestError = (event as Event & { error?: Error }).error?.message || 'Microphone recording failed';
        cancelVADTest();
      };
      capture.recorder.start();
      vadTestRecording = true;
      capture.startedAt = Date.now();
      runVADAnalysis(capture, vad);
    } catch (err) {
      if (!capture.controller.signal.aborted) vadTestError = `Failed to start recording: ${(err as Error).message}`;
      capture.controller.abort();
      releaseVADResources(capture);
      if (vadCapture === capture) {
        vadCapture = null;
        vadTestRecording = false;
      }
    }
  }

  function runVADAnalysis(capture: VADCapture, vad: NonNullable<VoiceConfig['stt']>['vad']) {
    const tick = () => {
      if (!vadTestRecording || capture.controller.signal.aborted || !capture.analyser) return;
      vadTestVolume = calculateVoiceVolume(capture.analyser, 150);
      if (vadTestVolume > vad.voiceThreshold) {
        if (!vadTestSpeaking) vadTestSpeaking = true;
        if (capture.silenceTimer !== undefined) {
          clearTimeout(capture.silenceTimer);
          capture.silenceTimer = undefined;
        }
      } else if (vadTestSpeaking && capture.silenceTimer === undefined) {
        capture.silenceTimer = window.setTimeout(() => { void stopVADTest(capture, vad); }, vad.silenceDelay);
      }
      capture.frame = requestAnimationFrame(tick);
    };
    capture.frame = requestAnimationFrame(tick);
  }

  async function stopVADTest(capture: VADCapture, vad: NonNullable<VoiceConfig['stt']>['vad']) {
    const recorder = capture.recorder;
    if (!recorder || capture.controller.signal.aborted) return;
    capture.recorder = undefined;
    try {
      vadTestRecording = false;
      vadTestSpeaking = false;

      const duration = Date.now() - capture.startedAt;
      if (duration < vad.minDuration) {
        vadTestError = `Recording too short (${duration}ms). Minimum: ${vad.minDuration}ms`;
        if (recorder.state !== 'inactive') recorder.stop();
        return;
      }

      const audioBlob = await new Promise<Blob>((resolve, reject) => {
        const finish = () => {
          if (capture.chunks.length === 0) {
            reject(new Error('No audio data recorded'));
            return;
          }
          resolve(new Blob(capture.chunks, { type: 'audio/webm' }));
        };
        recorder.onstop = finish;
        recorder.onerror = (event) => reject((event as Event & { error?: Error }).error || new Error('Microphone recording failed'));
        if (recorder.state !== 'inactive') recorder.stop();
        else finish();
      });
      releaseVADResources(capture);
      capture.controller.signal.throwIfAborted();
      vadTestTranscription = 'Transcribing...';
      const buf = await audioBlob.arrayBuffer();
      capture.controller.signal.throwIfAborted();

      const response = await apiFetch('/api/stt?format=webm', {
        method: 'POST',
        body: buf,
        signal: capture.controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`STT failed: ${response.status} - ${errorBody}`);
      }

      const result = await response.json();
      capture.controller.signal.throwIfAborted();
      vadTestTranscription = result.transcript || result.text || '(no speech detected)';
    } catch (err) {
      if (!capture.controller.signal.aborted) {
        vadTestError = (err as Error).message;
        vadTestTranscription = '';
      }
    } finally {
      capture.controller.abort();
      releaseVADResources(capture);
      if (vadCapture === capture) {
        vadCapture = null;
        vadTestRecording = false;
        vadTestSpeaking = false;
        vadTestVolume = 0;
      }
    }
  }

  function releaseVADResources(capture: VADCapture) {
    if (capture.frame !== undefined) {
      cancelAnimationFrame(capture.frame);
      capture.frame = undefined;
    }
    if (capture.silenceTimer !== undefined) {
      clearTimeout(capture.silenceTimer);
      capture.silenceTimer = undefined;
    }
    const recorder = capture.recorder;
    capture.recorder = undefined;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    const stream = capture.stream;
    capture.stream = undefined;
    stream?.getTracks().forEach(track => track.stop());
    const context = capture.context;
    capture.context = undefined;
    capture.analyser = undefined;
    if (context) void context.close().catch(error => console.error('[VoiceSettings] Failed to close VAD audio context:', error));
  }

  function cancelVADTest() {
    const capture = vadCapture;
    vadCapture = null;
    capture?.controller.abort();
    if (capture) releaseVADResources(capture);
    vadTestRecording = false;
    vadTestSpeaking = false;
    vadTestVolume = 0;
    vadTestTranscription = '';
  }

  onMount(loadSettings);
  onDestroy(() => {
    cancelVADTest();
    if (previewRequestId) ttsApi.interruptPlaybackRequest(previewRequestId, 'cleanup');
    previewRequestId = null;
  });
</script>

<div class="p-6 max-w-[800px]">
  <h3 class="text-2xl font-semibold text-gray-800 dark:text-gray-100 m-0 mb-6">🎙️ Voice Settings</h3>
  <p class="mb-6 text-sm text-gray-500 dark:text-gray-400">
    Manage shared Kokoro and Whisper services in
    <a href="#view=voice&sidebar=servers" class="text-violet-600 dark:text-violet-400 underline">Server Status</a>.
  </p>

  {#if loading}
    <div class="py-8 text-center text-gray-500">Loading voice settings...</div>
  {:else if error && !config}
    <div class="p-3 bg-red-100 dark:bg-red-500/10 border border-red-500 rounded-lg text-red-600 dark:text-red-400 mb-4">{error}</div>
    <button class="btn btn-secondary" on:click={loadSettings}>Retry</button>
  {:else if config}
    {#if error}
      <div class="banner banner-error mb-4">{error}</div>
    {/if}
    {#if successMessage}
      <div class="p-3 bg-green-100 dark:bg-green-500/10 border border-emerald-500 rounded-lg text-emerald-600 dark:text-emerald-400 mb-4">{successMessage}</div>
    {/if}

    <div class="mb-6">
      <label for="speech-output-target" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Speech output</label>
      <select id="speech-output-target" bind:value={config.outputTarget} disabled={saving} class="select-field">
        <option value="local">Browser</option>
        <option value="robot">Body Control</option>
      </select>
      <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
        The chat header cycles between Off, Browser, and Body Control. Body Control selects its robot or computer speaker in its Audio settings.
      </p>
    </div>

    <!-- Provider Selection -->
    <div class="mb-6">
      <div class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Voice Provider</div>
      <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
        {#each providerEntries as [key, info]}
          <button
            class="p-5 border-2 rounded-xl bg-white dark:bg-gray-800 cursor-pointer transition-all text-center hover:translate-y-[-2px] hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed {config.provider === key ? 'bg-gradient-to-br from-violet-500/15 dark:from-violet-500/25' : 'border-gray-200 dark:border-gray-700'}"
            style="border-color: {config.provider === key ? info.color : ''}"
            on:click={() => switchProvider(key)}
            disabled={saving}
          >
            <div class="text-3xl mb-2">{info.icon}</div>
            <div class="font-semibold text-gray-800 dark:text-gray-100 mb-1">{info.name}</div>
            <div class="text-xs text-gray-500 dark:text-gray-400">{info.description}</div>
          </button>
        {/each}
      </div>
    </div>

    <!-- Provider-Specific Settings -->
    {#if config.provider === 'piper' && config.piper}
      <div class="bg-gray-50 dark:bg-gray-900 rounded-xl p-6 mb-6">
        <h4 class="m-0 mb-4 text-lg text-gray-800 dark:text-gray-100">Piper Settings</h4>

        <div class="mb-6">
          <label for="piper-voice" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Voice Model</label>
          <select id="piper-voice" bind:value={config.piper.currentVoice} disabled={saving} class="select-field">
            {#each config.piper.voices as voice}
              <option value={voice.id}>{voice.name} ({voice.language})</option>
            {/each}
          </select>
        </div>

        <div class="mb-6">
          <label for="piper-rate" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">
            Speaking Rate: {config.piper.speakingRate.toFixed(2)}x
          </label>
          <input id="piper-rate" type="range" min="0.5" max="2.0" step="0.05" bind:value={config.piper.speakingRate} disabled={saving} class="range-slider" />
          <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
            <span>Slower</span><span>Normal</span><span>Faster</span>
          </div>
        </div>

        <div class="mt-6 pt-6 border-t-2 border-gray-200 dark:border-gray-700">
          <label for="piper-test-text" class="block text-[0.95rem] font-semibold text-gray-800 dark:text-gray-100 mb-2">Test Piper Voice</label>
          <textarea id="piper-test-text" bind:value={testText} rows="2" placeholder="Enter text to test Piper..." disabled={testingVoice || saving} class="input-field"></textarea>
          <button class="w-full py-3 px-6 border-none rounded-lg font-semibold cursor-pointer transition-all mt-3 bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={() => testVoice('piper')} disabled={testingVoice || saving}>
            {testingVoice ? '🔊 Playing...' : '▶️ Test Piper'}
          </button>
        </div>
      </div>

    {:else if config.provider === 'kokoro' && config.kokoro}
      <div class="bg-gray-50 dark:bg-gray-900 rounded-xl p-6 mb-6">
        <h4 class="m-0 mb-4 text-lg text-gray-800 dark:text-gray-100">Kokoro ONNX Settings</h4>

        <div class="mb-6">
          <label for="kokoro-voice" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Voice</label>
          <select id="kokoro-voice" bind:value={config.kokoro.voice} disabled={saving} class="select-field">
            {#if config.kokoro.voices && config.kokoro.voices.length > 0}
              <optgroup label="Built-in Voices">
                {#each config.kokoro.voices.filter(v => !v.isCustom) as voice}
                  <option value={voice.id}>{voice.name} ({voice.lang}, {voice.gender}, {voice.quality})</option>
                {/each}
              </optgroup>
              {#if config.kokoro.voices.some(v => v.isCustom)}
                <optgroup label="Custom Voicepacks">
                  {#each config.kokoro.voices.filter(v => v.isCustom) as voice}
                    <option value={voice.id}>{voice.name}</option>
                  {/each}
                </optgroup>
              {/if}
            {:else}
              <option value="af_heart">Heart (English, Female, High)</option>
              <option value="af_bella">Bella (English, Female, High)</option>
              <option value="af_sarah">Sarah (English, Female, High)</option>
              <option value="am_adam">Adam (English, Male, High)</option>
              <option value="am_michael">Michael (English, Male, High)</option>
            {/if}
          </select>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {#if config.kokoro.voices?.some(v => v.isCustom)}
              Choose a built-in voice or an imported voicepack
            {:else}
              Choose from the installed multilingual voices
            {/if}
          </p>
        </div>

        <div class="mb-6">
          <label for="kokoro-lang" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Language Code</label>
          <select id="kokoro-lang" bind:value={config.kokoro.langCode} disabled={saving} class="select-field">
            <option value="a">American English</option>
            <option value="b">British English</option>
            <option value="j">Japanese</option>
            <option value="z">Mandarin Chinese</option>
            <option value="e">Spanish</option>
            <option value="f">French</option>
            <option value="h">Hindi</option>
            <option value="i">Italian</option>
            <option value="p">Brazilian Portuguese</option>
          </select>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Choose the language of the text. Voice and pronunciation language are separate settings.</p>
        </div>

        <div class="mb-6">
          <label for="kokoro-speed" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Speed: {config.kokoro.speed.toFixed(2)}x</label>
          <input id="kokoro-speed" type="range" min="0.5" max="2.0" step="0.05" bind:value={config.kokoro.speed} disabled={saving} class="range-slider" />
          <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
            <span>Slower</span><span>Normal</span><span>Faster</span>
          </div>
        </div>

        <div class="mb-6">
          <label for="kokoro-device" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Device for Inference</label>
          <select
            id="kokoro-device"
            bind:value={config.kokoro.device}
            disabled={saving || !config.systemVoiceControl?.canConfigureDevices || config.systemVoiceControl?.kokoroDeviceLockedByEnvironment}
            class="select-field"
          >
            <option value="cpu">CPU - Fast & no GPU conflicts</option>
            <option value="cuda">GPU (CUDA) - Faster (requires GPU)</option>
            <option value="auto">Auto - Prefer GPU, use CPU if unavailable</option>
          </select>
          {#if config.systemVoiceControl?.kokoroActiveDevice}
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Currently using {config.systemVoiceControl.kokoroActiveDevice === 'cuda' ? 'GPU' : 'CPU'}.
              {#if config.systemVoiceControl.kokoroFallbackReason}
                CUDA became unavailable; Kokoro will use CPU until its next restart.
              {/if}
            </p>
          {/if}
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {#if config.systemVoiceControl?.kokoroDeviceLockedByEnvironment}
              Locked by the MH_KOKORO_DEVICE environment setting.
            {:else if !config.systemVoiceControl?.canConfigureDevices}
              Only the installation owner can change this shared system setting.
            {:else}
              Changing the device updates the shared server configuration and restarts Kokoro if it is running.
            {/if}
          </p>
        </div>

        {#if config.kokoro.voice.startsWith('custom_')}
          <div class="mb-6">
            <label class="flex items-center gap-2 cursor-pointer font-normal">
              <input type="checkbox" bind:checked={config.kokoro.normalizeCustomVoicepacks} disabled={saving} />
              <span>Normalize Custom Voicepack Volume</span>
            </label>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Automatically boost quiet custom voicepacks to -3dB peak.</p>
          </div>
        {/if}

        <div class="mb-6">
          <label class="flex items-center gap-2 cursor-pointer font-normal">
            <input type="checkbox" bind:checked={config.kokoro.autoFallbackToPiper} disabled={saving} />
            Auto-fallback to Piper if unavailable
          </label>
        </div>

        <div class="mt-6 pt-6 border-t-2 border-gray-200 dark:border-gray-700">
          <label for="kokoro-test-text" class="block text-[0.95rem] font-semibold text-gray-800 dark:text-gray-100 mb-2">Test Kokoro Voice</label>
          <textarea id="kokoro-test-text" bind:value={testText} rows="2" placeholder="Enter text to test Kokoro synthesis..." disabled={testingVoice || saving} class="input-field"></textarea>
          <button class="w-full py-3 px-6 border-none rounded-lg font-semibold cursor-pointer transition-all mt-3 bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={() => testVoice('kokoro')} disabled={testingVoice || saving}>
            {testingVoice ? '🔊 Playing...' : '▶️ Test Kokoro'}
          </button>
        </div>
      </div>
    {/if}

    <!-- STT Settings -->
    {#if config.stt}
      <div class="mt-8 p-6 bg-gray-50 dark:bg-gray-800 border-2 border-gray-200 dark:border-gray-700 rounded-xl">
        <h4 class="text-xl font-semibold text-gray-800 dark:text-gray-100 m-0 mb-5">🎤 Speech-to-Text (Whisper)</h4>

        <div class="mb-6">
          <label for="stt-model" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Model Size</label>
          <select id="stt-model" bind:value={config.stt.model} disabled class="select-field">
            <option value="tiny.en">Tiny (~75MB, fastest)</option>
            <option value="base.en">Base (~140MB, balanced)</option>
            <option value="small.en">Small (~460MB, more accurate)</option>
            <option value="medium.en">Medium (~1.5GB, most accurate)</option>
          </select>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Shared system server setting from etc/voice-servers.json.</p>
        </div>

        <div class="mb-6">
          <label for="stt-device" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Processing Device</label>
          <select
            id="stt-device"
            bind:value={config.stt.device}
            disabled={saving || !config.systemVoiceControl?.canConfigureDevices || config.systemVoiceControl?.whisperDeviceLockedByEnvironment}
            class="select-field"
          >
            <option value="cpu">CPU</option>
            <option value="cuda">GPU (CUDA)</option>
          </select>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {#if config.systemVoiceControl?.whisperDeviceLockedByEnvironment}
              Locked by the MH_WHISPER_DEVICE environment setting.
            {:else if !config.systemVoiceControl?.canConfigureDevices}
              Only the installation owner can change this shared system setting.
            {:else}
              Changing the device updates the shared server configuration and restarts Whisper if it is running.
            {/if}
          </p>
        </div>

        <div class="mb-6">
          <label for="stt-compute-type" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Compute Type</label>
          <select id="stt-compute-type" bind:value={config.stt.computeType} disabled class="select-field">
            <option value="int8">INT8 (fastest, CPU-friendly)</option>
            <option value="float16">FLOAT16 (balanced, GPU-optimized)</option>
            <option value="float32">FLOAT32 (highest precision)</option>
          </select>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">This machine-level setting comes from etc/voice-servers.json.</p>
        </div>

        <div class="mb-6">
          <label for="stt-language" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Language</label>
          <select id="stt-language" bind:value={config.stt.language} disabled={saving} class="select-field">
            <option value="en">English</option>
            <option value="es">Spanish</option>
            <option value="fr">French</option>
            <option value="de">German</option>
            <option value="it">Italian</option>
            <option value="pt">Portuguese</option>
            <option value="ja">Japanese</option>
            <option value="ko">Korean</option>
            <option value="zh">Chinese</option>
          </select>
        </div>

        <div class="mb-6">
          <label class="flex items-center gap-2 cursor-pointer font-normal">
            <input type="checkbox" bind:checked={config.stt.useServer} disabled={saving} />
            Use persistent Whisper server (recommended)
          </label>
          <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Persistent server keeps model in memory for instant transcription</p>
        </div>


        <div class="mt-8 pt-6 border-t-2 border-gray-200 dark:border-gray-700">
          <h5 class="my-4 text-gray-500 dark:text-gray-400 text-base font-semibold">🎧 Hardware Button Capture</h5>

          <div class="mb-6">
            <label class="flex items-center gap-2 cursor-pointer font-normal">
              <input type="checkbox" checked={hardwareButtonsEnabled} on:change={(e) => {
                hardwareButtonsEnabled = e.currentTarget.checked;
                localStorage.setItem('mh-hardware-buttons', hardwareButtonsEnabled ? 'true' : 'false');
              }} disabled={saving} />
              Enable earbud/headphone button capture
            </label>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Allows play/pause buttons on Bluetooth earbuds and headphones to trigger voice input.</p>
          </div>
        </div>

        <div class="mt-8 pt-6 border-t-2 border-gray-200 dark:border-gray-700">
          <h5 class="my-4 text-gray-500 dark:text-gray-400 text-base font-semibold">⚙️ Voice Activity Detection Settings</h5>

          <div class="mb-6">
            <label for="vad-threshold" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Voice Threshold: {config.stt.vad.voiceThreshold}</label>
            <input id="vad-threshold" type="range" min="0" max="100" step="1" bind:value={config.stt.vad.voiceThreshold} disabled={saving} class="range-slider" />
            <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
              <span>0 (Very Sensitive)</span><span>50</span><span>100 (Less Sensitive)</span>
            </div>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">How loud audio needs to be to register as speech.</p>
          </div>

          <div class="mb-6">
            <label for="vad-silence-delay" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Silence Delay: {config.stt.vad.silenceDelay / 1000} seconds</label>
            <input id="vad-silence-delay" type="range" min="1000" max="30000" step="500" bind:value={config.stt.vad.silenceDelay} disabled={saving} class="range-slider" />
            <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
              <span>1s (Quick)</span><span>15s</span><span>30s (Patient)</span>
            </div>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">How long to wait in silence before auto-stopping.</p>
          </div>

          <div class="mb-6">
            <label for="vad-min-duration" class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Minimum Duration: {config.stt.vad.minDuration}ms</label>
            <input id="vad-min-duration" type="range" min="100" max="5000" step="100" bind:value={config.stt.vad.minDuration} disabled={saving} class="range-slider" />
            <div class="flex justify-between text-xs text-gray-500 dark:text-gray-400 mt-1">
              <span>100ms (Short)</span><span>2.5s</span><span>5s (Long)</span>
            </div>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Minimum recording length to prevent accidental clicks.</p>
          </div>

          <!-- VAD Test Recorder -->
          <div class="mt-6 p-6 bg-blue-50 dark:bg-blue-900/30 border-2 border-blue-500 dark:border-blue-400 rounded-xl">
            <div class="block font-medium text-gray-700 dark:text-gray-300 mb-2 text-sm">Test Voice Detection</div>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">Click to start recording. Speak naturally, and the system will auto-stop after silence.</p>

            {#if !vadTestRecording}
              <button class="w-full py-3 px-6 border-none rounded-lg font-semibold cursor-pointer transition-all mt-3 bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={startVADTest} disabled={saving}>
                🎤 Start VAD Test
              </button>
            {:else}
              <div class="flex flex-col gap-4">
                <div class="flex flex-col gap-2">
                  <div class="text-sm font-semibold text-gray-800 dark:text-gray-100 flex justify-between items-center">
                    Volume: {vadTestVolume.toFixed(0)}
                    {#if vadTestSpeaking}
                      <span class="text-red-500 font-bold animate-pulse">🔴 SPEAKING</span>
                    {:else}
                      <span class="text-gray-400">⚪ Silence</span>
                    {/if}
                  </div>
                  <div class="relative h-10 bg-gray-200 dark:bg-gray-700 rounded-lg overflow-hidden">
                    <div class="h-full transition-[width] duration-100 {vadTestSpeaking ? 'bg-gradient-to-r from-red-500 to-red-400' : 'bg-gradient-to-r from-blue-500 to-blue-400'}" style="width: {vadTestVolume}%"></div>
                    <div class="absolute top-0 bottom-0 w-[3px] bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.8)]" style="left: {config.stt.vad.voiceThreshold}%"></div>
                  </div>
                </div>
                <button class="w-full py-3 px-6 border-none rounded-lg font-semibold cursor-pointer transition-all bg-red-500 text-white hover:bg-red-600" on:click={cancelVADTest}>
                  ❌ Cancel
                </button>
              </div>
            {/if}

            {#if vadTestTranscription}
              <div class="mt-4 p-4 bg-green-100 dark:bg-green-500/10 border border-emerald-500 dark:border-emerald-400 rounded-lg">
                <strong class="text-emerald-600 dark:text-emerald-400 text-sm">Transcription:</strong>
                <p class="mt-2 text-gray-800 dark:text-gray-100 text-[0.95rem]">{vadTestTranscription}</p>
              </div>
            {/if}

            {#if vadTestError}
              <div class="mt-4 p-3 bg-red-100 dark:bg-red-500/10 border border-red-500 dark:border-red-400 rounded-lg text-red-600 dark:text-red-400 text-sm">{vadTestError}</div>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <!-- Actions -->
    <div class="mt-6">
      <button class="w-full py-3 px-6 border-none rounded-lg font-semibold cursor-pointer transition-all bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed" on:click={saveSettings} disabled={saving} title="Save voice settings">
        {saving ? 'Saving...' : '💾 Save Settings'}
      </button>
    </div>
  {/if}
</div>

<style>
  .range-slider {
    @apply w-full h-1.5 rounded-sm bg-gray-200 dark:bg-gray-700 outline-none appearance-none;
  }
  .range-slider::-webkit-slider-thumb {
    @apply appearance-none w-5 h-5 rounded-full bg-violet-600 cursor-pointer;
  }
  .range-slider::-moz-range-thumb {
    @apply w-5 h-5 rounded-full bg-violet-600 cursor-pointer border-none;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
  .animate-pulse {
    animation: pulse 1s infinite;
  }
</style>
