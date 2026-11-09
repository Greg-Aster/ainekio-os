<script lang="ts">
  import { onDestroy } from 'svelte';
  import { apiFetch } from '../../lib/client/api-config';

  export let onNext: () => void;
  export let onBack: () => void;
  export let onSkip: () => void;

  let uploadedFiles: File[] = [];
  let uploading = false;
  let uploadProgress = 0;
  let uploadStatus = '';
  let error = '';
  let dragActive = false;
  let active = true;

  let fileInput: HTMLInputElement;
  onDestroy(() => { active = false; });

  function handleDrop(e: DragEvent) {
    dragActive = false;

    const files = Array.from(e.dataTransfer?.files || []);
    addFiles(files);
  }

  function handleFileSelect(e: Event) {
    const target = e.target as HTMLInputElement;
    const files = Array.from(target.files || []);
    addFiles(files);
    target.value = '';
  }

  function addFiles(files: File[]) {
    // Filter for supported file types
    const supportedTypes = [
      'text/plain',
      'text/markdown',
      'application/pdf',
      'application/json',
      'text/csv',
    ];

    const validFiles = files.filter(f => {
      return supportedTypes.includes(f.type) ||
             f.name.endsWith('.txt') ||
             f.name.endsWith('.md') ||
             f.name.endsWith('.pdf') ||
             f.name.endsWith('.json') ||
             f.name.endsWith('.csv');
    });

    error = validFiles.length < files.length
      ? 'Some files were skipped (unsupported type). Supported: .txt, .md, .pdf, .json, .csv'
      : '';

    uploadedFiles = [...uploadedFiles, ...validFiles];
  }

  function removeFile(index: number) {
    uploadedFiles = uploadedFiles.filter((_, i) => i !== index);
  }

  async function handleUpload() {
    if (!active) return;
    if (uploadedFiles.length === 0) {
      // Skip is OK - user might not have documents to import
      onNext();
      return;
    }

    uploading = true;
    uploadProgress = 0;
    uploadStatus = '';
    error = '';
    const totalFiles = uploadedFiles.length;
    let storedFiles = 0;

    try {
      while (storedFiles < totalFiles) {
        const file = uploadedFiles[0];
        uploadStatus = `Uploading ${file.name}...`;

        const formData = new FormData();
        formData.append('file', file);

        const response = await apiFetch('/api/ingest', {
          method: 'POST',
          body: formData,
        });

        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(`${file.name}: ${data.error || 'Failed to store file in inbox'}`);

        removeFile(0);
        storedFiles++;
        uploadProgress = (storedFiles / totalFiles) * 100;
        if (!active) return;
      }

      uploadStatus = `✓ Stored ${storedFiles} file${storedFiles > 1 ? 's' : ''} in your inbox`;
      if (uploadedFiles.length === 0) onNext();
    } catch (err) {
      uploadStatus = `${storedFiles} of ${totalFiles} uploads acknowledged`;
      error = err instanceof Error ? err.message : 'Upload completion was not confirmed';
    } finally {
      uploading = false;
    }
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
</script>

<div class="flex flex-col gap-8 max-w-3xl mx-auto p-8 md:p-4">
  <div>
    <h2 class="text-3xl font-semibold mb-2 text-gray-900 dark:text-gray-50">Import Your Context</h2>
    <p class="text-base leading-relaxed text-gray-500 dark:text-gray-400">
      Upload documents, journals, notes, or any text files that provide context about your life,
      work, or interests. Uploads are stored in your selected profile's inbox for later processing.
    </p>
  </div>

  <div class="flex flex-col gap-6">
    <div
      class="flex flex-col items-center justify-center gap-4 py-12 px-8 md:py-8 md:px-4 border-2 border-dashed rounded-xl transition-all {dragActive ? 'border-indigo-500 bg-blue-50 dark:bg-blue-900 scale-[1.02]' : 'border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-800'}"
      on:dragenter|preventDefault={() => dragActive = true}
      on:dragleave|preventDefault={() => dragActive = false}
      on:dragover|preventDefault
      on:drop|preventDefault={handleDrop}
    >
      <div class="text-6xl">📁</div>
      <h3 class="text-xl font-semibold text-gray-900 dark:text-gray-50">Drag & Drop Files Here</h3>
      <p class="text-base text-gray-500 dark:text-gray-400">or</p>
      <button
        class="px-8 py-3 text-base font-semibold bg-gradient-to-br from-indigo-500 to-purple-600 text-white border-none rounded-lg cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-500/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:transform-none disabled:hover:shadow-none"
        on:click={() => fileInput.click()}
        disabled={uploading}
      >
        Browse Files
      </button>
      <input
        bind:this={fileInput}
        type="file"
        multiple
        accept=".txt,.md,.pdf,.json,.csv,text/plain,text/markdown,application/pdf,application/json,text/csv"
        on:change={handleFileSelect}
        style="display: none"
      />
      <p class="text-sm text-gray-400">
        Upload types: Text (.txt), Markdown (.md), PDF (.pdf), JSON (.json), CSV (.csv)
      </p>
      <p class="text-sm text-gray-500 dark:text-gray-400">
        Inbox Ingestor currently processes .txt, .md and .json. PDF and CSV files can be stored here, but the current ingestor does not process them.
      </p>
    </div>

    {#if uploadedFiles.length > 0}
      <div class="flex flex-col gap-4">
        <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-50">Pending Uploads ({uploadedFiles.length})</h3>
        <p class="text-sm text-gray-500 dark:text-gray-400">
          Files leave this list after storage is acknowledged. If the connection is interrupted, check Inbox Imports before retrying.
        </p>
        <div class="flex flex-col gap-2">
          {#each uploadedFiles as file, i}
            <div class="flex items-center gap-4 px-4 py-3 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg transition-all hover:shadow-md">
              <div class="text-2xl flex-shrink-0">
                {#if file.type === 'application/pdf' || file.name.endsWith('.pdf')}
                  📄
                {:else if file.name.endsWith('.md')}
                  📝
                {:else if file.name.endsWith('.json')}
                  🔧
                {:else if file.name.endsWith('.csv')}
                  📊
                {:else}
                  📃
                {/if}
              </div>
              <div class="flex-1 flex flex-col gap-1 min-w-0">
                <div class="text-base font-medium text-gray-900 dark:text-gray-50 overflow-hidden text-ellipsis whitespace-nowrap">{file.name}</div>
                <div class="text-xs text-gray-500 dark:text-gray-400">{formatFileSize(file.size)}</div>
              </div>
              <button
                class="px-2 py-1 text-xl text-red-500 bg-transparent border-none rounded cursor-pointer transition-all flex-shrink-0 hover:bg-red-100 dark:hover:bg-red-900 hover:text-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
                on:click={() => removeFile(i)}
                disabled={uploading}
                aria-label="Remove file"
              >
                ✕
              </button>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    {#if uploading}
      <div class="flex flex-col gap-2">
        <div class="h-3 bg-gray-200 dark:bg-gray-700 rounded-md overflow-hidden">
          <div class="h-full bg-gradient-to-r from-indigo-500 to-purple-600 transition-all duration-300" style="width: {uploadProgress}%"></div>
        </div>
      </div>
    {/if}

    {#if uploadStatus}
      <p role="status" class="text-sm text-gray-500 dark:text-gray-400 text-center">{uploadStatus}</p>
    {/if}

    {#if error}
      <div role="alert" class="flex items-center gap-2 px-4 py-3 bg-red-100 dark:bg-red-900 border border-red-500 rounded-md text-red-800 dark:text-red-200 text-sm">
        <span>⚠️</span>
        {error}
      </div>
    {/if}
  </div>

  <div class="flex items-start gap-3 p-4 bg-blue-50 dark:bg-blue-900 border-l-4 border-blue-500 dark:border-blue-400 rounded">
    <div class="text-2xl flex-shrink-0">💡</div>
    <div class="text-sm leading-relaxed text-blue-800 dark:text-blue-100">
      <strong class="text-blue-900 dark:text-blue-200">What to upload:</strong>
      <ul class="my-2 pl-6">
        <li>Personal journals or diary entries</li>
        <li>Work documents or project notes</li>
        <li>Creative writing or blog posts</li>
        <li>Meeting notes or conversation logs</li>
        <li>Any text that represents your thoughts, interests, or experiences</li>
      </ul>
      <p class="mt-2">
        <strong class="text-blue-900 dark:text-blue-200">Privacy:</strong> Files are stored in the inbox of your selected Ainekio OS server for the Inbox Ingestor. Uploading does not mean they have been processed into memories.
      </p>
    </div>
  </div>

  <div class="p-4 px-6 bg-amber-100 dark:bg-amber-900 border-l-4 border-amber-400 dark:border-amber-500 rounded">
    <p class="text-sm leading-relaxed text-amber-800 dark:text-amber-200">
      <strong class="text-amber-900 dark:text-amber-300">Don't have files to upload?</strong> No problem! You can skip this step
      and add context later through Memory Capture, Chat, or the File Ingestion utility.
    </p>
  </div>

  <div class="flex justify-between gap-4 pt-4 border-t border-gray-200 dark:border-gray-700 md:flex-col">
    <button class="px-6 py-3 text-base font-semibold bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-lg cursor-pointer transition-all hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed" on:click={onBack} disabled={uploading}>
      ← Back
    </button>
    <button class="px-6 py-3 text-base font-semibold bg-transparent text-gray-500 dark:text-gray-400 border-none rounded-lg cursor-pointer transition-all hover:text-gray-900 dark:hover:text-gray-50 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed" on:click={onSkip} disabled={uploading}>
      Skip
    </button>
    <button
      class="px-6 py-3 text-base font-semibold bg-gradient-to-br from-indigo-500 to-purple-600 text-white border-none rounded-lg cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-lg hover:shadow-indigo-500/40 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:transform-none disabled:hover:shadow-none"
      on:click={handleUpload}
      disabled={uploading}
    >
      {uploading ? 'Uploading...' : uploadedFiles.length > 0 ? 'Upload & Continue →' : 'Continue →'}
    </button>
  </div>
</div>
