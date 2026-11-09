<script lang="ts">
  import { onMount } from 'svelte';
  import type { OnboardingState } from '@metahuman/core/onboarding/types';
  import { apiFetch } from '../lib/client/api-config';
  import Step1Welcome from './onboarding/Step1_Welcome.svelte';
  import Step2PersonalityChoice from './onboarding/Step3_PersonalityChoice.svelte';
  import Step3Context from './onboarding/Step4_Context.svelte';
  import Step4Goals from './onboarding/Step5_Goals.svelte';
  import Step5Complete from './onboarding/Step6_Complete.svelte';

  export let onComplete: () => void;

  let loading = true;
  let error = '';
  let showSkipModal = false;
  let state: OnboardingState | null = null;

  async function loadState() {
    loading = true;
    error = '';
    try {
      const response = await apiFetch('/api/onboarding/state');
      const data = await response.json();
      if (!response.ok || !data.state) throw new Error(data.error || 'Failed to load progress');
      state = data.state;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Failed to load progress';
    } finally {
      loading = false;
    }
  }

  async function updateState(updates: { currentStep: number; stepsCompleted?: Partial<OnboardingState['stepsCompleted']> }) {
    loading = true;
    error = '';
    try {
      const response = await apiFetch('/api/onboarding/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
      const data = await response.json();
      if (!response.ok || !data.state) throw new Error(data.error || 'Failed to save progress');
      state = data.state;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Failed to save progress';
    } finally {
      loading = false;
    }
  }

  function prevStep() {
    if (currentStep > 1) return updateState({ currentStep: currentStep - 1 });
  }

  async function handleStepComplete(step: keyof OnboardingState['stepsCompleted']) {
    if (!state) return;
    await updateState({
      currentStep: Math.min(currentStep + 1, 5),
      stepsCompleted: { [step]: true },
    });
  }

  async function finishOnboarding(action: 'complete' | 'skip', reason?: string) {
    loading = true;
    error = '';
    try {
      const response = await apiFetch(`/api/onboarding/${action}`, {
        method: 'POST',
        ...(action === 'skip' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) } : {}),
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || `Failed to ${action} onboarding`);
      state = data.state;
      onComplete();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : `Failed to ${action} onboarding`;
    } finally {
      loading = false;
      showSkipModal = false;
    }
  }

  onMount(() => { void loadState(); });

  $: currentStep = state?.currentStep ?? 1;
  $: progressPercent = ((currentStep - 1) / 4) * 100;
</script>

