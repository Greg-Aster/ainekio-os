<script lang="ts">
  import { apiFetch } from '../lib/client/api-config';
  import { onMount } from 'svelte';

  interface Chapter {
    id: string;
    title: string;
    content?: string;
    number: string;
    category: string;
    path: string;
  }

  interface Category {
    id: string;
    name: string;
    chapters: Chapter[];
    order: number;
  }

  interface SearchResult {
    id: string;
    title: string;
    category: string;
    snippet: string;
  }

  let categories: Category[] = [];
  let currentChapter: Chapter | null = null;
  let prevChapter: { id: string; title: string } | null = null;
  let nextChapter: { id: string; title: string } | null = null;
  let loading = true;
  let error = '';
  let guideRead: AbortController | undefined;
  let chapterRead: AbortController | undefined;
  let searchRead: AbortController | undefined;
  let selectedChapterId = '';
  let chapterLoading = false;
  let chapterError = '';
  let collapsedCategories: Set<string> = new Set();
  let searchQuery = '';
  let searchResults: SearchResult[] = [];
  let searchAttempted = false;
  let searching = false;
  let searchError = '';

  onMount(() => {
    window.addEventListener('hashchange', handleHashChange);
    void loadGuide();
    return () => {
      window.removeEventListener('hashchange', handleHashChange);
      guideRead?.abort();
      chapterRead?.abort();
      searchRead?.abort();
    };
  });

  async function loadGuide() {
    guideRead?.abort();
    const current = new AbortController();
    guideRead = current;
    loading = true;
    error = '';
    try {
      const response = await apiFetch('/api/user-guide', { signal: current.signal });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || 'Failed to load user guide');
      categories = data.categories;
      if (!selectedChapterId) {
        const initial = window.location.hash.substring(1) || categories[0]?.chapters[0]?.id;
        if (initial) void loadChapter(initial);
      }
    } catch (e) {
      if (!current.signal.aborted) error = (e as Error).message;
    } finally {
      if (guideRead === current) { guideRead = undefined; loading = false; }
    }
  }

  function handleHashChange() {
    const hash = window.location.hash.substring(1);
    if (hash && hash !== selectedChapterId) void loadChapter(hash);
  }

  async function loadChapter(chapterId: string) {
    chapterRead?.abort();
    const current = new AbortController();
    chapterRead = current;
    selectedChapterId = chapterId;
    chapterLoading = true;
    chapterError = '';
    try {
      const response = await apiFetch(`/api/user-guide/${encodeURIComponent(chapterId)}`, { signal: current.signal });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || 'Chapter not found');
      currentChapter = data.chapter;
      prevChapter = data.prev;
      nextChapter = data.next;
      history.replaceState(null, '', `#${chapterId}`);
      const contentArea = document.querySelector('.chapter-content');
      if (contentArea) contentArea.scrollTop = 0;
    } catch (e) {
      if (!current.signal.aborted) chapterError = (e as Error).message;
    } finally {
      if (chapterRead === current) { chapterRead = undefined; chapterLoading = false; }
    }
  }

  function toggleCategory(categoryId: string) {
    if (collapsedCategories.has(categoryId)) {
      collapsedCategories.delete(categoryId);
    } else {
      collapsedCategories.add(categoryId);
    }
    collapsedCategories = collapsedCategories; // Trigger reactivity
  }

  async function searchGuide() {
    searchRead?.abort();
    searchAttempted = true;
    searchError = '';
    searchResults = [];
    searching = false;
    const query = searchQuery.trim();
    if (query.length < 2) {
      searchError = 'Enter at least two characters.';
      return;
    }
    const current = new AbortController();
    searchRead = current;
    searching = true;
    try {
      const response = await apiFetch(`/api/user-guide/search?q=${encodeURIComponent(query)}`, { signal: current.signal });
      const data = await response.json();
      if (current.signal.aborted) return;
      if (!response.ok) throw new Error(data.error || 'Search is unavailable');
      searchResults = data.results;
    } catch (e) {
      if (!current.signal.aborted) searchError = (e as Error).message;
    } finally {
      if (searchRead === current) { searchRead = undefined; searching = false; }
    }
  }

  function clearSearch() {
    searchRead?.abort();
    searchRead = undefined;
    searching = false;
    searchQuery = '';
    searchResults = [];
    searchAttempted = false;
    searchError = '';
  }
