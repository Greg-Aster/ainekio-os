<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { apiFetch } from '../lib/client/api-config';
  import { activeView, systemSection } from '../stores/navigation';
  import type { TrainingCandidateSummary, TrainingCleanupReceipt, TrainingTarget } from '@metahuman/core/training-schema';
  let candidates: TrainingCandidateSummary[] = [];
  let cleanup: TrainingCleanupReceipt[] = [];
  let selectedCandidate = '';
  let baselineModel = '';
  let baselineProvider: TrainingTarget = 'llama-cpp';
  let prompts = '';
  let notes = '';
  let checks: boolean[] = [];
  let reviewBusy = false;
  let reviewMessage = '';
  $: candidate = candidates.find(item => item.runLabel === selectedCandidate);

  function openModels() { systemSection.set('settings'); activeView.set('system'); }
  function openBackend() { systemSection.set('backend'); activeView.set('system'); }
  async function reviewAction(action: 'prepare' | 'test' | 'decide' | 'reopen', decision?: 'accepted' | 'rejected') {
    if (!candidate) return;
    historyRead?.abort();
    reviewBusy = true;
    reviewMessage = '';
    try {
      const response = await apiFetch('/api/training/history', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          action, runLabel: candidate.runLabel, baselineModel, baselineProvider, prompts: prompts.split('\n').filter(line => line.trim()),
          reviewId: candidate.review?.id, decision, notes, checks,
        }) });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || 'Candidate review failed');
      reviewMessage = action === 'prepare' ? 'Prepared ' + data.result.model + '. Run the review prompts next.'
        : action === 'test' ? 'Review each comparison below before deciding.'
        : action === 'reopen' ? 'Approval suspended. Prepare the artifact and run a fresh serving comparison.'
        : decision === 'accepted' ? 'Accepted for use. Open Model Settings to assign a role or select a previous model.'
        : 'Candidate rejected.';
      if (action === 'test') checks = data.result.cases.map(() => false);
    } catch (err) { reviewMessage = (err as Error).message; }
    finally { reviewBusy = false; await loadTrainingHistory(); }
  }

  async function recoverCleanup(runLabel: string) {
    historyRead?.abort();
    reviewBusy = true;
    reviewMessage = '';
    try {
      const response = await apiFetch('/api/training/history', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'recover-cleanup', runLabel }) });
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error(body.error || 'Cleanup remains unconfirmed');
      reviewMessage = 'RunPod cleanup confirmed at ' + body.result.confirmedAt;
    } catch (err) { reviewMessage = (err as Error).message; }
    finally { reviewBusy = false; await loadTrainingHistory(); }
  }

  interface TrainingRun {
    id: string;
    startTime: string;
    endTime?: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'incomplete';
    pid?: number;
    method: 'local-lora' | 'remote-lora' | 'fine-tune';
    logFile: string;
    username?: string;
    baseModel?: string;
    duration?: string;
    error?: string;
  }

  interface CurrentTraining {
    success: boolean;
    running: boolean;
    pid: number;
    method: string;
    runLabel?: string;
    logFile?: string;
    cancelling: boolean;
  }
  let currentRun: CurrentTraining | null = null;
  let pastRuns: TrainingRun[] = [];
  let loading = true;
  let error = '';
  type TrainingRead = 'status' | 'history' | 'events' | 'console' | 'archive';
  let readErrors: Partial<Record<TrainingRead, string>> = {};
  const observation = new AbortController();
  let historyRead: AbortController | null = null;

  // Current run monitoring
  let trainingLogs: Array<{ timestamp: string; event: string; details?: any }> = [];
  let consoleLogs: string[] = [];
  let logsInterval: number | null = null;
  let consoleScrollContainer: HTMLDivElement | null = null;
  let eventsScrollContainer: HTMLDivElement | null = null;

  // Expanded run details
  let expandedRunId: string | null = null;
  let expandedLogs: string[] = [];
  let loadingLogs = false;
  let expandedLogRead: AbortController | null = null;

  function currentRunIdentity() {
    return currentRun?.runLabel ?? currentRun?.pid ?? null;
  }

  async function readTraining<T extends { success: boolean }>(kind: TrainingRead, url: string, signal = observation.signal): Promise<T | null> {
    if (signal.aborted) return null;
    const liveRead = kind === 'status' || kind === 'events' || kind === 'console';
    const identity = currentRunIdentity();
    try {
      const response = await apiFetch(url, { signal });
      const data = await response.json();
      if (signal.aborted || (liveRead && currentRunIdentity() !== identity)) return null;
      if (!response.ok || !data.success) throw new Error(data.error || `Could not read training ${kind}`);
      readErrors = { ...readErrors };
      delete readErrors[kind];
      return data;
    } catch (err) {
      if (!signal.aborted && (!liveRead || currentRunIdentity() === identity)) readErrors = { ...readErrors, [kind]: (err as Error).message };
      return null;
    }
  }

  async function loadRunningTraining() {
    const identity = currentRunIdentity();
    const data = await readTraining<CurrentTraining>('status', '/api/training/running');
    if (!data || currentRunIdentity() !== identity) return null;
    if (data.running) {
      currentRun = data;
      startLogsPolling();
    } else {
      currentRun = null;
      stopLogsPolling();
    }
    return data;
  }

  async function loadPastRuns() {
    if (reviewBusy || observation.signal.aborted) return;
    historyRead?.abort();
    const read = new AbortController();
    historyRead = read;
    const signal = AbortSignal.any([observation.signal, read.signal]);
    const data = await readTraining<{ success: boolean; runs: TrainingRun[]; candidates: TrainingCandidateSummary[]; cleanup: TrainingCleanupReceipt[] }>('history', '/api/training/history', signal);
    if (!data || signal.aborted || reviewBusy) return;
    const previousReviewId = candidates.find(item => item.runLabel === selectedCandidate)?.review?.id;
    pastRuns = data.runs;
    candidates = data.candidates;
    cleanup = data.cleanup;
    if (previousReviewId !== candidates.find(item => item.runLabel === selectedCandidate)?.review?.id) {
      checks = [];
      if (previousReviewId) reviewMessage = 'The serving comparison changed. Review its responses again; your draft notes are preserved.';
    }
  }

  async function loadTrainingHistory() {
    if (reviewBusy || observation.signal.aborted) return;
    loading = true;
    try {
      await Promise.all([loadRunningTraining(), loadPastRuns()]);
    } finally {
      loading = false;
    }
  }

  async function loadCurrentLogs() {
    const identity = currentRunIdentity();
    await Promise.all([
      readTraining<{ success: boolean; logs: typeof trainingLogs }>('events', '/api/training/logs?maxLines=50').then(async data => {
        if (!data || currentRunIdentity() !== identity) return;
        trainingLogs = data.logs;
        await tick();
        if (!observation.signal.aborted && eventsScrollContainer) eventsScrollContainer.scrollTop = eventsScrollContainer.scrollHeight;
      }),
      readTraining<{ success: boolean; logs: string[] }>('console', '/api/training/console-logs?maxLines=200').then(async data => {
        if (!data || currentRunIdentity() !== identity) return;
        consoleLogs = data.logs;
        await tick();
        if (!observation.signal.aborted && consoleScrollContainer) consoleScrollContainer.scrollTop = consoleScrollContainer.scrollHeight;
      }),
    ]);
  }

  async function pollTrainingLogs() {
    if (!currentRun || observation.signal.aborted) return;
    await Promise.all([
      loadCurrentLogs(),
      loadRunningTraining().then(data => { if (data && !data.running) return loadPastRuns(); }),
    ]);
  }

  function startLogsPolling() {
    if (logsInterval !== null || document.hidden || observation.signal.aborted) return;
    void loadCurrentLogs();
    logsInterval = window.setInterval(pollTrainingLogs, 5000);
  }

  function stopLogsPolling() {
    if (logsInterval) {
      clearInterval(logsInterval);
      logsInterval = null;
    }
  }

  async function cancelTraining() {
    if (!currentRun) return;

    try {
      const res = await apiFetch('/api/training/cancel', {
        method: 'POST',
      });

      const data = await res.json();
      if (res.ok && data.success) {
        await loadTrainingHistory();
      } else {
        throw new Error(data.error || 'Cancellation failed');
      }
    } catch (err) {
      console.error('[TrainingHistory] Failed to cancel:', err);
      error = (err as Error).message;
    }
  }

  async function toggleRunDetails(runId: string) {
    expandedLogRead?.abort();
    expandedRunId = expandedRunId === runId ? null : runId;
    expandedLogs = [];
    loadingLogs = false;
    if (expandedRunId) await loadRunLogs(runId);
  }

  async function loadRunLogs(runId: string) {
    expandedLogRead?.abort();
    const read = new AbortController();
    expandedLogRead = read;
    const signal = AbortSignal.any([observation.signal, read.signal]);
    loadingLogs = true;
    readErrors = { ...readErrors };
    delete readErrors.archive;
    try {
      const run = pastRuns.find(item => item.id === runId);
      if (!run?.logFile) {
        expandedLogs = ['No log file available'];
        return;
      }
      const data = await readTraining<{ success: boolean; logs: string[] }>('archive', `/api/training/log-file?file=${encodeURIComponent(run.logFile)}`, signal);
      if (data) expandedLogs = data.logs;
    } finally {
      if (!signal.aborted) loadingLogs = false;
    }
  }

  function formatTimestamp(timestamp: string): string {
    const date = new Date(timestamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z'));
    return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
  }

  const runStatusPresentation = {
    running: { color: '#3b82f6', icon: '🔄' },
    completed: { color: '#10b981', icon: '✅' },
    failed: { color: '#ef4444', icon: '❌' },
    cancelled: { color: '#f59e0b', icon: '🛑' },
    incomplete: { color: '#6b7280', icon: '⚠️' },
  };

  let historyInterval: number | null = null;

  function startHistoryPolling() {
    if (historyInterval || observation.signal.aborted) return;
    loadTrainingHistory();
    historyInterval = window.setInterval(loadTrainingHistory, 30000);
  }

  function stopHistoryPolling() {
    if (historyInterval) {
      clearInterval(historyInterval);
      historyInterval = null;
    }
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      // Pause all polling when tab hidden
      stopHistoryPolling();
      stopLogsPolling();
    } else {
      // Resume polling when tab visible
      startHistoryPolling();
      // Only resume logs polling if there's a current run
      if (currentRun) {
        startLogsPolling();
      }
    }
  }

  onMount(() => {
    // Only poll when tab is visible
    if (!document.hidden) {
      startHistoryPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      observation.abort();
      stopHistoryPolling();
      stopLogsPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  });

</script>

<div class="p-6 max-w-[1400px] mx-auto">
  {#if loading && !currentRun && pastRuns.length === 0}
    <div class="flex flex-col items-center justify-center py-16 px-8 gap-4">
      <div class="w-10 h-10 border-4 border-gray-200 dark:border-gray-700 border-t-blue-500 rounded-full animate-spin"></div>
      <p>Loading training history...</p>
    </div>
  {:else}
    {#if error}
      <div class="bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-md p-4 mb-6 text-red-700 dark:text-red-400">
        <strong>⚠️ Error:</strong> {error}
      </div>
    {/if}
    {#if Object.keys(readErrors).length > 0}
      <div class="mb-4 border border-red-800 rounded p-4 text-red-600 dark:text-red-400" role="alert">
        <p>Some training observations could not be refreshed. Displayed observations may be from the last successful read.</p>
        {#each Object.entries(readErrors) as [kind, message]}<p>{kind}: {message}</p>{/each}
        <button type="button" class="btn-secondary mt-2" on:click={() => Promise.all([loadTrainingHistory(), currentRun ? loadCurrentLogs() : Promise.resolve()])}>Retry training reads</button>
      </div>
    {/if}


    <section class="mb-8 rounded-xl border border-gray-700 p-5 space-y-4">
      <h3 class="text-xl font-semibold">Candidate review</h3>
      {#each cleanup as receipt}
        <div class="border border-amber-600 rounded p-3 space-y-2">
          <p>RunPod cleanup needs confirmation: {receipt.runLabel}. {receipt.error ?? ''}</p>
          <p class="text-sm break-all">{receipt.podName}{receipt.podId ? ' · ' + receipt.podId : ''}</p>
          <button class="px-3 py-2 rounded border border-amber-600 disabled:opacity-50" disabled={reviewBusy || !!currentRun} on:click={() => recoverCleanup(receipt.runLabel)}>Terminate remaining pod and verify cleanup</button>
          <a class="underline ml-3" href="https://console.runpod.io/pods" target="_blank" rel="noreferrer">Inspect RunPod</a>
        </div>
      {/each}
      <p class="text-sm text-gray-500">Training saves a candidate. Check it on the serving backend, compare representative prompts, then approve it for model-role assignment. Previous models remain available for rollback in Model Settings.</p>
      <div class="flex flex-wrap gap-3">
        <button class="px-3 py-2 rounded border border-gray-600" on:click={openBackend}>Backend setup</button>
        <button class="px-3 py-2 rounded border border-gray-600" on:click={openModels}>Model Settings and rollback</button>
      </div>
      {#if candidates.length === 0 && readErrors.history}
        <p>Candidate history unavailable.</p>
      {:else if candidates.length === 0}
        <p>No candidate runs have been produced by the verified training pipeline yet.</p>
      {:else}
        <label class="block">Training run
          <select class="block w-full mt-1 p-2 rounded bg-gray-900 text-white" bind:value={selectedCandidate} disabled={reviewBusy} on:change={() => { checks = []; notes = ''; reviewMessage = ''; }}>
            <option value="">Choose a run</option>
            {#each candidates as item}
              <option value={item.runLabel}>{item.runLabel} — {item.status}{item.review?.decision ? ' / ' + item.review.decision : ''}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if candidate}
        <p class="text-sm break-all">{candidate.method} · {candidate.baseModel} · {candidate.target}<br />Artifact: {candidate.candidateDirectory}</p>
        {#if candidate.baselineLoss !== undefined && candidate.candidateLoss !== undefined}
          <p class="text-sm">Held-out loss: base {candidate.baselineLoss.toFixed(4)} → serialized candidate {candidate.candidateLoss.toFixed(4)}. {candidate.trainingSamples} training and {candidate.evaluationSamples} evaluation examples. Gate: {candidate.qualityGate}.</p>
        {/if}
        {#if candidate.error}<p class="text-red-400">{candidate.error}</p>{/if}
        {#if candidate.status === 'candidate'}
          {#if candidate.review?.decision !== 'accepted'}
            <p class="text-sm text-gray-500">Preparation verifies this run's artifact on its recorded serving backend. It does not assign a role.</p>
            <button class="px-3 py-2 rounded bg-blue-700 text-white disabled:opacity-50" disabled={reviewBusy} on:click={() => reviewAction('prepare')}>Prepare exact artifact</button>
            <label class="block">Baseline backend
              <select class="block w-full mt-1 p-2 rounded bg-gray-900 text-white" bind:value={baselineProvider} disabled={reviewBusy}>
                <option value="llama-cpp">llama.cpp (unadapted base)</option>
                <option value="ollama">Ollama</option>
              </select>
            </label>
            <label class="block">Baseline model
              <input class="block w-full mt-1 p-2 rounded bg-gray-900 text-white" bind:value={baselineModel} disabled={reviewBusy} placeholder="Installed base or previous accepted model" />
            </label>
            <label class="block">Three to eight representative prompts, one per line
              <textarea class="block w-full mt-1 p-2 rounded bg-gray-900 text-white" rows="5" bind:value={prompts} disabled={reviewBusy} placeholder="Include a normal task, a correction, and an edge case."></textarea>
            </label>
            <button class="px-3 py-2 rounded bg-blue-700 text-white disabled:opacity-50" disabled={reviewBusy || !baselineModel || prompts.split('\n').filter(line => line.trim()).length < 3} on:click={() => reviewAction('test')}>Compare on serving backend</button>
          {/if}
          {#if candidate.review}
            <p class="text-sm">Review {candidate.review.createdAt} · {candidate.review.model} · baseline {candidate.review.baselineProvider}/{candidate.review.baselineModel} · {candidate.review.decision ?? 'awaiting decision'}</p>
            {#each candidate.review.cases as item, index}
              <div class="border border-gray-700 rounded p-3 space-y-2">
                <p class="font-semibold whitespace-pre-wrap">{item.prompt}</p>
                <div class="grid gap-3 md:grid-cols-2">
                  <div><strong>Baseline</strong><pre class="whitespace-pre-wrap text-sm mt-1">{item.baseline}</pre></div>
                  <div><strong>Candidate</strong><pre class="whitespace-pre-wrap text-sm mt-1">{item.candidate}</pre></div>
                </div>
                {#if candidate.review.decision !== 'accepted' && !candidate.review.reopenedAt}
                  <label class="flex items-center gap-2"><input type="checkbox" bind:checked={checks[index]} disabled={reviewBusy} />This candidate response meets my task and persona requirements.</label>
                {/if}
              </div>
            {/each}
            {#if candidate.review.reopenedAt}
              <p>Approval is suspended. Run a fresh serving comparison above before deciding again.</p>
            {:else if candidate.review.decision !== 'accepted'}
              <label class="block">Review notes
                <textarea class="block w-full mt-1 p-2 rounded bg-gray-900 text-white" rows="3" bind:value={notes} disabled={reviewBusy}></textarea>
              </label>
              <div class="flex gap-3">
                <button class="px-3 py-2 rounded bg-emerald-700 text-white disabled:opacity-50" disabled={reviewBusy || !notes.trim() || checks.filter(Boolean).length !== candidate.review.cases.length} on:click={() => reviewAction('decide', 'accepted')}>Accept for role assignment</button>
                <button class="px-3 py-2 rounded border border-red-600 disabled:opacity-50" disabled={reviewBusy || !notes.trim()} on:click={() => reviewAction('decide', 'rejected')}>Reject candidate</button>
              </div>
            {:else}
              <p>{candidate.review.notes}</p>
              <button class="px-3 py-2 rounded border border-gray-600 disabled:opacity-50" disabled={reviewBusy} on:click={() => reviewAction('reopen')}>Suspend approval and start a new serving review</button>
            {/if}
          {/if}
        {/if}
      {/if}
      {#if reviewBusy}<p role="status">Working on candidate review…</p>{/if}
      {#if reviewMessage}<p role="status" class="whitespace-pre-wrap">{reviewMessage}</p>{/if}
    </section>

    <!-- Current Run Section -->
    {#if currentRun}
      <div class="mb-8">
        <div class="flex justify-between items-center mb-4">
          <h3 class="m-0 text-xl font-semibold">🔥 Current Training Run</h3>
          <button class="bg-red-500 text-white border-none px-4 py-2 rounded-md cursor-pointer font-medium transition-colors hover:bg-red-600" on:click={cancelTraining}>
            🛑 Cancel Training
          </button>
        </div>

        <div class="bg-white dark:bg-gray-800 border-2 border-blue-500 rounded-lg p-6 mb-4">
          <div class="mb-6">
            <div class="flex items-center gap-4 mb-4">
              <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-white bg-blue-500">
                <div class="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                <span>Running</span>
              </span>
              {#if currentRun.pid}
                <span class="font-mono text-sm text-gray-500">PID: {currentRun.pid}</span>
              {/if}
            </div>
            <div class="flex flex-col gap-2">
              <div class="flex gap-2 text-sm">
                <span class="font-medium text-gray-500">Started:</span>
                <span class="text-gray-900 dark:text-gray-100">{currentRun.runLabel ? formatTimestamp(currentRun.runLabel) : 'Not recorded'}</span>
              </div>
              <div class="flex gap-2 text-sm">
                <span class="font-medium text-gray-500">Method:</span>
                <span class="text-gray-900 dark:text-gray-100">{currentRun.method}</span>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 lg:grid-cols-1 gap-4">
            <!-- Console Output -->
            <div class="flex flex-col">
              <h4 class="m-0 mb-3 text-base font-semibold">🖥️ Console Output</h4>
              <div class="bg-black text-green-400 font-mono text-xs p-4 rounded-md h-[400px] overflow-y-auto leading-relaxed whitespace-pre-wrap break-all" bind:this={consoleScrollContainer}>
                {#if consoleLogs.length === 0}
                  <div class="text-gray-500 italic text-center py-8">Waiting for training output...</div>
                {:else}
                  {#each consoleLogs as line}
                    <div class="mb-0.5">{line}</div>
                  {/each}
                {/if}
              </div>
            </div>

            <!-- Training Events -->
            <div class="flex flex-col">
              <h4 class="m-0 mb-3 text-base font-semibold">📋 Training Events</h4>
              <div class="bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-mono text-xs p-4 rounded-md h-[400px] overflow-y-auto leading-relaxed" bind:this={eventsScrollContainer}>
                {#if trainingLogs.length === 0}
                  <div class="text-gray-500 italic text-center py-8">No events yet</div>
                {:else}
                  {#each trainingLogs as log}
                    <div class="flex gap-3 p-2 border-b border-gray-200 dark:border-gray-700">
                      <span class="text-gray-500 text-xs flex-shrink-0">{new Date(log.timestamp).toLocaleTimeString()}</span>
                      <span class="font-medium flex-shrink-0">{log.event}</span>
                      {#if log.details}
                        <span class="text-gray-500 text-xs overflow-hidden text-ellipsis">{JSON.stringify(log.details)}</span>
                      {/if}
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Past Runs Section -->
    <div class="mt-8">
      <div class="flex justify-between items-center mb-4">
        <h3 class="m-0 text-xl font-semibold">📜 Training History</h3>
        <span class="bg-gray-100 dark:bg-gray-700 px-3 py-1 rounded-xl text-sm font-medium">{pastRuns.length} run{pastRuns.length !== 1 ? 's' : ''}</span>
      </div>

      {#if pastRuns.length === 0 && readErrors.history}
        <p>Training history unavailable.</p>
      {:else if pastRuns.length === 0}
        <div class="text-center py-12 px-8 text-gray-500">
          <p>No past training runs found.</p>
          <p class="text-sm mt-2">Start a training run using the Training Wizard to see history here.</p>
        </div>
      {:else}
        <div class="flex flex-col">
          {#each pastRuns as run (run.id)}
            {@const presentation = runStatusPresentation[run.status] ?? { color: '#6b7280', icon: '❓' }}
            <div class="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6 mb-4">
              <button type="button" class="flex w-full justify-between items-center cursor-pointer select-none pb-3 border-b border-gray-200 dark:border-gray-700 hover:opacity-80" on:click={() => toggleRunDetails(run.id)} aria-expanded={expandedRunId === run.id}>
                <div class="flex items-center gap-3">
                  <span class="text-xl">{presentation.icon}</span>
                  <span class="font-semibold text-sm">{formatTimestamp(run.startTime)}</span>
                  <span class="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium text-white" style="background-color: {presentation.color}">
                    {run.status}
                  </span>
                </div>
                <span class="bg-transparent border-none text-base p-2 text-gray-500 transition-transform">
                  {expandedRunId === run.id ? '▼' : '▶'}
                </span>
              </button>

              <div class="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3 pt-3">
                <div class="flex gap-2 text-sm">
                  <span class="font-medium text-gray-500">Method:</span>
                  <span class="text-gray-900 dark:text-gray-100">{run.method || 'N/A'}</span>
                </div>
                {#if run.username}
                  <div class="flex gap-2 text-sm">
                    <span class="font-medium text-gray-500">Profile:</span>
                    <span class="text-gray-900 dark:text-gray-100">{run.username}</span>
                  </div>
                {/if}
                {#if run.duration}
                  <div class="flex gap-2 text-sm">
                    <span class="font-medium text-gray-500">Duration:</span>
                    <span class="text-gray-900 dark:text-gray-100">{run.duration}</span>
                  </div>
                {/if}
                {#if run.baseModel}
                  <div class="flex gap-2 text-sm">
                    <span class="font-medium text-gray-500">Base Model:</span>
                    <span class="text-gray-900 dark:text-gray-100">{run.baseModel}</span>
                  </div>
                {/if}
                {#if run.error}
                  <div class="flex gap-2 text-sm col-span-full text-red-500">
                    <span class="font-medium">Error:</span>
                    <span>{run.error}</span>
                  </div>
                {/if}
              </div>

              {#if expandedRunId === run.id}
                <div class="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  {#if loadingLogs}
                    <div class="flex items-center justify-center gap-3 py-8 text-gray-500">
                      <div class="w-4 h-4 border-2 border-gray-300 dark:border-gray-600 border-t-blue-500 rounded-full animate-spin"></div>
                      <span>Loading logs...</span>
                    </div>
                  {:else}
                    {#if readErrors.archive}
                      <button type="button" class="btn-secondary mb-3" on:click={() => loadRunLogs(run.id)}>Retry archived log</button>
                    {/if}
                    <div class="bg-gray-900 text-gray-100 font-mono text-xs p-4 rounded-md h-[500px] overflow-y-auto leading-relaxed">
                      {#each expandedLogs as line}
                        <div class="py-1 whitespace-pre-wrap break-all">{line}</div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
