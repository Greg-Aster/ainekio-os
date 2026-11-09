<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { apiFetch } from '../../lib/client/api-config';

  export let recordedTasksCreated = 0;
  export let onNext: () => void;
  export let onBack: () => void;
  export let onSkip: () => void;

  interface Goal {
    id: string;
    category: 'short' | 'mid' | 'long';
    entry: { goal: string; status?: string; description?: string; [key: string]: unknown };
    isNew: boolean;
    taskReceipt?: string;
  }

  let goals: Goal[] = [];
  let currentGoal = {
    title: '',
    category: 'short' as 'short' | 'mid' | 'long',
    description: '',
  };

  let saving = false;
  let error = '';
  let loading = true;
  let goalsLoaded = false;
  let tasksCreated = recordedTasksCreated;
  let active = true;

  onMount(() => { void loadGoals(); });
  onDestroy(() => { active = false; });

  const categories = [
    { value: 'short', label: 'Short-term (1-3 months)', icon: '🎯' },
    { value: 'mid', label: 'Mid-term (3-12 months)', icon: '📈' },
    { value: 'long', label: 'Long-term (1+ years)', icon: '🌟' },
  ] as const;

  async function loadGoals() {
    loading = true;
    error = '';
    try {
      const response = await apiFetch('/api/persona-core');
      const data = await response.json();
      if (!response.ok || !data.persona) throw new Error(data.error || 'Failed to load existing goals');
      goals = (['short', 'mid', 'long'] as const).flatMap(category => {
        const tier = `${category}Term`;
        return (data.persona.goals?.[tier] || []).map((entry: Goal['entry'] | string) => ({
          id: crypto.randomUUID(), category, isNew: false,
          entry: typeof entry === 'string' ? { goal: entry } : entry,
        }));
      });
      goalsLoaded = true;
    } catch (cause) {
      error = (cause as Error).message;
    } finally {
      loading = false;
    }
  }

  function addGoal() {
    if (!currentGoal.title.trim()) {
      error = 'Goal title is required';
      return;
    }

    const newGoal: Goal = {
      id: crypto.randomUUID(),
      category: currentGoal.category,
      isNew: true,
      entry: {
        goal: currentGoal.title.trim(),
        status: currentGoal.category === 'short' ? 'active' : currentGoal.category === 'mid' ? 'planning' : 'aspirational',
        description: currentGoal.description.trim() || undefined,
      },
    };

    goals = [...goals, newGoal];

    // Reset form
    currentGoal = {
      title: '',
      category: 'short',
      description: '',
    };
    error = '';
  }

  function removeGoal(id: string) {
    goals = goals.filter(g => g.id !== id);
  }

  async function handleNext() {
    if (!active) return;
    const selectedGoals = goals;

    saving = true;
    error = '';

    try {
      // Group goals by category for persona/core.json
      const groupedGoals = {
        shortTerm: selectedGoals.filter(g => g.category === 'short').map(g => g.entry),
        midTerm: selectedGoals.filter(g => g.category === 'mid').map(g => g.entry),
        longTerm: selectedGoals.filter(g => g.category === 'long').map(g => g.entry),
      };

      // Save goals to persona/core.json
      const personaResponse = await apiFetch('/api/persona-core', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goals: groupedGoals,
        }),
      });

      const persona = await personaResponse.json();
      if (!personaResponse.ok || !persona.success) throw new Error(persona.error || 'Failed to save goals to persona');
      if (!active) return;

      // Create tasks for short-term goals
      for (const goal of selectedGoals.filter(g => g.isNew && g.category === 'short' && !g.taskReceipt)) {
        const taskResponse = await apiFetch('/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: goal.entry.goal,
            description: goal.entry.description,
            priority: 'medium',
          }),
        });

        const task = await taskResponse.json();
        if (!taskResponse.ok || !task.filepath) throw new Error(task.error || `Task creation was not acknowledged: ${goal.entry.goal}`);
        goal.taskReceipt = task.filepath;
        tasksCreated++;
        if (!active) return;
      }

      // Update onboarding state
      const progress = await apiFetch('/api/onboarding/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: {
            dataCollected: {
              tasksCreated,
            },
          },
        }),
      });

      const data = await progress.json();
      if (!progress.ok || !data.state) throw new Error(data.error || 'Failed to save goal progress');
      if (active && goals === selectedGoals) onNext();
    } catch (err) {
      error = (err as Error).message;
    } finally {
      saving = false;
    }
  }

  function getCategoryIcon(category: 'short' | 'mid' | 'long'): string {
    const cat = categories.find(c => c.value === category);
    return cat?.icon || '🎯';
  }

  function getCategoryLabel(category: 'short' | 'mid' | 'long'): string {
    const cat = categories.find(c => c.value === category);
    return cat?.label || 'Short-term';
  }