</script>

<div class="flex h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
  <!-- Chapter Index Sidebar -->
  <aside class="w-[280px] border-r border-gray-200 dark:border-gray-800 flex flex-col bg-gray-50 dark:bg-gray-900 shrink-0">
    <div class="p-6 pb-4 border-b border-gray-200 dark:border-gray-800">
      <h2 class="text-2xl font-bold mb-2 text-gray-900 dark:text-gray-100">User Guide</h2>
      <p class="text-sm text-gray-500 dark:text-gray-400 m-0">Ainekio OS Manual</p>
      <form class="mt-4 flex gap-2" on:submit|preventDefault={searchGuide}>
        <input
          class="min-w-0 flex-1 rounded-md border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-950 px-2.5 py-1.5 text-sm text-gray-900 dark:text-gray-100"
          type="search"
          bind:value={searchQuery}
          aria-label="Search the user guide"
          placeholder="Search guide"
        />
        <button
          class="rounded-md border-0 bg-blue-600 px-2.5 py-1.5 text-sm font-semibold text-white cursor-pointer hover:bg-blue-700 disabled:opacity-60"
          type="submit"
          disabled={searching}
        >
          {searching ? '...' : 'Search'}
        </button>
      </form>
      {#if searchQuery || searchAttempted}
        <button
          class="mt-2 border-0 bg-transparent p-0 text-xs text-gray-500 dark:text-gray-400 underline cursor-pointer"
          type="button"
          on:click={clearSearch}
        >Clear search</button>
      {/if}
    </div>

    {#if searchError}
      <p class="m-0 border-b border-gray-200 dark:border-gray-800 px-6 py-3 text-sm text-red-600 dark:text-red-400">{searchError}</p>
    {:else if searchAttempted && !searching}
      <div class="max-h-64 overflow-y-auto border-b border-gray-200 dark:border-gray-800 py-2">
        {#if searchResults.length === 0}
          <p class="m-0 px-6 py-2 text-sm text-gray-500 dark:text-gray-400">No matching chapters.</p>
        {:else}
          {#each searchResults as result}
            <button
              class="block w-full border-0 bg-transparent px-6 py-2 text-left cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800"
              type="button"
              on:click={() => loadChapter(result.id)}
            >
              <span class="block text-sm font-semibold text-gray-900 dark:text-gray-100">{result.title}</span>
              {#if result.snippet}
                <span class="mt-1 block text-xs text-gray-500 dark:text-gray-400">{result.snippet}</span>
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {/if}

    <nav class="flex-1 overflow-y-auto py-2">
      {#if loading}
        <div class="px-6 py-4 text-gray-500">Loading...</div>
      {:else if error}
        <div class="px-6 py-4 text-red-500">{error}</div>
      {:else}
        {#each categories as category}
          <div class="category-section" class:collapsed={collapsedCategories.has(category.id)}>
            <button
              class="w-full flex items-center justify-between px-6 py-2.5 border-0 bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-200 font-bold text-[0.8125rem] text-left cursor-pointer transition-colors uppercase tracking-wide hover:bg-gray-200 dark:hover:bg-gray-700"
              on:click={() => toggleCategory(category.id)}
            >
              <span class="flex-1">{category.name}</span>
              <span class="text-xs text-gray-500 dark:text-gray-400">{collapsedCategories.has(category.id) ? '>' : 'v'}</span>
            </button>
            <ul class="list-none p-0 m-0 chapter-list">
              {#each category.chapters as chapter}
                <li>
                  <button
                    class="w-full flex items-center gap-3 px-6 py-3 border-0 bg-transparent text-gray-600 dark:text-gray-400 text-left cursor-pointer transition-colors text-[0.9375rem] hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100
                           {currentChapter?.id === chapter.id ? 'bg-blue-50 dark:bg-blue-900 text-blue-600 dark:text-blue-300 font-semibold' : ''}"
                    on:click={() => loadChapter(chapter.id)}
                  >
                    <span class="font-bold text-sm min-w-[1.5rem] {currentChapter?.id === chapter.id ? 'text-blue-600 dark:text-blue-300' : 'text-gray-500 dark:text-gray-400'}">{chapter.number}</span>
                    <span class="flex-1">{chapter.title}</span>
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        {/each}
      {/if}
    </nav>
  </aside>

  <!-- Chapter Content -->
  <main class="chapter-content flex-1 overflow-y-auto bg-white dark:bg-gray-950">
    {#if loading}
      <div class="p-8 text-gray-500">Loading user guide...</div>
    {:else if error}
      <div class="flex flex-col items-center justify-center h-full p-8 text-center">
        <h2 class="text-2xl mb-2 text-gray-900 dark:text-gray-100">User Guide Unavailable</h2>
        <p class="text-gray-500 dark:text-gray-400">{error}</p>
        <button class="mt-4 rounded bg-blue-600 px-4 py-2 text-white" on:click={loadGuide}>Retry loading user guide</button>
      </div>
    {:else}
      {#if chapterError}
        <div class="m-4 rounded border border-red-500 p-3 text-sm text-red-600 dark:text-red-400">
          Could not load {selectedChapterId}: {chapterError}
          <button class="ml-2 underline" on:click={() => loadChapter(selectedChapterId)}>Retry chapter</button>
        </div>
      {/if}
      {#if chapterLoading}<div class="p-4 text-gray-500">Loading chapter…</div>{/if}
      {#if currentChapter}
        <article class="max-w-[800px] mx-auto py-12 px-8">
          <div class="min-h-[calc(100vh-12rem)]">
            <div class="prose-content">
              {@html currentChapter.content}
            </div>
          </div>

          <nav class="flex justify-between gap-4 mt-12 pt-8 border-t border-gray-200 dark:border-gray-800">
            {#if prevChapter}
              {@const previous = prevChapter}
              <button
                class="flex items-center gap-3 px-5 py-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 cursor-pointer transition-all text-[0.9375rem] max-w-[45%] hover:border-blue-600 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/50 hover:-translate-y-0.5"
                on:click={() => loadChapter(previous.id)}
              >
                <span class="text-xl font-semibold text-blue-600 dark:text-blue-400">←</span>
                <span class="flex flex-col gap-1">
                  <span class="text-xs uppercase font-semibold text-gray-500 dark:text-gray-400 tracking-wide">Previous</span>
                  <span class="font-medium">{prevChapter.title}</span>
                </span>
              </button>
            {/if}

            {#if nextChapter}
              {@const next = nextChapter}
              <button
                class="flex items-center gap-3 px-5 py-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 cursor-pointer transition-all text-[0.9375rem] max-w-[45%] ml-auto hover:border-blue-600 dark:hover:border-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/50 hover:-translate-y-0.5"
                on:click={() => loadChapter(next.id)}
              >
                <span class="flex flex-col gap-1">
                  <span class="text-xs uppercase font-semibold text-gray-500 dark:text-gray-400 tracking-wide">Next</span>
                  <span class="font-medium">{nextChapter.title}</span>
                </span>
                <span class="text-xl font-semibold text-blue-600 dark:text-blue-400">→</span>
              </button>
            {/if}
          </nav>
        </article>
      {:else if !chapterLoading && !chapterError}
        <div class="flex flex-col items-center justify-center h-full p-8 text-center">
          <h2 class="text-2xl mb-2 text-gray-900 dark:text-gray-100">Select a Chapter</h2>
          <p class="text-gray-500 dark:text-gray-400">Choose a chapter from the sidebar to begin reading.</p>
        </div>
      {/if}
    {/if}
  </main>
</div>

<style>
  .prose-content {
    @apply leading-7;
  }

  .prose-content :global(h1) {
    @apply text-4xl font-extrabold mb-6 text-gray-900 leading-tight;
  }

  :global(.dark) .prose-content :global(h1) {
    @apply text-gray-100;
  }

  .prose-content :global(h2) {
    @apply text-3xl font-bold mt-10 mb-4 text-gray-900 leading-snug;
  }

  :global(.dark) .prose-content :global(h2) {
    @apply text-gray-100;
  }

  .prose-content :global(h3) {
    @apply text-2xl font-semibold mt-8 mb-3 text-gray-900;
  }

  :global(.dark) .prose-content :global(h3) {
    @apply text-gray-100;
  }

  .prose-content :global(h4) {
    @apply text-xl font-semibold mt-6 mb-3 text-gray-700;
  }

  :global(.dark) .prose-content :global(h4) {
    @apply text-gray-300;
  }

  .prose-content :global(p) {
    @apply mb-5 text-gray-700;
  }

  :global(.dark) .prose-content :global(p) {
    @apply text-gray-300;
  }

  .prose-content :global(strong) {
    @apply font-semibold text-gray-900;
  }

  :global(.dark) .prose-content :global(strong) {
    @apply text-gray-100;
  }

  .prose-content :global(code) {
    @apply bg-gray-100 px-1.5 py-0.5 rounded text-sm text-red-600 font-medium font-mono;
  }

  :global(.dark) .prose-content :global(code) {
    @apply bg-gray-800 text-red-400;
  }

  .prose-content :global(ul),
  .prose-content :global(ol) {
    @apply mb-5 pl-7 text-gray-700;
  }

  :global(.dark) .prose-content :global(ul),
  :global(.dark) .prose-content :global(ol) {
    @apply text-gray-300;
  }

  .prose-content :global(li) {
    @apply mb-2 leading-7;
  }

  .prose-content :global(li > p) {
    @apply mb-2;
  }

  .prose-content :global(a) {
    @apply text-blue-600 no-underline font-medium hover:underline;
  }

  :global(.dark) .prose-content :global(a) {
    @apply text-blue-400;
  }

  .prose-content :global(blockquote) {
    @apply border-l-4 border-blue-600 pl-5 my-6 text-gray-600 italic;
  }

  :global(.dark) .prose-content :global(blockquote) {
    @apply border-blue-400 text-gray-400;
  }

  .prose-content :global(table) {
    @apply w-full border-collapse my-6 text-sm;
  }

  .prose-content :global(th),
  .prose-content :global(td) {
    @apply p-3 text-left border-b border-gray-200;
  }

  :global(.dark) .prose-content :global(th),
  :global(.dark) .prose-content :global(td) {
    @apply border-gray-700;
  }

  .prose-content :global(th) {
    @apply font-semibold text-gray-900 bg-gray-50;
  }

  :global(.dark) .prose-content :global(th) {
    @apply text-gray-100 bg-gray-900;
  }

  .prose-content :global(td) {
    @apply text-gray-700;
  }

  :global(.dark) .prose-content :global(td) {
    @apply text-gray-300;
  }

  .prose-content :global(hr) {
    @apply border-0 border-t border-gray-200 my-8;
  }

  :global(.dark) .prose-content :global(hr) {
    @apply border-gray-700;
  }

  /* Collapsible chapter list animation */

  .chapter-list {
    max-height: 1000px;
    overflow: hidden;
    transition: max-height 0.3s ease-in-out, opacity 0.2s;
    opacity: 1;
  }

  .category-section.collapsed .chapter-list {
    max-height: 0;
    opacity: 0;
  }

  .prose-content :global(ul) {
    list-style: disc;
    margin: 1rem 0;
    padding-left: 1.75rem;
  }

  .prose-content :global(ol) {
    list-style: decimal;
    margin: 1rem 0;
    padding-left: 1.75rem;
  }

  .prose-content :global(li + li) {
    margin-top: 0.5rem;
  }

  .prose-content :global(pre) {
    @apply bg-gray-800 p-5 rounded-lg overflow-x-auto my-6 border border-gray-700;
    overflow-x: auto;
  }

  :global(.dark) .prose-content :global(pre) {
    @apply bg-gray-900 border-gray-800;
  }

  .prose-content :global(pre code) {
    @apply bg-transparent p-0 text-gray-200 text-sm leading-relaxed;
    background: transparent;
    color: inherit;
    padding: 0;
  }
</style>