<div class="onboarding-backdrop">
  <div class="onboarding-container">
    {#if state}
    <!-- Progress Bar -->
    <div class="progress-bar-track w-full h-2 mb-2">
      <div class="progress-bar-fill" style="width: {progressPercent}%"></div>
    </div>

    <div class="text-center text-sm text-white/60 dark:text-white/60 mb-8">
      Step {currentStep} of 5
    </div>

    <!-- Step Content -->
    <div class="min-h-[400px]">
      {#if currentStep === 1}
        <Step1Welcome onNext={() => handleStepComplete('welcome')} onSkip={() => showSkipModal = true} />
      {:else if currentStep === 2}
        <Step2PersonalityChoice
          onNext={() => handleStepComplete('personality')}
          onBack={prevStep}
        />
      {:else if currentStep === 3}
        <Step3Context
          onNext={() => handleStepComplete('context')}
          onBack={prevStep}
          onSkip={() => showSkipModal = true}
        />
      {:else if currentStep === 4}
        <Step4Goals
          recordedTasksCreated={state.dataCollected.tasksCreated ?? 0}
          onNext={() => handleStepComplete('goals')}
          onBack={prevStep}
          onSkip={() => showSkipModal = true}
        />
      {:else if currentStep === 5}
        <Step5Complete
          {state}
          completing={loading}
          onComplete={() => finishOnboarding('complete')}
          onBack={prevStep}
        />
      {/if}
    </div>

    {:else if loading}
      <p role="status">Loading your progress...</p>
    {:else}
      <button class="btn-secondary" on:click={loadState}>Retry loading progress</button>
    {/if}

    {#if error}
      <div role="alert" class="banner banner-error mt-4">{error}</div>
    {/if}
  </div>

  <!-- Skip Modal -->
  {#if showSkipModal}
    <div class="modal-overlay !z-[11000]">
      <div class="skip-modal" role="dialog" aria-modal="true" tabindex="-1">
        <h2 class="text-2xl font-bold mb-4 text-white dark:text-white">Skip Onboarding?</h2>

        <p class="text-white/80 dark:text-white/80 mb-6 leading-relaxed">
          You can add memories, personality details and goals after setup through the tools below.
        </p>

        <div>
          <h3 class="text-base font-semibold text-white/90 dark:text-white/90 mb-4">You can input data later through:</h3>

          <div class="flex flex-col gap-4 mb-6">
            <div class="utility-item">
              <div class="text-2xl flex-shrink-0">📝</div>
              <div class="flex-1">
                <strong class="block text-white/90 dark:text-white/90 mb-2">Memory Capture</strong>
                <ul class="list-none p-0 m-0">
                  <li class="text-sm text-white/70 dark:text-white/70 mb-1">Chat interface (main view)</li>
                  <li class="text-sm text-white/70 dark:text-white/70 mb-1">CLI: <code class="px-1.5 py-0.5 rounded text-sm text-blue-400 bg-white/10">./bin/mh capture "text"</code></li>
                  <li class="text-sm text-white/70 dark:text-white/70 mb-1">API: <code class="px-1.5 py-0.5 rounded text-sm text-blue-400 bg-white/10">POST /api/capture</code></li>
                </ul>
              </div>
            </div>

            <div class="utility-item">
              <div class="text-2xl flex-shrink-0">📁</div>
              <div class="flex-1">
                <strong class="block text-white/90 dark:text-white/90 mb-2">File Ingestion</strong>
                <ul class="list-none p-0 m-0">
                  <li class="text-sm text-white/70 dark:text-white/70 mb-1">Memory view → Inbox Imports</li>
                  <li class="text-sm text-white/70 dark:text-white/70 mb-1">CLI: <code class="px-1.5 py-0.5 rounded text-sm text-blue-400 bg-white/10">./bin/mh ingest &lt;file&gt;</code></li>
                  <li class="text-sm text-white/70 dark:text-white/70 mb-1">Files go to the selected profile's inbox.</li>
                </ul>
              </div>
            </div>

            <div class="utility-item">
              <div class="text-2xl flex-shrink-0">✏️</div>
              <div class="flex-1">
                <strong class="block text-white/90 dark:text-white/90 mb-2">Manual Persona Editing</strong>
                <ul class="list-none p-0 m-0">
                  <li class="text-sm text-white/70 dark:text-white/70 mb-1">Persona → Editor</li>
                  <li class="text-sm text-white/70 dark:text-white/70 mb-1">The editor saves changes through your profile's storage system.</li>
                </ul>
              </div>
            </div>
          </div>

          <p class="text-center text-sm text-white/70 dark:text-white/70 mt-4">
            📖 For detailed guidance, see the <a href="/user-guide" target="_blank" class="text-blue-400 underline">User Guide</a>
          </p>
        </div>

        <div class="flex gap-4 justify-center mt-8">
          <button class="onboarding-btn-primary" on:click={() => showSkipModal = false}>
            Continue Onboarding
          </button>
          <button class="btn-ghost" on:click={() => finishOnboarding('skip', 'user_declined')}>
            Skip to App
          </button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  /* Onboarding backdrop - unique gradient */
  .onboarding-backdrop {
    @apply fixed inset-0 flex items-center justify-center z-[10000] p-4 overflow-y-auto;
    background: linear-gradient(135deg, #1e293b 0%, #0f172a 50%, #020617 100%);
  }

  /* Onboarding container */
  .onboarding-container {
    @apply bg-slate-900 rounded-2xl shadow-2xl max-w-[800px] w-full p-8;
    animation: slideIn 0.3s ease-out;
  }
  @keyframes slideIn {
    from { transform: translateY(-20px); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }

  /* Skip modal */
  .skip-modal {
    @apply bg-slate-900 rounded-2xl max-w-[600px] w-full p-8 max-h-[80vh] overflow-y-auto;
  }

  /* Utility item cards */
  .utility-item {
    @apply flex gap-4 p-4 rounded-lg border border-white/10 bg-white/5;
  }

  /* Primary button with gradient */
  .onboarding-btn-primary {
    @apply py-3 px-6 rounded-lg text-base font-medium cursor-pointer transition-all border-0 text-white;
    background: linear-gradient(135deg, #60a5fa 0%, #a78bfa 100%);
  }
  .onboarding-btn-primary:hover {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(96, 165, 250, 0.4);
  }

  @media (max-width: 640px) {
    .onboarding-container { @apply p-6; }
    .skip-modal { @apply p-6; }
    .utility-item { @apply flex-col gap-2; }
  }
</style>