</script>

<div class="flex flex-col gap-8 max-w-3xl mx-auto p-8 md:p-4">
  <div>
    <h2 class="text-3xl font-semibold mb-2 text-gray-900 dark:text-gray-50">What Are Your Goals?</h2>
    <p class="text-base leading-relaxed text-gray-500 dark:text-gray-400">
      Tell your Ainekio OS what you want to achieve. These goals will guide its autonomous actions
      and help it prioritize tasks that align with your objectives.
    </p>
  </div>

  {#if !goalsLoaded}
    {#if loading}
      <p role="status">Loading existing goals...</p>
    {:else}
      <p role="alert">{error}</p>
      <button class="btn-secondary" on:click={loadGoals}>Retry loading goals</button>
    {/if}
  {:else}
  <div class="flex flex-col gap-6 p-6 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl">
    <div class="flex flex-col gap-2">
      <label for="title" class="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center gap-1">
        Goal Title
        <span class="text-red-500 font-bold">*</span>
      </label>
      <input
        id="title"
        type="text"
        bind:value={currentGoal.title}
        placeholder="What do you want to achieve?"
        maxlength="200"
        class="p-3 text-base font-inherit border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-50 transition-all focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
      />
    </div>

    <div class="flex flex-col gap-2">
      <label for="category" class="text-sm font-semibold text-gray-700 dark:text-gray-300">Timeframe</label>
      <div class="flex gap-3 flex-wrap md:flex-col">
        {#each categories as cat}
          <button
            type="button"
            class="flex-1 min-w-[150px] md:min-w-full flex flex-col items-center gap-2 p-4 bg-white dark:bg-gray-700 border-2 rounded-lg cursor-pointer transition-all hover:border-indigo-500 hover:-translate-y-0.5 {currentGoal.category === cat.value ? 'border-indigo-500 bg-gradient-to-br from-indigo-500/10 to-purple-500/10 dark:from-indigo-400/10 dark:to-purple-400/10' : 'border-gray-300 dark:border-gray-600'}"
            on:click={() => currentGoal.category = cat.value}
          >
            <span class="text-3xl">{cat.icon}</span>
            <span class="text-sm font-medium text-gray-700 dark:text-gray-300 text-center">{cat.label}</span>
          </button>
        {/each}
      </div>
    </div>

    <div class="flex flex-col gap-2">
      <label for="description" class="text-sm font-semibold text-gray-700 dark:text-gray-300">Description (optional)</label>
      <textarea
        id="description"
        bind:value={currentGoal.description}
        placeholder="Add more details about this goal..."
        rows="3"
        maxlength="500"
        class="p-3 text-base font-inherit border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-50 transition-all focus:outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10 resize-y min-h-[80px]"
      ></textarea>
      <div class="self-end text-xs text-gray-400 dark:text-gray-500 -mt-1">{currentGoal.description.length}/500</div>
    </div>

    <button
      class="px-6 py-3 text-base font-semibold bg-gradient-to-br from-emerald-500 to-emerald-600 text-white border-none rounded-lg cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-emerald-500/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:transform-none disabled:hover:shadow-none"
      on:click={addGoal}
      disabled={!currentGoal.title.trim()}
    >
      ➕ Add Goal
    </button>

    {#if error}
      <div class="flex items-center gap-2 px-4 py-3 bg-red-100 dark:bg-red-900 border border-red-500 rounded-md text-red-800 dark:text-red-200 text-sm">
        <span>⚠️</span>
        {error}
      </div>
    {/if}
  </div>

  {#if goals.length > 0}
    <div class="flex flex-col gap-4">
      <h3 class="text-xl font-semibold text-gray-900 dark:text-gray-50">Your Goals ({goals.length})</h3>
      <div class="flex flex-col gap-3">
        {#each goals as goal}
          <div class="flex flex-col gap-3 p-4 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg transition-all hover:shadow-lg hover:shadow-black/10">
            <div class="flex justify-between items-center">
              <div class="flex items-center gap-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-md">
                <span>{getCategoryIcon(goal.category)}</span>
                <span class="text-sm font-medium text-gray-500 dark:text-gray-400">{getCategoryLabel(goal.category)}</span>
              </div>
              <button
                class="px-2 py-1 text-xl text-red-500 bg-transparent border-none rounded cursor-pointer transition-all hover:bg-red-100 dark:hover:bg-red-900 hover:text-red-600"
                on:click={() => removeGoal(goal.id)}
                aria-label="Remove goal"
              >
                ✕
              </button>
            </div>
            <div class="flex flex-col gap-2">
              <h4 class="text-lg font-semibold text-gray-900 dark:text-gray-50">{goal.entry.goal}</h4>
              {#if goal.entry.description}
                <p class="text-sm leading-relaxed text-gray-500 dark:text-gray-400">{goal.entry.description}</p>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {:else}
    <div class="flex flex-col items-center gap-4 py-12 px-8 text-center">
      <div class="text-6xl opacity-50">🎯</div>
      <h3 class="text-xl font-semibold text-gray-700 dark:text-gray-300">No goals yet</h3>
      <p class="text-base text-gray-500 dark:text-gray-400">Add your first goal above to get started</p>
    </div>
  {/if}

  <div class="flex items-start gap-3 p-4 bg-blue-50 dark:bg-blue-900 border-l-4 border-blue-500 dark:border-blue-400 rounded">
    <div class="text-2xl flex-shrink-0">💡</div>
    <div class="text-sm leading-relaxed text-blue-800 dark:text-blue-100">
      <strong class="text-blue-900 dark:text-blue-200">Why set goals?</strong>
      <ul class="my-2 pl-6">
        <li>Your Ainekio OS will prioritize actions that align with your objectives</li>
        <li>New short-term goals added here will be converted into actionable tasks; saved goals are retained without creating duplicate tasks</li>
        <li>The system will track progress and suggest next steps</li>
        <li>Autonomous agents will work towards these goals in the background</li>
      </ul>
      <p class="mt-2">
        You can always add, edit, or remove goals later through the Task Manager or Persona Editor.
      </p>
    </div>
  </div>

  <div class="p-4 px-6 bg-amber-100 dark:bg-amber-900 border-l-4 border-amber-400 dark:border-amber-500 rounded">
    <p class="text-sm leading-relaxed text-amber-800 dark:text-amber-200">
      <strong class="text-amber-900 dark:text-amber-300">Not sure what goals to add?</strong> No problem! You can skip this step
      and define goals later as you use the system.
    </p>
  </div>

  {/if}

  <div class="flex justify-between gap-4 pt-4 border-t border-gray-200 dark:border-gray-700 md:flex-col">
    <button class="px-6 py-3 text-base font-semibold bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg cursor-pointer transition-all hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={onBack} disabled={saving}>
      ← Back
    </button>
    <button class="px-6 py-3 text-base font-semibold bg-transparent text-gray-500 dark:text-gray-400 border-none rounded-lg cursor-pointer transition-all hover:text-gray-900 dark:hover:text-gray-50 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed" on:click={onSkip} disabled={saving}>
      Skip
    </button>
    {#if goalsLoaded}
    <button
      class="px-6 py-3 text-base font-semibold bg-gradient-to-br from-indigo-500 to-purple-600 text-white border-none rounded-lg cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-500/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:transform-none disabled:hover:shadow-none"
      on:click={handleNext}
      disabled={saving}
    >
      {saving ? 'Saving...' : 'Continue →'}
    </button>
    {/if}
  </div>
</div>
