<script lang="ts">
  /**
   * ReferenceAudioSelector
   * UI for selecting voice samples to use as reference audio
   */

  import { onMount } from 'svelte';
  import { apiFetch, apiUrl } from '../lib/client/api-config';

  export let minQuality: number = 0.8;
  export let onSelectionChange: (selectedIds: string[]) => void = () => {};

  interface VoiceSample {
    id: string;
    audioPath: string;
    transcriptPath: string;
    duration: number;
    timestamp: string;
    quality: number;
  }


  let samples: VoiceSample[] = [];
  let selectedIds: Set<string> = new Set();
  let loading = false;
  let error = '';
  let totalDuration = 0;
  let avgQuality = 0;
  let playingId: string | null = null;
  let audioElement: HTMLAudioElement | null = null;

  onMount(() => {
    loadSamples();

  });

  async function loadSamples() {
    loading = true;
    error = '';
    try {
      const response = await apiFetch(
        '/api/voice-training?action=samples&limit=1000'
      );
      if (!response.ok) throw new Error('Failed to load samples');

      const data = await response.json();
      samples = (data.samples || []).filter((sample: VoiceSample) => sample.quality >= minQuality);

      // Calculate stats
      totalDuration = samples.reduce((sum, s) => sum + s.duration, 0);
      avgQuality = samples.length > 0
        ? samples.reduce((sum, s) => sum + s.quality, 0) / samples.length
        : 0;
    } catch (err) {
      error = String(err);
      console.error('[ReferenceAudioSelector] Error loading samples:', err);
    } finally {
      loading = false;
    }
  }

  function toggleSelection(id: string) {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
    selectedIds = selectedIds; // Trigger reactivity
    onSelectionChange(Array.from(selectedIds));
  }

  function selectAll() {
    selectedIds = new Set(samples.map(s => s.id));
    onSelectionChange(Array.from(selectedIds));
  }

  function clearSelection() {
    selectedIds = new Set();
    onSelectionChange(Array.from(selectedIds));
  }

  function selectBest(count: number = 5) {
    // Sort by quality and select top N
    const sorted = [...samples].sort((a, b) => b.quality - a.quality);
    selectedIds = new Set(sorted.slice(0, count).map(s => s.id));
    onSelectionChange(Array.from(selectedIds));
  }

  function formatDuration(seconds: number): string {
    if (seconds < 60) {
      return `${seconds.toFixed(1)}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}m ${secs}s`;
  }

  function formatTimestamp(timestamp: string): string {
    try {
      return new Date(timestamp).toLocaleDateString();
    } catch {
      return timestamp;
    }
  }

  function togglePlayAudio(sample: VoiceSample, event: Event) {
    event.stopPropagation(); // Prevent checkbox toggle

    // If already playing this sample, stop it
    if (playingId === sample.id) {
      if (audioElement) {
        audioElement.pause();
        audioElement = null;
      }
      playingId = null;
      return;
    }

    // Stop any currently playing audio
    if (audioElement) {
      audioElement.pause();
      audioElement = null;
    }

    // Start playing the selected sample via API endpoint
    playingId = sample.id;
    // Use API endpoint to serve the audio file
    const audioUrl = apiUrl(`/api/voice-samples/${sample.id}`);
    audioElement = new Audio(audioUrl);

    audioElement.addEventListener('ended', () => {
      playingId = null;
      audioElement = null;
    });

    audioElement.addEventListener('error', (e) => {
      error = `Failed to play audio: ${sample.id}`;
      playingId = null;
      audioElement = null;
      console.error('[ReferenceAudioSelector] Audio playback error:', e);
    });

    audioElement.play().catch(err => {
      error = `Failed to play audio: ${err.message}`;
      playingId = null;
      audioElement = null;
      console.error('[ReferenceAudioSelector] Audio play() failed:', err);
    });
  }

  $: selectedSamples = samples.filter(s => selectedIds.has(s.id));
  $: selectedDuration = selectedSamples.reduce((sum, s) => sum + s.duration, 0);
  $: selectedQuality = selectedSamples.length > 0
    ? selectedSamples.reduce((sum, s) => sum + s.quality, 0) / selectedSamples.length
    : 0;
</script>

<div class="bg-gray-900 dark:bg-gray-900 rounded-lg p-6 text-white">
  <div class="mb-6">
    <h3 class="m-0 mb-2 text-xl text-white">Select Training Audio Samples</h3>
    <p class="m-0 text-sm text-gray-400 opacity-80">
      Select samples for RVC voice training.
    </p>
  </div>

  {#if loading}
    <div class="p-8 text-center">Loading samples...</div>
  {:else if error}
    <div class="p-8 text-center text-red-400">{error}</div>
  {:else}
    <div class="flex justify-between items-center mb-4 pb-4 border-b border-gray-700 md:flex-col md:items-stretch md:gap-4">
      <div class="flex gap-2 flex-wrap">
        <button on:click={selectAll} class="px-3 py-1.5 text-sm bg-gray-700 text-white border border-gray-600 rounded cursor-pointer transition-all hover:bg-gray-600 hover:border-gray-500">Select All ({samples.length})</button>
        <button on:click={clearSelection} class="px-3 py-1.5 text-sm bg-gray-700 text-white border border-gray-600 rounded cursor-pointer transition-all hover:bg-gray-600 hover:border-gray-500">Clear</button>
        <button on:click={() => selectBest(5)} class="px-3 py-1.5 text-sm bg-gray-700 text-white border border-gray-600 rounded cursor-pointer transition-all hover:bg-gray-600 hover:border-gray-500">Select Top 5</button>
        <button on:click={() => selectBest(10)} class="px-3 py-1.5 text-sm bg-gray-700 text-white border border-gray-600 rounded cursor-pointer transition-all hover:bg-gray-600 hover:border-gray-500">Select Top 10</button>
      </div>

      <div class="flex gap-4 md:justify-between md:w-full">
        <div class="flex flex-col items-end">
          <span class="text-xs text-gray-400 uppercase tracking-wide">Selected:</span>
          <span class="text-base font-semibold mt-0.5">{selectedIds.size} samples</span>
        </div>
        <div class="flex flex-col items-end">
          <span class="text-xs text-gray-400 uppercase tracking-wide">Duration:</span>
          <span class="text-base font-semibold mt-0.5">{formatDuration(selectedDuration)}</span>
        </div>
        <div class="flex flex-col items-end">
          <span class="text-xs text-gray-400 uppercase tracking-wide">Avg Quality:</span>
          <span class="text-base font-semibold mt-0.5 {selectedQuality >= 0.9 ? 'text-green-400' : selectedQuality >= 0.7 ? 'text-yellow-400' : 'text-red-400'}">
            {(selectedQuality * 100).toFixed(0)}%
          </span>
        </div>
      </div>
    </div>

    <div class="max-h-[400px] overflow-y-auto border border-gray-700 rounded-md bg-gray-950">
      {#if samples.length === 0}
        <div class="p-8 text-center text-gray-400">
          No samples found above quality threshold ({minQuality}).
          <br>Try recording more voice samples or lowering the quality threshold.
        </div>
      {:else}
        {#each samples as sample (sample.id)}
          <div
            class="flex items-center px-4 py-3 border-b border-gray-800 transition-all relative hover:bg-gray-800 {selectedIds.has(sample.id) ? 'bg-blue-900/30 border-l-[3px] border-l-blue-500' : ''}"
          >
            <div class="mr-3">
              <input
                type="checkbox"
                checked={selectedIds.has(sample.id)}
                on:change={() => toggleSelection(sample.id)}
                class="w-5 h-5 cursor-pointer"
              />
            </div>

            <div class="flex-1">
              <div class="font-medium mb-1 text-[0.95rem]">{sample.id}</div>
              <div class="flex gap-4 text-sm md:flex-col md:gap-1">
                <span class="flex gap-1">
                  <span class="text-gray-400">Duration:</span>
                  <span class="text-white font-medium">{formatDuration(sample.duration)}</span>
                </span>
                <span class="flex gap-1">
                  <span class="text-gray-400">Quality:</span>
                  <span class="font-medium {sample.quality >= 0.9 ? 'text-green-400' : sample.quality >= 0.7 ? 'text-yellow-400' : 'text-red-400'}">
                    {(sample.quality * 100).toFixed(0)}%
                  </span>
                </span>
                <span class="flex gap-1">
                  <span class="text-gray-400">Date:</span>
                  <span class="text-white font-medium">{formatTimestamp(sample.timestamp)}</span>
                </span>
              </div>
            </div>

            <div class="flex items-center gap-2 mr-2">
              <button
                class="p-2 bg-blue-600 text-white border-none rounded-full w-10 h-10 flex items-center justify-center cursor-pointer text-base transition-all hover:bg-blue-700 hover:scale-110"
                on:click={(e) => togglePlayAudio(sample, e)}
                title={playingId === sample.id ? 'Stop' : 'Play sample'}
              >
                {playingId === sample.id ? '⏸️' : '▶️'}
              </button>


            </div>

            <div class="w-20 h-1.5 bg-gray-800 rounded overflow-hidden ml-4 md:hidden">
              <div class="h-full bg-gradient-to-r from-red-500 via-yellow-500 to-green-500 transition-all duration-300" style="width: {sample.quality * 100}%"></div>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <div class="mt-4 pt-4 border-t border-gray-700">
      <div class="flex justify-around gap-4">
        <div class="flex flex-col items-center">
          <span class="text-xs text-gray-400 mb-0.5 uppercase tracking-wide">Total Available:</span>
          <span class="text-base font-semibold">{samples.length} samples</span>
        </div>
        <div class="flex flex-col items-center">
          <span class="text-xs text-gray-400 mb-0.5 uppercase tracking-wide">Total Duration:</span>
          <span class="text-base font-semibold">{formatDuration(totalDuration)}</span>
        </div>
        <div class="flex flex-col items-center">
          <span class="text-xs text-gray-400 mb-0.5 uppercase tracking-wide">Avg Quality:</span>
          <span class="text-base font-semibold">{(avgQuality * 100).toFixed(0)}%</span>
        </div>
      </div>
    </div>
  {/if}
</div>
