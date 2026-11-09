<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { readServerEvents } from '../lib/client/sse';
  import { slide } from 'svelte/transition';
  import { isOwner } from '../stores/security-policy';
  import { apiEventSource, apiFetch } from '../lib/client/api-config';

  import type { Desire, DesirePlan, DesireScratchpadEntry, DesireMetrics, DesireGoalType, AgencyMetrics, AgencyConfig } from '@metahuman/core/agency/types';
  import { coordinatorSnapshot, coordinatorConnection, coordinatorError, useWorkCoordinator } from '../lib/stores/work-coordinator';

  const riskLevels = ['none', 'low', 'medium', 'high', 'critical'] as const;
  type RiskPolicyList = 'autoApproveRisk' | 'requireApprovalRisk' | 'blockRisk';

  // State
  let desires: Desire[] = [];
  let metrics: AgencyMetrics | null = null;
  let summary: { total: number; active: number; waiting: number; needsAction: number; completed: number; failed: number } | null = null;
  let agencyConfig: AgencyConfig | null = null;
  let activationThreshold: number | null = null;
  let savingAgencyConfig = false;
  let agencyConfigDirty = false;
  let dataError = '';
  let listRead: AbortController | null = null;
  let executionRead: AbortController | null = null;

  let loading = true;
  let error = '';
  let statusFilter: string = 'open';
  const statusFilters = [
    { value: 'active', label: 'Active (Operational)', icon: '🔄' },
    { value: 'waiting', label: 'Waiting', icon: '⏳' },
    { value: 'open', label: 'All Open', icon: '📂' },
    { value: 'needs_action', label: 'Needs Your Action', icon: '⚠️' },
    { value: 'completed', label: 'Completed', icon: '✅' },
    { value: 'archived', label: 'Archived', icon: '📦' },
    { value: 'all', label: 'All', icon: '' },
  ];
  $: sortedDesires = [...desires].sort((a, b) => (b.strength || 0) - (a.strength || 0));
  $: statusFilterLabel = statusFilters.find(filter => filter.value === statusFilter)?.label;
  let processingId: string | null = null;

  // New desire form
  let showNewDesire = false;
  let newDesire = {
    title: '',
    description: '',
    reason: '',
    risk: 'low' as 'none' | 'low' | 'medium' | 'high',
    // Advanced options
    goalType: 'one_time' as 'one_time' | 'recurring' | 'long_running',
    strength: 0.8,
    status: 'pending' as 'nascent' | 'pending',
    decayRate: 0.03,
    tags: '',
  };
  let showAdvancedOptions = false;

  // Compact card expansion state
  let expandedCardId: string | null = null;  // Which desire card is expanded
  let expandedPlanId: string | null = null;  // Which plan details are shown (within expanded card)

  // Plan detail view and critique
  let critiqueText: Record<string, string> = {};
  let questionAnswers: Record<string, Record<string, string>> = {};
  let showHistoryFor: string | null = null;
  let revisingId: string | null = null;
  let showScratchpadFor: string | null = null;

  // Scratchpad file browser state
  let scratchpadEntries: DesireScratchpadEntry[] = [];
  let scratchpadFiles: string[] = [];
  let scratchpadTotal = 0;
  let scratchpadLoading = false;
  let scratchpadOffset = 0;
  const scratchpadLimit = 10;
  let expandedEntryIndex: number | null = null;

  // Individual file viewer state
  let selectedFileName: string | null = null;
  let selectedFileContent: DesireScratchpadEntry | null = null;
  let fileViewLoading = false;
  let scratchpadRead: AbortController | null = null;
  let fileRead: AbortController | null = null;
  let planListRead: AbortController | null = null;
  let planRead: AbortController | null = null;
  let scratchpadError = '';
  let fileError = '';
  let planListError = '';
  let planError = '';

  // Plan browser state
  let planVersions: string[] = [];
  let selectedPlanVersion: number | null = null;
  let viewingPlan: DesirePlan | null = null;

  // Execution data state
  let executionData: Record<string, any[]> = {}; // desireId -> executions array
  let executionLoading: Record<string, boolean> = {};
  let executionErrors: Record<string, string> = {};

  // Loading state for agent operations
  let agentProcessingId: string | null = null;
  let agentOperation: 'planning' | 'reviewing' | 'executing' | null = null;
  let currentLoadingMessage = '';

  // Coordinator workflow progress state
  let streamingPhase = '';
  let streamingOutput = '';
  let streamingSteps = 0;
  let streamEventSource: EventSource | null = null;
  const streamObservation = new AbortController();
  let operationRead: AbortController | null = null;

  function beginOperation(id: string, operation: 'planning' | 'reviewing' | 'executing', message: string): AbortController {
    finishOperation();
    operationRead = new AbortController();
    agentProcessingId = processingId = id;
    agentOperation = operation;
    streamingPhase = currentLoadingMessage = message;
    return operationRead;
  }

  function finishOperation(read?: AbortController) {
    if (read && read !== operationRead) return;
    operationRead?.abort();
    operationRead = null;
    processingId = null;
    if (streamEventSource) {
      streamEventSource.close();
      streamEventSource = null;
    }
    agentProcessingId = null;
    agentOperation = null;
    currentLoadingMessage = '';
    // Reset streaming state
    streamingPhase = '';
    streamingOutput = '';
    streamingSteps = 0;
  }

  // Thresholds for inferring desire nature from metrics
  const RECURRING_CYCLE_THRESHOLD = 2;
  const RECURRING_COMPLETION_THRESHOLD = 2;

  /**
   * Infer the behavioral nature of a desire from its metrics
   */
  function inferDesireNature(metrics?: DesireMetrics): 'recurring' | 'achievable' | 'aspirational' {
    if (!metrics) return 'achievable'; // Default for new desires

    // High cycles and completions = recurring (keeps coming back)
    if (metrics.cycleCount > RECURRING_CYCLE_THRESHOLD ||
        metrics.completionCount > RECURRING_COMPLETION_THRESHOLD) {
      return 'recurring';
    }

    // Many attempts, never satisfied = aspirational
    if (metrics.executionAttemptCount > 3 && metrics.completionCount === 0) {
      return 'aspirational';
    }

    // First completion with low retry count = achievable
    return 'achievable';
  }

  function getNatureIcon(metrics?: DesireMetrics): string {
    const nature = inferDesireNature(metrics);
    switch (nature) {
      case 'recurring': return '🔄';
      case 'achievable': return '🎯';
      case 'aspirational': return '⭐';
    }
  }

  function getNatureLabel(metrics?: DesireMetrics): string {
    if (!metrics) return 'Unobserved';
    const nature = inferDesireNature(metrics);
    switch (nature) {
      case 'recurring': return 'Recurring';
      case 'achievable': return 'Achievable';
      case 'aspirational': return 'Aspirational';
    }
  }

  function getNatureTooltip(metrics?: DesireMetrics): string {
    if (!metrics) return 'New desire - nature will emerge from behavior';

    const nature = inferDesireNature(metrics);
    const parts = [`${nature} (inferred from behavior)`];

    if (metrics.cycleCount > 0) {
      parts.push(`${metrics.cycleCount} cycles`);
    }
    if (metrics.completionCount > 0) {
      parts.push(`${metrics.completionCount} completions`);
    }
    if (metrics.executionAttemptCount > 0) {
      parts.push(`${metrics.executionAttemptCount} attempts`);
    }

    return parts.join(' • ');
  }

  // Visual styling based on nature
  function getNatureColor(metrics?: DesireMetrics): string {
    const nature = inferDesireNature(metrics);
    switch (nature) {
      case 'recurring': return '#3b82f6'; // Blue - cycles back
      case 'achievable': return '#22c55e'; // Green - can be completed
      case 'aspirational': return '#a855f7'; // Purple - long-term dream
    }
  }

  function getNatureExplanation(metrics?: DesireMetrics): string {
    if (!metrics) return 'New desire - nature will emerge as you interact with it';

    const nature = inferDesireNature(metrics);
    switch (nature) {
      case 'recurring':
        return `This desire keeps coming back (${metrics.cycleCount} cycles, ${metrics.completionCount} completions)`;
      case 'achievable':
        return metrics.completionCount > 0
          ? `This desire was achieved! (${metrics.completionCount} completion${metrics.completionCount > 1 ? 's' : ''})`
          : 'This desire can be completed - working toward it';
      case 'aspirational':
        return `A long-term aspiration (${metrics.executionAttemptCount} attempts, still pursuing)`;
    }
  }

  function getScratchpadEntryIcon(type: string): string {
    switch (type) {
      case 'origin': return '🌱';
      case 'reinforcement': return '💪';
      case 'decay': return '📉';
      case 'threshold_crossed': return '🚀';
      case 'status_change': return '🔄';
      case 'plan_generated': return '📋';
      case 'plan_revised': return '✏️';
      case 'user_critique': return '💬';
      case 'review_started': return '🔍';
      case 'review_completed': return '✅';
      case 'approval_requested': return '🙋';
      case 'approved': return '👍';
      case 'rejected': return '👎';
      case 'execution_started': return '▶️';
      case 'execution_step': return '⚡';
      case 'execution_completed': return '🎉';
      case 'execution_failed': return '❌';
      case 'outcome_review': return '📊';
      case 'retry_scheduled': return '🔁';
      case 'completed': return '✨';
      case 'recurring_reset': return '🔄';
      case 'strength_adjusted': return '📈';
      case 'user_input': return '👤';
      case 'note': return '📝';
      default: return '•';
    }
  }

  function formatTimestamp(ts: string | null): string {
    if (!ts) return 'Never';
    const date = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  }

  function getRiskColor(risk: string): string {
    switch (risk) {
      case 'none': return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200';
      case 'low': return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'medium': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
      case 'high': return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
      case 'critical': return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
      default: return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200';
    }
  }

  function getStatusColor(status: string): string {
    switch (status) {
      case 'nascent': return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
      case 'pending': return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'evaluating':
      case 'planning':
      case 'reviewing': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
      case 'awaiting_approval': return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
      case 'approved': return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'executing': return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200';
      case 'awaiting_review': return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200';
      case 'needs_attention': return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
      case 'paused': return 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200';
      case 'completed': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200';
      case 'rejected':
      case 'failed': return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
      case 'abandoned':
      case 'archived': return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200';
      default: return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200';
    }
  }

  function getSourceIcon(source: string): string {
    switch (source) {
      case 'user_request': return '💬';
      case 'persona_goal': return '🎯';
      case 'urgent_task': return '🔥';
      case 'task': return '📋';
      case 'memory_pattern': return '🧠';
      case 'curiosity': return '❓';
      case 'reflection': return '💭';
      case 'dream': return '🌙';
      case 'tool_suggestion': return '🔧';
      default: return '✨';
    }
  }

  // Goal type helpers for long-running goals
  function getGoalTypeIcon(goalType: DesireGoalType | undefined): string {
    switch (goalType) {
      case 'long_running': return '🏔️';
      case 'recurring': return '🔄';
      case 'one_time': return '✓';
      default: return '';
    }
  }

  function getGoalTypeLabel(goalType: DesireGoalType | undefined): string {
    switch (goalType) {
      case 'long_running': return 'Long-term';
      case 'recurring': return 'Recurring';
      case 'one_time': return 'One-time';
      default: return '';
    }
  }

  function getGoalTypeColor(goalType: DesireGoalType | undefined): string {
    switch (goalType) {
      case 'long_running': return 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200';
      case 'recurring': return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200';
      case 'one_time': return 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300';
      default: return '';
    }
  }

  function getMilestoneStatusIcon(status: string): string {
    switch (status) {
      case 'completed': return '✅';
      case 'in_progress': return '🔄';
      case 'skipped': return '⏭️';
      case 'pending': return '⬜';
      default: return '⬜';
    }
  }

  function updateSourceConfig(source: string, field: 'enabled' | 'weight', value: boolean | number) {
    if (!agencyConfig) return;
    const sourceKey = source as keyof AgencyConfig['sources'];
    agencyConfig = {
      ...agencyConfig,
      sources: {
        ...agencyConfig.sources,
        [sourceKey]: { ...agencyConfig.sources[sourceKey], [field]: value },
      },
    };
  }

  function updateRiskPolicyList(field: RiskPolicyList, risk: string, checked: boolean) {
    if (!agencyConfig) return;
    const current = agencyConfig.riskPolicy[field];
    const next = checked
      ? [...new Set([...current, risk])]
      : current.filter(value => value !== risk);
    agencyConfig = {
      ...agencyConfig,
      riskPolicy: { ...agencyConfig.riskPolicy, [field]: next },
    };
  }

  async function saveAgencySettings() {
    if (!agencyConfig) return;
    const submitted = JSON.stringify(agencyConfig);
    savingAgencyConfig = true;
    try {
      const res = await apiFetch('/api/agency/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: submitted,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save Agency settings');
      activationThreshold = data.config?.thresholds?.activation ?? null;
      if (JSON.stringify(agencyConfig) === submitted) {
        agencyConfigDirty = false;
        agencyConfig = data.config;
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      savingAgencyConfig = false;
    }
  }

  /**
   * Load scratchpad entries for a desire
   */
  async function loadScratchpadEntries(desireId: string, offset = 0) {
    scratchpadRead?.abort();
    const read = new AbortController();
    scratchpadRead = read;
    scratchpadLoading = true;
    scratchpadError = '';
    expandedEntryIndex = null;
    try {
      const params = new URLSearchParams({ desireId, offset: String(offset), limit: String(scratchpadLimit) });
      const res = await apiFetch(`/api/agency/scratchpad?${params}`, { signal: read.signal });
      const data = await res.json();
      if (read.signal.aborted) return;
      if (!res.ok) throw new Error(data.error || 'Failed to load scratchpad');
      scratchpadEntries = data.entries || [];
      scratchpadFiles = data.files || [];
      scratchpadTotal = data.total || 0;
      scratchpadOffset = offset;
    } catch (e) {
      if (!read.signal.aborted) scratchpadError = (e as Error).message;
    } finally {
      if (scratchpadRead === read) { scratchpadRead = null; scratchpadLoading = false; }
    }
  }

  /**
   * Load a specific scratchpad file by name
   */
  async function loadScratchpadFile(desireId: string, filename: string) {
    fileRead?.abort();
    const read = new AbortController();
    fileRead = read;
    selectedFileName = filename;
    selectedFileContent = null;
    fileViewLoading = true;
    fileError = '';
    try {
      const params = new URLSearchParams({ desireId, filename });
      const res = await apiFetch(`/api/agency/scratchpad?${params}`, { signal: read.signal });
      const data = await res.json();
      if (read.signal.aborted) return;
      if (!res.ok) throw new Error(data.error || 'Failed to load file');
      selectedFileContent = data.entry;
    } catch (e) {
      if (!read.signal.aborted) fileError = (e as Error).message;
    } finally {
      if (fileRead === read) { fileRead = null; fileViewLoading = false; }
    }
  }

  function toggleScratchpadFile(desireId: string, filename: string) {
    if (selectedFileName !== filename) { void loadScratchpadFile(desireId, filename); return; }
    fileRead?.abort();
    fileRead = null;
    fileViewLoading = false;
    selectedFileName = null;
    selectedFileContent = null;
    fileError = '';
  }

  /**
   * Load plan versions for a desire
   */
  async function loadPlanVersions(desireId: string) {
    planListRead?.abort();
    const read = new AbortController();
    planListRead = read;
    planListError = '';
    try {
      const res = await apiFetch(`/api/agency/plans?desireId=${encodeURIComponent(desireId)}`, { signal: read.signal });
      const data = await res.json();
      if (read.signal.aborted) return;
      if (!res.ok) throw new Error(data.error || 'Failed to load plans');
      planVersions = data.versions || [];
    } catch (e) {
      if (!read.signal.aborted) planListError = (e as Error).message;
    } finally {
      if (planListRead === read) planListRead = null;
    }
  }

  /**
   * Load a specific plan version
   */
  async function loadPlanVersion(desireId: string, version: number) {
    planRead?.abort();
    const read = new AbortController();
    planRead = read;
    selectedPlanVersion = version;
    viewingPlan = null;
    planError = '';
    try {
      const res = await apiFetch(`/api/agency/plans?desireId=${encodeURIComponent(desireId)}&version=${version}`, { signal: read.signal });
      const data = await res.json();
      if (read.signal.aborted) return;
      if (!res.ok) throw new Error(data.error || 'Failed to load plan version');
      viewingPlan = data.plan;
    } catch (e) {
      if (!read.signal.aborted) planError = (e as Error).message;
    } finally {
      if (planRead === read) planRead = null;
    }
  }

  function showCurrentPlan(plan: DesirePlan | undefined) {
    planRead?.abort();
    planRead = null;
    viewingPlan = plan || null;
    selectedPlanVersion = null;
    planError = '';
  }

  /**
   * Load execution attempts for a desire
   */
  async function loadExecutionData(desireId: string) {
    executionRead?.abort();
    const read = new AbortController();
    executionRead = read;
    executionLoading = { [desireId]: true };
    executionErrors = { ...executionErrors, [desireId]: '' };
    try {
      const res = await apiFetch(`/api/agency/desires/${desireId}/executions`, { signal: read.signal });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load executions');
      if (!read.signal.aborted) executionData = { ...executionData, [desireId]: data.executions };
    } catch (e) {
      if (!read.signal.aborted) executionErrors = { ...executionErrors, [desireId]: (e as Error).message };
    } finally {
      if (executionRead === read) {
        executionRead = null;
        executionLoading = {};
      }
    }
  }

  /**
   * Toggle scratchpad viewer and load entries
   */
  function closeScratchpadView() {
    scratchpadRead?.abort(); fileRead?.abort(); planListRead?.abort(); planRead?.abort();
    scratchpadRead = fileRead = planListRead = planRead = null;
    scratchpadLoading = fileViewLoading = false;
    scratchpadError = fileError = planListError = planError = '';
    showScratchpadFor = null;
    scratchpadEntries = [];
    scratchpadFiles = [];
    scratchpadTotal = scratchpadOffset = 0;
    selectedFileName = null;
    selectedFileContent = null;
    planVersions = [];
    selectedPlanVersion = null;
    viewingPlan = null;
    expandedEntryIndex = null;
  }

  async function toggleScratchpadWithLoad(desireId: string) {
    const opening = showScratchpadFor !== desireId;
    closeScratchpadView();
    if (opening) {
      showScratchpadFor = desireId;
      await Promise.all([loadScratchpadEntries(desireId), loadPlanVersions(desireId)]);
    }
  }

  async function loadAll(showLoading = true) {
    if (streamObservation.signal.aborted) return;
    listRead?.abort();
    const read = new AbortController();
    listRead = read;
    if (showLoading) loading = true;
    try {
      const params = new URLSearchParams({ status: statusFilter });
      const [list, stats, settings] = await Promise.all([
        `/api/agency/desires?${params}`, '/api/agency/metrics', '/api/agency/config',
      ].map(async url => {
        const response = await apiFetch(url, { signal: read.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Failed to load ${url}`);
        return data;
      }));
      if (read.signal.aborted) return;
      desires = list.desires;
      metrics = stats.metrics;
      summary = stats.summary;
      activationThreshold = settings.config?.thresholds?.activation ?? null;
      if (!agencyConfigDirty) agencyConfig = settings.config;
      dataError = '';
      executionData = {};
      if (expandedCardId) void loadExecutionData(expandedCardId);
      if (showScratchpadFor) {
        void loadScratchpadEntries(showScratchpadFor, scratchpadOffset);
        void loadPlanVersions(showScratchpadFor);
      }
    } catch (caught) {
      if (!read.signal.aborted) dataError = (caught as Error).message;
    } finally {
      if (listRead === read) { listRead = null; loading = false; }
    }
  }

  async function handleApprove(id: string) {
    if (!confirm('Approve this desire for execution?')) return;
    processingId = id;
    try {
      const res = await apiFetch(`/api/agency/desires/${id}/approve`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to approve desire');
      }
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      processingId = null;
    }
  }

  async function handleReject(id: string) {
    const reason = prompt('Reason for rejection (optional):');
    if (reason === null) return; // Cancelled

    processingId = id;
    try {
      const res = await apiFetch(`/api/agency/desires/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || 'User rejected' }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to reject desire');
      }
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      processingId = null;
    }
  }

  /**
   * Request a check-in for a long-running desire.
   * Queues durable desire_checkin work through the Work Coordinator.
   */
  async function requestCheckin(id: string) {
    processingId = id;
    try {
      const res = await apiFetch(`/api/agency/desires/${id}/checkin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to request check-in');
      }
      const data = await res.json();
      // Show success feedback
      alert(`✅ Check-in requested!\n\n${data.message || 'The system will evaluate progress on this goal shortly.'}`);
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
      alert(`❌ Failed to request check-in: ${error}`);
    } finally {
      processingId = null;
    }
  }

  async function handleReset(id: string) {
    if (!confirm('Reset this desire back to planning?\n\nThis clears clarifying questions and queues a fresh planning pass. Active executions must be cancelled from the queue first.')) return;

    processingId = id;
    try {
      const res = await apiFetch(`/api/agency/desires/${id}/reset?target=planning`, {
        method: 'POST',
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to reset desire');
      }

      console.log(`[AgencyDashboard] 🔄 ${data.message}`);
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      processingId = null;
    }
  }

  async function handleArchive(id: string) {
    if (!confirm('Archive this desire? It will become dormant but can be revived later.')) return;
    processingId = id;
    try {
      const res = await apiFetch(`/api/agency/desires/${id}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStatus: 'archived', reason: 'Archived by owner' }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to archive desire');
      }
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      processingId = null;
    }
  }

  async function handlePause(id: string) {
    processingId = id;
    try {
      const res = await apiFetch(`/api/agency/desires/${id}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStatus: 'paused', reason: 'Paused by owner' }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to pause desire');
      }
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      processingId = null;
    }
  }

  function setQuestionAnswer(desireId: string, questionId: string, answer: string) {
    questionAnswers = {
      ...questionAnswers,
      [desireId]: { ...(questionAnswers[desireId] || {}), [questionId]: answer },
    };
  }

  async function handleAnswerQuestions(desire: Desire) {
    const questions = desire.clarifyingQuestions?.questions || [];
    const values = questionAnswers[desire.id] || {};
    const missing = questions.filter(question => question.required && !values[question.id]?.trim());
    if (missing.length > 0) {
      error = `Please answer ${missing.length} required question${missing.length === 1 ? '' : 's'}.`;
      return;
    }
    processingId = desire.id;
    try {
      const res = await apiFetch(`/api/agency/desires/${desire.id}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers: questions
            .map(question => ({ questionId: question.id, answer: values[question.id]?.trim() || '' }))
            .filter(answer => answer.answer),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit clarifying answers');
      if (questionAnswers[desire.id] === values) {
        delete questionAnswers[desire.id];
        questionAnswers = { ...questionAnswers };
      }
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      processingId = null;
    }
  }

  async function handleRevive(id: string) {
    processingId = id;
    try {
      const res = await apiFetch(`/api/agency/desires/${id}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStatus: 'pending' }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to revive desire');
      }
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      processingId = null;
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this desire permanently?')) return;
    processingId = id;
    try {
      const res = await apiFetch(`/api/agency/desires/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to delete desire');
      }
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      processingId = null;
    }
  }

  async function handleAdvanceStage(id: string, newStatus: string) {
    processingId = id;
    try {
      const res = await apiFetch(`/api/agency/desires/${id}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newStatus }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to advance desire');
      }
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      processingId = null;
    }
  }

  /** Generate a plan through the coordinator-owned Desire Planner agent. */
  async function handleGeneratePlan(id: string) {
    const read = beginOperation(id, 'planning', 'Requesting a plan…');
    let outcome: 'pending' | 'complete' | 'failed' = 'pending';

    try {
      // Read coordinator progress from the transport-only SSE route.
      const response = await apiFetch(`/api/agency/desires/${id}/generate-plan-stream`, {
        method: 'POST',
        signal: read.signal,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to start plan generation stream');
      }

      for await (const frame of readServerEvents(response, read.signal)) {
        handleStreamEvent(frame.event, JSON.parse(frame.data));
        if (frame.event === 'complete') outcome = 'complete';
        else if (frame.event === 'error') outcome = 'failed';
      }

      if (read.signal.aborted) return;
      if (outcome === 'pending') throw new Error('Planning observation ended without a completed outcome. The result is unconfirmed.');
      if (outcome === 'failed') return;
      if (expandedCardId === id) expandedCardId = null;
      if (!read.signal.aborted) await loadAll();
    } catch (e) {
      if (!read.signal.aborted) error = (e as Error).message;
    } finally {
      finishOperation(read);
    }
  }

  /**
   * Handle streaming SSE events from plan generation
   */
  function handleStreamEvent(eventType: string, data: any) {
    switch (eventType) {
      case 'phase':
        streamingPhase = data.message || data.phase;
        break;
      case 'started':
        streamingPhase = 'Initializing...';
        break;
      case 'desire_loaded':
        streamingPhase = `Loaded: "${data.title}"`;
        break;
      case 'queued':
        streamingPhase = data.message || 'Planning queued...';
        break;
      case 'complete':
        streamingPhase = 'Complete!';
        if (data.plan) {
          streamingSteps = data.plan.steps?.length || 0;
        }
        break;
      case 'error':
        streamingPhase = 'Error';
        error = data.error || 'Unknown error';
        break;
    }
  }

  /**
   * Execute a desire's plan inline with SSE streaming for real-time progress
   * Shows step-by-step execution progress in the UI
   */
  async function handleExecute(id: string) {
    if (!confirm('Execute this desire now? This will run the plan through Big Brother.')) return;

    const read = beginOperation(id, 'executing', 'Requesting execution…');
    let outcome: 'pending' | 'complete' | 'failed' = 'pending';

    try {
      // Use streaming endpoint with POST for real-time progress
      // (EventSource is GET-only, so we use fetch with manual SSE parsing)
      const res = await apiFetch(`/api/agency/desires/${id}/run-stream`, {
        method: 'POST',
        signal: read.signal,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to start execution');
      }

      for await (const frame of readServerEvents(res, read.signal)) {
        handleExecutionEvent(frame.event, JSON.parse(frame.data));
        if (frame.event === 'complete') outcome = 'complete';
        else if (frame.event === 'error') outcome = 'failed';
      }

      if (read.signal.aborted) return;
      if (outcome === 'pending') throw new Error('Execution observation ended without a completed outcome. The result is unconfirmed.');
      if (outcome === 'complete') await loadAll();
    } catch (e) {
      if (!read.signal.aborted) error = (e as Error).message;
      if (!read.signal.aborted) streamingPhase = `Error: ${error}`;
    } finally {
      finishOperation(read);
    }
  }

  /**
   * Handle SSE events from execution stream
   */
  function handleExecutionEvent(eventType: string, data: any) {
    console.log(`[AgencyDashboard] Execution event: ${eventType}`, data);

    switch (eventType) {
      case 'phase':
        streamingPhase = data.message || data.phase;
        currentLoadingMessage = data.message || data.phase;
        break;

      case 'desire_loaded':
        streamingPhase = `Loaded: "${data.title}" (${data.totalSteps} steps)`;
        streamingSteps = data.totalSteps;
        break;

      case 'progress':
        // Handle step-by-step progress
        if (data.type === 'step_start') {
          streamingPhase = `Step ${data.stepNumber}/${data.totalSteps}: ${data.action}`;
          currentLoadingMessage = data.message;
        } else if (data.type === 'step_complete') {
          streamingOutput += (streamingOutput ? '\n' : '') + data.message;
          streamingPhase = `Step ${data.stepNumber}/${data.totalSteps} completed`;
        } else if (data.type === 'step_error') {
          streamingOutput += (streamingOutput ? '\n' : '') + data.message;
          streamingPhase = `Step ${data.stepNumber} failed`;
        } else if (data.type === 'claude_working') {
          streamingPhase = data.message;
          currentLoadingMessage = data.message;
        } else if (data.type === 'execution_start') {
          streamingPhase = data.message;
        } else if (data.type === 'execution_complete' || data.type === 'execution_error') {
          streamingOutput += (streamingOutput ? '\n' : '') + data.message;
        }
        break;

      case 'complete':
        streamingPhase = data.success ? '✅ Execution Complete!' : '⚠️ Execution Had Issues';
        if (data.message) {
          streamingOutput += (streamingOutput ? '\n' : '') + data.message;
        }
        break;

      case 'error':
        streamingPhase = 'Error';
        error = data.error;
        streamingOutput += (streamingOutput ? '\n' : '') + `❌ ${data.error}`;
        break;
    }
  }

  async function handleOutcomeReview(id: string) {
    const read = beginOperation(id, 'reviewing', 'Requesting outcome review…');

    try {
      // Use streaming endpoint to show progress
      const eventSource = apiEventSource(`/api/agency/desires/${id}/outcome-review-stream`);
      streamEventSource = eventSource;

      eventSource.onmessage = async (event) => {
        if (read.signal.aborted) return;
        try {
          const data = JSON.parse(event.data);

          switch (data.type) {
            case 'phase':
              streamingPhase = data.phase;
              currentLoadingMessage = data.phase;
              break;

            case 'log':
              // Append log messages to streaming output
              streamingOutput += (streamingOutput ? '\n' : '') + data.message;
              break;

            case 'result':
              // Process completed successfully
              console.log(`[AgencyDashboard] ✅ Outcome review complete: ${data.data?.outcomeReview?.verdict}`);
              break;

            case 'error':
              error = data.message || 'Unknown error';
              console.log(`[AgencyDashboard] ❌ Outcome review error: ${error}`);
              break;

            case 'done':
              // Close stream and overlay when done
              finishOperation(read);
              // Refresh list after completion
              await loadAll();
              break;
          }
        } catch (e) {
          error = (e as Error).message;
          finishOperation(read);
        }
      };

      eventSource.onerror = (err) => {
        if (read.signal.aborted) return;
        console.error('[AgencyDashboard] SSE error:', err);
        finishOperation(read);
        error = 'Connection lost during outcome review';
      };

    } catch (e) {
      if (!read.signal.aborted) error = (e as Error).message;
      finishOperation(read);
    }
  }

  async function handleRevise(id: string) {
    const critique = critiqueText[id];
    if (!critique || critique.trim().length === 0) {
      error = 'Please enter your critique/feedback before requesting revision';
      return;
    }

    revisingId = id;
    try {
      const res = await apiFetch(`/api/agency/desires/${id}/revise`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ critique: critique.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to request revision');
      }
      // Clear the critique text after successful submission
      if (critiqueText[id] === critique) {
        critiqueText[id] = '';
        if (expandedCardId === id) expandedCardId = null;
      }
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      revisingId = null;
    }
  }

  // Toggle card expansion (collapsed/expanded view)
  function toggleCardExpand(id: string) {
    closeScratchpadView();
    expandedCardId = expandedCardId === id ? null : id;
    // Reset sub-expansions when collapsing
    if (expandedCardId !== id) {
      expandedPlanId = null;
      showHistoryFor = null;
      showScratchpadFor = null;
    } else {
      void loadExecutionData(id);
      const desire = desires.find(item => item.id === id);
      if (desire?.clarifyingQuestions) {
        questionAnswers = {
          ...questionAnswers,
          [id]: questionAnswers[id] || Object.fromEntries(desire.clarifyingQuestions.questions.map(question => [
            question.id,
            desire.clarifyingQuestions?.answers.find(answer => answer.questionId === question.id)?.answer || '',
          ])),
        };
      }
    }
  }

  function togglePlanDetail(id: string) {
    expandedPlanId = expandedPlanId === id ? null : id;
  }

  function togglePlanHistory(id: string) {
    showHistoryFor = showHistoryFor === id ? null : id;
  }

  async function handleCreateDesire() {
    if (!newDesire.title.trim() || !newDesire.description.trim()) {
      error = 'Title and description are required';
      return;
    }

    const submitted = JSON.stringify(newDesire);
    try {
      // Convert tags string to array
      const tagsArray = newDesire.tags
        .split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);

      const res = await apiFetch('/api/agency/desires', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newDesire,
          tags: tagsArray,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create desire');
      }
      if (JSON.stringify(newDesire) === submitted) {
        newDesire = {
          title: '',
          description: '',
          reason: '',
          risk: 'low',
          goalType: 'one_time',
          strength: 0.8,
          status: 'pending',
          decayRate: 0.03,
          tags: '',
        };
        showNewDesire = false;
        showAdvancedOptions = false;
      }
      await loadAll();
    } catch (e) {
      error = (e as Error).message;
    }
  }

  onMount(() => {
    if (!$isOwner) { loading = false; return; }
    void loadAll();
    let revision = $coordinatorSnapshot?.agencyChange?.revision;
    let reconnecting = false;
    const unsubscribe = coordinatorSnapshot.subscribe(snapshot => {
      const change = snapshot?.agencyChange;
      if (change && change.revision !== revision) {
        revision = change.revision;
        void loadAll(false);
      }
    });
    const unsubscribeConnection = coordinatorConnection.subscribe(state => {
      if (state === 'reconnecting') reconnecting = true;
      else if (state === 'live' && reconnecting) { reconnecting = false; void loadAll(false); }
    });
    const release = useWorkCoordinator();
    return () => { unsubscribe(); unsubscribeConnection(); release(); };
  });

  onDestroy(() => {
    listRead?.abort();
    executionRead?.abort();
    streamObservation.abort();
    closeScratchpadView();
    finishOperation();
  });
</script>

<div class="p-4">
  {#if !$isOwner}
    <div class="panel p-6 text-center space-y-2">
      <h2 class="text-lg font-semibold">Agency Access Restricted</h2>
      <p class="muted text-sm">Log in as the owner to manage autonomous desires.</p>
    </div>
  {:else if loading}
    <div class="text-center py-8">
      <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      <p class="mt-2 muted">Loading agency data...</p>
    </div>
  {:else}
    <!-- Summary Stats -->
    {#if summary}
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div class="panel p-4 text-center">
          <div class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Total Desires</div>
          <div class="text-2xl font-bold mt-1">{summary.total}</div>
        </div>
        <div class="panel p-4 text-center">
          <div class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Active</div>
          <div class="text-2xl font-bold mt-1 text-blue-600 dark:text-blue-400">{summary.active}</div>
        </div>
        <div class="panel p-4 text-center">
          <div class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Waiting</div>
          <div class="text-2xl font-bold mt-1 text-yellow-600 dark:text-yellow-400">{summary.waiting}</div>
        </div>
        <div class="panel p-4 text-center">
          <div class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Needs Action</div>
          <div class="text-2xl font-bold mt-1 text-orange-600 dark:text-orange-400">{summary.needsAction}</div>
        </div>
        <div class="panel p-4 text-center">
          <div class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Completed</div>
          <div class="text-2xl font-bold mt-1 text-green-600 dark:text-green-400">{summary.completed}</div>
        </div>
        <div class="panel p-4 text-center">
          <div class="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">Archived/Failed</div>
          <div class="text-2xl font-bold mt-1 text-red-600 dark:text-red-400">{summary.failed}</div>
        </div>
      </div>
    {/if}

    <!-- Metrics -->
    {#if metrics}
      <div class="panel p-4 mt-4">
        <h3 class="text-sm font-semibold mb-3">Performance Metrics</h3>
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <span class="muted">Generated:</span>
            <span class="font-semibold ml-1">{metrics.totalGenerated}</span>
          </div>
          <div>
            <span class="muted">Completed:</span>
            <span class="font-semibold ml-1">{metrics.totalCompleted}</span>
          </div>
          <div>
            <span class="muted">Today:</span>
            <span class="font-semibold ml-1">{metrics.completedToday}</span>
          </div>
          <div>
            <span class="muted">Success Rate:</span>
            <span class="font-semibold ml-1">{(metrics.successRate * 100).toFixed(1)}%</span>
          </div>
        </div>
      </div>
    {/if}

    {#if agencyConfig}
      <details class="panel p-4 mt-4" on:input={() => agencyConfigDirty = true} on:change={() => agencyConfigDirty = true}>
        <summary class="cursor-pointer font-semibold">Agency lifecycle settings</summary>
        <p class="text-xs muted mt-2">These profile settings control desire admission, strength, approval, and execution. YOLO bypasses approval gates only after the plan has passed alignment and safety review.</p>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4 text-sm">
          <label class="flex items-center gap-2">
            <input type="checkbox" bind:checked={agencyConfig.enabled} />
            Agency enabled
          </label>
          <label class="flex flex-col gap-1">
            <span>Operating mode</span>
            <select class="select-field" bind:value={agencyConfig.mode}>
              <option value="off">Off</option>
              <option value="supervised">Supervised (owner approval)</option>
              <option value="autonomous">Autonomous within trust policy</option>
              <option value="yolo">YOLO approval bypass</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span>Review bypass</span>
            <select class="select-field" bind:value={agencyConfig.riskPolicy.reviewBypass}>
              <option value="never">Never</option>
              <option value="trust_based">Trust based</option>
              <option value="always">Always</option>
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span>Minimum trust for auto-approval</span>
            <select class="select-field" bind:value={agencyConfig.riskPolicy.autoApproveTrustLevel}>
              <option value="observe">Observe</option>
              <option value="suggest">Suggest</option>
              <option value="supervised_auto">Supervised auto</option>
              <option value="bounded_auto">Bounded auto</option>
              <option value="adaptive_auto">Adaptive auto</option>
            </select>
          </label>
          <div class="md:col-span-2 lg:col-span-3 grid grid-cols-1 md:grid-cols-3 gap-3">
            {#each [
              { field: 'autoApproveRisk' as RiskPolicyList, label: 'Auto-approval risk levels' },
              { field: 'requireApprovalRisk' as RiskPolicyList, label: 'Owner-approval risk levels' },
              { field: 'blockRisk' as RiskPolicyList, label: 'Blocked risk levels' },
            ] as policy}
              <fieldset class="rounded border border-gray-200 dark:border-gray-700 p-3">
                <legend class="px-1 text-xs font-medium">{policy.label}</legend>
                <div class="flex flex-wrap gap-x-3 gap-y-2">
                  {#each riskLevels as risk}
                    <label class="flex items-center gap-1 text-xs capitalize">
                      <input
                        type="checkbox"
                        checked={agencyConfig.riskPolicy[policy.field].includes(risk)}
                        on:change={(event) => updateRiskPolicyList(policy.field, risk, event.currentTarget.checked)}
                      />
                      {risk}
                    </label>
                  {/each}
                </div>
              </fieldset>
            {/each}
          </div>
          <label class="flex flex-col gap-1">
            <span>Activation strength</span>
            <input class="input-field" type="number" min="0" max="1" step="0.01" bind:value={agencyConfig.thresholds.activation} />
          </label>
          <label class="flex flex-col gap-1">
            <span>Auto-approval strength</span>
            <input class="input-field" type="number" min="0" max="1" step="0.01" bind:value={agencyConfig.thresholds.autoApprove} />
          </label>
          <label class="flex items-center gap-2 self-end py-2">
            <input type="checkbox" bind:checked={agencyConfig.thresholds.decay.enabled} />
            Time-based decay enabled
          </label>
          <label class="flex flex-col gap-1">
            <span>Decay per elapsed day</span>
            <input class="input-field" type="number" min="0" max="1" step="0.001" bind:value={agencyConfig.thresholds.decay.ratePerDay} />
          </label>
          <label class="flex flex-col gap-1">
            <span>Minimum strength</span>
            <input class="input-field" type="number" min="0" max="1" step="0.01" bind:value={agencyConfig.thresholds.decay.minStrength} />
          </label>
          <label class="flex flex-col gap-1">
            <span>Reinforcement boost</span>
            <input class="input-field" type="number" min="0" max="1" step="0.01" bind:value={agencyConfig.thresholds.decay.reinforcementBoost} />
          </label>
          <label class="flex flex-col gap-1">
            <span>New desire strength</span>
            <input class="input-field" type="number" min="0" max="1" step="0.01" bind:value={agencyConfig.thresholds.decay.initialStrength} />
          </label>
          <label class="flex flex-col gap-1">
            <span>Maximum operational desires</span>
            <input class="input-field" type="number" min="1" step="1" bind:value={agencyConfig.limits.maxActiveDesires} />
          </label>
          <label class="flex flex-col gap-1">
            <span>Maximum nascent/pending desires</span>
            <input class="input-field" type="number" min="1" step="1" bind:value={agencyConfig.limits.maxPendingDesires} />
          </label>
          <label class="flex flex-col gap-1">
            <span>Maximum daily executions</span>
            <input class="input-field" type="number" min="0" step="1" bind:value={agencyConfig.limits.maxDailyExecutions} />
          </label>
          <label class="flex flex-col gap-1">
            <span>Maximum plan retries</span>
            <input class="input-field" type="number" min="0" step="1" bind:value={agencyConfig.execution.maxPlanRetries} />
          </label>
          <label class="flex items-center gap-2 self-end py-2">
            <input type="checkbox" bind:checked={agencyConfig.execution.feasibilityCheckEnabled} />
            Feasibility check enabled
          </label>
          <label class="flex flex-col gap-1">
            <span>Preferred execution backend</span>
            <input class="input-field" type="text" bind:value={agencyConfig.execution.preferredBackend} />
          </label>
          <label class="flex flex-col gap-1">
            <span>Fallback execution backend</span>
            <input class="input-field" type="text" bind:value={agencyConfig.execution.fallbackBackend} />
          </label>
          <label class="flex items-center gap-2">
            <input type="checkbox" bind:checked={agencyConfig.logging.logToInnerDialogue} />
            Log Agency reflections to inner dialogue
          </label>
        </div>
        <h4 class="text-sm font-semibold mt-5 mb-2">Input sources</h4>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
          {#each Object.entries(agencyConfig.sources) as [source, sourceConfig]}
            <div class="flex items-center gap-2 p-2 rounded border border-gray-200 dark:border-gray-700">
              <input
                type="checkbox"
                checked={sourceConfig.enabled}
                on:change={(event) => updateSourceConfig(source, 'enabled', event.currentTarget.checked)}
              />
              <span class="text-xs flex-1">{source.replaceAll('_', ' ')}</span>
              <input
                class="input-field !w-20"
                aria-label={`${source} source weight`}
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={sourceConfig.weight}
                on:change={(event) => updateSourceConfig(source, 'weight', event.currentTarget.valueAsNumber)}
              />
            </div>
          {/each}
        </div>
        <div class="flex justify-end mt-4">
          <button class="btn-primary btn-sm" disabled={savingAgencyConfig} on:click={saveAgencySettings}>
            {savingAgencyConfig ? 'Saving…' : 'Save Agency settings'}
          </button>
        </div>
      </details>
    {/if}

    <!-- Error Display -->
    {#if error || dataError || $coordinatorError}
      <div class="banner banner-error mt-4">
        {error || dataError || $coordinatorError}
        {#if error}<button class="ml-2 underline" on:click={() => error = ''}>Dismiss</button>{/if}
      </div>
    {/if}
    {#if $coordinatorConnection === 'reconnecting'}
      <p class="mt-4 muted">Reconnecting to Agency updates. Displayed data may be out of date.</p>
    {/if}

    <!-- Controls -->
    <div class="flex justify-between items-center flex-wrap gap-2 mt-4">
      <div class="flex items-center gap-2">
        <select bind:value={statusFilter} on:change={() => loadAll(false)} class="select-field">
          {#each statusFilters as filter}
            <option value={filter.value}>{filter.icon}{filter.icon ? ' ' : ''}{filter.label}</option>
          {/each}
        </select>
        <button class="btn-secondary btn-sm" on:click={() => loadAll()}>Refresh</button>
      </div>
      <button class="btn-primary btn-sm" on:click={() => showNewDesire = !showNewDesire}>
        {showNewDesire ? 'Cancel' : '+ New Desire'}
      </button>
    </div>

    <!-- New Desire Form -->
    {#if showNewDesire}
      <div class="panel p-4 mt-4 space-y-3">
        <h3 class="font-semibold">Create Manual Desire</h3>
        <input
          type="text"
          bind:value={newDesire.title}
          placeholder="Title (e.g., 'Learn a new skill')"
          class="input-field"
        />
        <textarea
          bind:value={newDesire.description}
          placeholder="Description (what do you want to achieve?)"
          class="input-field"
          rows="2"
        ></textarea>
        <textarea
          bind:value={newDesire.reason}
          placeholder="Reason (why is this important?)"
          class="input-field"
          rows="2"
        ></textarea>
        <div class="flex items-center gap-4 flex-wrap">
          <label class="text-sm">
            Risk:
            <select bind:value={newDesire.risk} class="select-field ml-1">
              <option value="none">None</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </label>
          <label class="text-sm">
            Type:
            <select bind:value={newDesire.goalType} class="select-field ml-1">
              <option value="one_time">One-time</option>
              <option value="recurring">Recurring</option>
              <option value="long_running">Long-running</option>
            </select>
          </label>
          <button
            type="button"
            class="text-sm text-blue-500 hover:text-blue-600 dark:text-blue-400"
            on:click={() => showAdvancedOptions = !showAdvancedOptions}
          >
            {showAdvancedOptions ? '▼ Hide' : '▶ Advanced'}
          </button>
        </div>

        <!-- Advanced Options (collapsible) -->
        {#if showAdvancedOptions}
          <div class="border-t border-gray-200 dark:border-gray-700 pt-3 mt-2 space-y-3">
            <div class="grid grid-cols-2 gap-4">
              <label class="text-sm flex flex-col gap-1">
                <span class="text-gray-600 dark:text-gray-400">Initial Strength: {newDesire.strength.toFixed(2)}</span>
                <input
                  type="range"
                  bind:value={newDesire.strength}
                  min="0.1"
                  max="1.0"
                  step="0.05"
                  class="w-full accent-blue-500"
                />
                <span class="text-xs text-gray-500">
                  {activationThreshold === null ? 'Saved activation threshold unavailable' : newDesire.strength >= activationThreshold ? `✓ Above saved activation threshold (${activationThreshold.toFixed(2)})` : `○ Below saved activation threshold (${activationThreshold.toFixed(2)}) - needs reinforcement`}
                </span>
              </label>
              <label class="text-sm flex flex-col gap-1">
                <span class="text-gray-600 dark:text-gray-400">Decay Rate: {newDesire.decayRate.toFixed(3)}/day</span>
                <input
                  type="range"
                  bind:value={newDesire.decayRate}
                  min="0.005"
                  max="0.05"
                  step="0.005"
                  class="w-full accent-blue-500"
                />
                <span class="text-xs text-gray-500">
                  {newDesire.decayRate <= 0.01 ? 'Slow decay (persistent)' : newDesire.decayRate >= 0.04 ? 'Fast decay' : 'Normal decay'}
                </span>
              </label>
            </div>
            <div class="flex items-center gap-4">
              <label class="text-sm">
                Start Status:
                <select bind:value={newDesire.status} class="select-field ml-1">
                  <option value="pending">Pending (ready for planning)</option>
                  <option value="nascent">Nascent (needs reinforcement)</option>
                </select>
              </label>
            </div>
            <label class="text-sm flex flex-col gap-1">
              <span class="text-gray-600 dark:text-gray-400">Tags (comma-separated)</span>
              <input
                type="text"
                bind:value={newDesire.tags}
                placeholder="e.g., health, fitness, core-value"
                class="input-field"
              />
            </label>
          </div>
        {/if}

        <div class="flex justify-end gap-2 pt-2">
          <button class="btn-secondary btn-sm" on:click={() => { showNewDesire = false; showAdvancedOptions = false; }}>Cancel</button>
          <button class="btn-primary btn-sm" on:click={handleCreateDesire}>Create Desire</button>
        </div>
      </div>
    {/if}

    <!-- Consolidated Desire List - All desires in one place -->
    <div class="flex flex-col gap-3 mt-4">
      {#if desires.length === 0 && dataError}
        <p class="text-red-600" role="alert">The desire list is unavailable. Use Refresh to retry.</p>
      {:else if desires.length === 0}
        <div class="text-center py-8">
          <p class="muted">No desires match the “{statusFilterLabel}” filter.</p>
          {#if statusFilter !== 'all'}
            <p class="text-sm muted mt-1">Select All to view desires across every lifecycle stage.</p>
          {/if}
        </div>
      {:else}
        {#each sortedDesires as desire (desire.id)}
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div
            class="panel p-4 cursor-pointer transition-all hover:bg-gray-50 dark:hover:bg-gray-800/50"
            class:cursor-default={expandedCardId === desire.id}
            style="border-left: 4px solid {getNatureColor(desire.metrics)};"
            role="button"
            tabindex="0"
            aria-expanded={expandedCardId === desire.id}
            on:click={() => toggleCardExpand(desire.id)}
            on:keydown={(e) => e.key === 'Enter' && toggleCardExpand(desire.id)}
          >
            <!-- ========== COLLAPSED VIEW (always visible) ========== -->
            <div class="flex flex-col gap-1">
              <!-- Row 1: Title + badges -->
              <div class="flex items-center gap-2">
                <span class="text-xl">{getSourceIcon(desire.source)}</span>
                <h4 class="font-semibold text-sm flex-1 min-w-[120px] truncate">{desire.title}</h4>
                <span
                  class="inline-flex items-center justify-center w-5 h-5 rounded-full text-white text-xs flex-shrink-0"
                  style="background: {getNatureColor(desire.metrics)};"
                  title={getNatureTooltip(desire.metrics)}
                >
                  {getNatureIcon(desire.metrics)}
                </span>
                <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium {getStatusColor(desire.status)}">{desire.status}</span>
                <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium {getRiskColor(desire.risk)}">{desire.risk}</span>
                {#if desire.goalType && desire.goalType !== 'one_time'}
                  <span class="inline-block px-2 py-0.5 rounded-full text-xs font-medium {getGoalTypeColor(desire.goalType)}"
                    title={desire.goalType === 'long_running' ? `${desire.goalProgress?.progressPercent || 0}% complete` : 'Recurring goal'}>
                    {getGoalTypeIcon(desire.goalType)} {getGoalTypeLabel(desire.goalType)}
                  </span>
                {/if}
                <span class="text-xs text-gray-400 ml-auto flex-shrink-0">{expandedCardId === desire.id ? '▼' : '▶'}</span>
              </div>

              <!-- Row 2: Inline metrics -->
              <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 pl-7">
                <div class="flex items-center gap-1">
                  <div class="w-10 h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div
                      class="h-full rounded-full transition-all duration-300"
                      style="width: {(desire.strength || 0) * 100}%; background: {activationThreshold === null ? '#94a3b8' : (desire.strength || 0) >= activationThreshold ? '#22c55e' : '#f59e0b'};"
                    ></div>
                  </div>
                  <span class="font-semibold text-xs min-w-[35px]">
                    {#if desire.metrics?.netReinforcement !== undefined && desire.metrics.netReinforcement > 0}
                      <span class="text-green-500 font-bold">↑</span>
                    {:else if desire.metrics?.netReinforcement !== undefined && desire.metrics.netReinforcement < 0}
                      <span class="text-red-500 font-bold">↓</span>
                    {:else}
                      <span class="text-gray-500 font-bold">→</span>
                    {/if}
                    {((desire.strength || 0) * 100).toFixed(0)}%
                  </span>
                </div>
                <span class="text-gray-300 dark:text-gray-600">•</span>
                <span>{desire.metrics?.cycleCount ?? 0} cycles</span>
                <span class="text-gray-300 dark:text-gray-600">•</span>
                <span>{desire.metrics?.completionCount ?? 0} done</span>
                <span class="text-gray-300 dark:text-gray-600">•</span>
                <span>v{desire.plan?.version ?? 1}</span>
                {#if desire.scratchpad?.entryCount}
                  <span class="text-gray-300 dark:text-gray-600">•</span>
                  <span class="text-violet-500 dark:text-violet-400">{desire.scratchpad.entryCount} events</span>
                {/if}
              </div>

              <!-- Row 3: Milestone progress (for long-running goals only) -->
              {#if desire.goalType === 'long_running' && desire.milestones && desire.milestones.length > 0}
                <div class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 pl-7 mt-1">
                  <span class="text-violet-500 dark:text-violet-400 font-medium">
                    📍 {desire.milestones[desire.goalProgress?.currentMilestone || 0]?.title || 'Starting'}
                  </span>
                  <span class="text-gray-300 dark:text-gray-600">•</span>
                  <div class="flex items-center gap-1 flex-1 max-w-[200px]">
                    <div class="flex-1 h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        class="h-full bg-violet-500 rounded-full transition-all duration-500"
                        style="width: {desire.goalProgress?.progressPercent || 0}%;"
                      ></div>
                    </div>
                    <span class="font-semibold text-violet-500 min-w-[40px] text-right">
                      {desire.goalProgress?.progressPercent || 0}%
                    </span>
                  </div>
                  <span class="text-gray-400 dark:text-gray-500">
                    ({desire.goalProgress?.completedMilestones || 0}/{desire.goalProgress?.totalMilestones || 0} milestones)
                  </span>
                </div>
              {/if}
            </div>

            <!-- ========== EXPANDED VIEW (conditional) ========== -->
            {#if expandedCardId === desire.id}
              <!-- svelte-ignore a11y_click_events_have_key_events -->
              <div class="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 cursor-default" transition:slide={{ duration: 200 }} on:click|stopPropagation>
                <!-- Description -->
                <p class="text-sm text-gray-600 dark:text-gray-400 mb-2">{desire.description}</p>

                {#if desire.reason}
                  <p class="text-xs text-gray-500 dark:text-gray-500 mb-2 italic">"{desire.reason}"</p>
                {/if}

                {#if desire.status === 'questioning' && desire.clarifyingQuestions?.questions.length}
                  <div class="p-4 mb-3 rounded-lg border border-amber-400 bg-amber-50 dark:bg-amber-950/30" on:click|stopPropagation>
                    <h5 class="text-sm font-semibold text-amber-800 dark:text-amber-200">Questions needed before planning</h5>
                    <p class="text-xs text-amber-700 dark:text-amber-300 mt-1 mb-3">Your answers are saved with this desire and planning resumes automatically.</p>
                    <div class="flex flex-col gap-3">
                      {#each desire.clarifyingQuestions.questions as question}
                        <label class="text-sm flex flex-col gap-1">
                          <span class="font-medium">{question.text}{question.required ? ' *' : ''}</span>
                          {#if question.type === 'yes_no'}
                            <select
                              class="select-field"
                              value={questionAnswers[desire.id]?.[question.id] || ''}
                              on:change={(event) => setQuestionAnswer(desire.id, question.id, event.currentTarget.value)}
                            >
                              <option value="">Select an answer</option>
                              <option value="Yes">Yes</option>
                              <option value="No">No</option>
                            </select>
                          {:else if question.type === 'choice' && question.options?.length}
                            <select
                              class="select-field"
                              value={questionAnswers[desire.id]?.[question.id] || ''}
                              on:change={(event) => setQuestionAnswer(desire.id, question.id, event.currentTarget.value)}
                            >
                              <option value="">Select an answer</option>
                              {#each question.options as option}
                                <option value={option}>{option}</option>
                              {/each}
                            </select>
                          {:else}
                            <textarea
                              class="input-field resize-y"
                              rows="2"
                              value={questionAnswers[desire.id]?.[question.id] || ''}
                              on:input={(event) => setQuestionAnswer(desire.id, question.id, event.currentTarget.value)}
                            ></textarea>
                          {/if}
                        </label>
                      {/each}
                    </div>
                    <div class="flex justify-end mt-3">
                      <button
                        class="btn-primary btn-sm"
                        disabled={processingId === desire.id}
                        on:click={() => handleAnswerQuestions(desire)}
                      >
                        {processingId === desire.id ? 'Submitting…' : 'Submit answers and continue'}
                      </button>
                    </div>
                  </div>
                {/if}

                <!-- Nature explanation (compact) -->
                <div class="flex items-center gap-2 p-2 bg-gray-50 dark:bg-gray-800/50 rounded-md mb-3 flex-wrap">
                  <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-white text-xs font-semibold flex-shrink-0" style="background: {getNatureColor(desire.metrics)};">
                    {getNatureIcon(desire.metrics)} Inferred pattern: {getNatureLabel(desire.metrics)}
                  </span>
                  <span class="text-xs text-gray-600 dark:text-gray-400 flex-1">{getNatureExplanation(desire.metrics)}</span>
                </div>

                <!-- Collapsible Detailed Metrics -->
                <details class="mb-3">
                  <summary class="cursor-pointer p-2 bg-gray-100 dark:bg-gray-800 rounded-md text-sm font-medium flex justify-between list-none [&::-webkit-details-marker]:hidden">
                    <span>📊 Detailed Metrics</span>
                    <span class="text-xs text-gray-500 dark:text-gray-400">
                      {desire.metrics?.reinforcementCount ?? 0} reinforcements •
                      {desire.metrics?.executionAttemptCount ?? 0} attempts
                    </span>
                  </summary>
                  <div class="grid grid-cols-4 gap-2 p-2 bg-gray-50 dark:bg-gray-800/50 rounded-b-md">
                    <div class="flex flex-col items-center text-center p-1 text-xs">
                      <span class="text-xl mb-1">🔁</span>
                      <span class="text-lg font-bold">{desire.metrics?.cycleCount ?? 0}</span>
                      <span class="text-[0.6rem] uppercase text-gray-500 dark:text-gray-400">Cycles</span>
                    </div>
                    <div class="flex flex-col items-center text-center p-1 text-xs">
                      <span class="text-xl mb-1">✅</span>
                      <span class="text-lg font-bold">{desire.metrics?.completionCount ?? 0}</span>
                      <span class="text-[0.6rem] uppercase text-gray-500 dark:text-gray-400">Completions</span>
                    </div>
                    <div class="flex flex-col items-center text-center p-1 text-xs">
                      <span class="text-xl mb-1">⚡</span>
                      <span class="text-lg font-bold">{desire.metrics?.executionAttemptCount ?? 0}</span>
                      <span class="text-[0.6rem] uppercase text-gray-500 dark:text-gray-400">Attempts</span>
                    </div>
                    <div class="flex flex-col items-center text-center p-1 text-xs">
                      <span class="text-xl mb-1">📋</span>
                      <span class="text-lg font-bold">{desire.metrics?.planVersionCount ?? 0}</span>
                      <span class="text-[0.6rem] uppercase text-gray-500 dark:text-gray-400">Plan Versions</span>
                    </div>
                  </div>
                  {#if desire.metrics && (desire.metrics.userInputCount > 0 || desire.metrics.userApprovalCount > 0)}
                    <div class="flex gap-4 p-2 text-xs text-gray-500 dark:text-gray-400 border-t border-dashed border-gray-200 dark:border-gray-700 mt-2">
                      <span>👤 {desire.metrics.userInputCount} inputs</span>
                      <span>👍 {desire.metrics.userApprovalCount} approvals</span>
                      {#if desire.metrics.userRejectionCount > 0}
                        <span>👎 {desire.metrics.userRejectionCount} rejections</span>
                      {/if}
                    </div>
                  {/if}
                </details>

                <!-- Long-Running Goals: Milestones Section -->
                {#if desire.goalType === 'long_running' && desire.milestones && desire.milestones.length > 0}
                  <details class="mb-3" open>
                    <summary class="cursor-pointer p-2 bg-violet-50 dark:bg-violet-900/20 rounded-md text-sm font-medium flex justify-between list-none [&::-webkit-details-marker]:hidden border border-violet-200 dark:border-violet-800">
                      <span>🏔️ Milestones ({desire.goalProgress?.completedMilestones || 0}/{desire.goalProgress?.totalMilestones || 0})</span>
                      <span class="text-xs text-violet-600 dark:text-violet-400">
                        {desire.goalProgress?.progressPercent || 0}% complete
                      </span>
                    </summary>
                    <div class="p-3 bg-violet-50/50 dark:bg-violet-900/10 rounded-b-md border border-t-0 border-violet-200 dark:border-violet-800">
                      <!-- Completion Criteria -->
                      {#if desire.completionCriteria}
                        <div class="mb-3 p-2 bg-white dark:bg-gray-900 rounded border border-violet-200 dark:border-violet-800">
                          <p class="text-xs text-gray-500 dark:text-gray-400 uppercase font-semibold mb-1">🎯 Done when:</p>
                          <p class="text-sm text-gray-700 dark:text-gray-300">{desire.completionCriteria}</p>
                        </div>
                      {/if}

                      <!-- Milestone List -->
                      <div class="flex flex-col gap-2">
                        {#each desire.milestones as milestone, i}
                          <details class="rounded {
                            milestone.status === 'completed' ? 'bg-green-50 dark:bg-green-900/20' :
                            milestone.status === 'in_progress' ? 'bg-blue-50 dark:bg-blue-900/20' :
                            'bg-gray-50 dark:bg-gray-800/50'
                          }">
                            <summary class="flex items-start gap-2 p-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                              <span class="text-lg flex-shrink-0">{getMilestoneStatusIcon(milestone.status)}</span>
                              <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2">
                                  <span class="text-xs text-gray-400 font-mono">#{milestone.order || i + 1}</span>
                                  <span class="font-medium text-sm {
                                    milestone.status === 'completed' ? 'text-green-700 dark:text-green-300' :
                                    milestone.status === 'in_progress' ? 'text-blue-700 dark:text-blue-300' :
                                    'text-gray-700 dark:text-gray-300'
                                  }">{milestone.title}</span>
                                  {#if (desire.goalProgress?.currentMilestone || 0) === i && milestone.status !== 'completed'}
                                    <span class="text-[0.6rem] px-1 py-0.5 bg-blue-500 text-white rounded uppercase font-bold">Current</span>
                                  {/if}
                                </div>
                                {#if milestone.description}
                                  <p class="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{milestone.description}</p>
                                {/if}
                                {#if milestone.completedAt}
                                  <p class="text-[0.6rem] text-gray-400 dark:text-gray-500 mt-0.5">Completed: {formatTimestamp(milestone.completedAt)}</p>
                                {/if}
                              </div>
                              <span class="text-xs text-gray-400 flex-shrink-0 mt-1">▶</span>
                            </summary>

                            <!-- Milestone Details (expanded) -->
                            <div class="p-3 border-t {
                              milestone.status === 'completed' ? 'border-green-200 dark:border-green-800' :
                              milestone.status === 'in_progress' ? 'border-blue-200 dark:border-blue-800' :
                              'border-gray-200 dark:border-gray-700'
                            }">
                              {#if milestone.status === 'completed'}
                                <!-- Completed milestone: show what was accomplished -->
                                <div class="text-xs">
                                  <p class="font-semibold text-green-700 dark:text-green-300 mb-2">✅ Accomplishments:</p>

                                  {#if executionLoading[desire.id]}
                                    <p class="text-gray-500 dark:text-gray-400 italic">Loading execution details...</p>
                                  {:else if executionErrors[desire.id]}
                                    <p class="text-red-600" role="alert">{executionErrors[desire.id]} <button class="underline" on:click={() => loadExecutionData(desire.id)}>Retry execution details</button></p>
                                  {:else if executionData[desire.id]?.length > 0}
                                    <!-- Show execution results from loaded data -->
                                    {@const latestExecution = executionData[desire.id][0]}
                                    {#if latestExecution.stepResults?.length > 0}
                                      <div class="space-y-3">
                                        {#each latestExecution.stepResults as result, ri}
                                          <details class="bg-white dark:bg-gray-900 rounded border border-green-200 dark:border-green-800 overflow-hidden">
                                            <summary class="p-2 cursor-pointer list-none [&::-webkit-details-marker]:hidden flex items-center gap-2 hover:bg-green-50 dark:hover:bg-green-900/30">
                                              <span class="{result.success ? 'text-green-500' : 'text-red-500'}">{result.success ? '✓' : '✗'}</span>
                                              <span class="font-medium flex-1">Step {ri + 1}</span>
                                              <span class="text-gray-400 text-[0.65rem]">▼</span>
                                            </summary>
                                            <div class="p-3 border-t border-green-100 dark:border-green-900 bg-gray-50 dark:bg-gray-950">
                                              {#if result.result?.response}
                                                <div class="prose prose-sm dark:prose-invert max-w-none text-gray-700 dark:text-gray-300 whitespace-pre-wrap text-xs leading-relaxed max-h-96 overflow-y-auto">
                                                  {result.result.response}
                                                </div>
                                              {:else if result.output}
                                                <p class="text-gray-600 dark:text-gray-400 whitespace-pre-wrap">{typeof result.output === 'string' ? result.output : JSON.stringify(result.output, null, 2)}</p>
                                              {:else}
                                                <p class="text-gray-500 dark:text-gray-400 italic">No detailed output recorded.</p>
                                              {/if}
                                              {#if result.result?.executionTime}
                                                <p class="text-[0.6rem] text-gray-400 mt-2">Execution time: {(result.result.executionTime / 1000).toFixed(1)}s</p>
                                              {/if}
                                            </div>
                                          </details>
                                        {/each}
                                      </div>
                                    {:else}
                                      <p class="text-gray-500 dark:text-gray-400 italic">Execution completed but no step details recorded.</p>
                                    {/if}
                                  {:else}
                                    <p class="text-gray-500 dark:text-gray-400 italic">
                                      No execution data found. Check the Journey Log below for activity records.
                                    </p>
                                  {/if}

                                  {#if milestone.tasks && milestone.tasks.length > 0}
                                    <div class="mt-2">
                                      <p class="font-semibold text-gray-600 dark:text-gray-400">📋 Related Tasks:</p>
                                      <ul class="list-disc list-inside text-gray-500 dark:text-gray-400">
                                        {#each milestone.tasks as taskId}
                                          <li class="font-mono text-[0.65rem]">{taskId}</li>
                                        {/each}
                                      </ul>
                                    </div>
                                  {/if}
                                </div>

                              {:else if milestone.status === 'in_progress'}
                                <!-- Current milestone: show what's happening -->
                                <div class="text-xs">
                                  <p class="font-semibold text-blue-700 dark:text-blue-300 mb-2">🔄 In Progress:</p>
                                  {#if desire.plan?.steps}
                                    <p class="text-gray-600 dark:text-gray-400 mb-2">Current plan has {desire.plan.steps.length} step(s):</p>
                                    <ul class="space-y-1">
                                      {#each desire.plan.steps.slice(0, 5) as step}
                                        <li class="flex items-start gap-2 text-gray-600 dark:text-gray-400">
                                          <span class="text-blue-500">→</span>
                                          <span>{step.action}</span>
                                        </li>
                                      {/each}
                                      {#if desire.plan.steps.length > 5}
                                        <li class="text-gray-400 dark:text-gray-500 italic">...and {desire.plan.steps.length - 5} more</li>
                                      {/if}
                                    </ul>
                                  {:else}
                                    <p class="text-gray-500 dark:text-gray-400 italic">No plan generated yet for this milestone.</p>
                                  {/if}
                                </div>

                              {:else}
                                <!-- Pending milestone -->
                                <p class="text-xs text-gray-500 dark:text-gray-400 italic">
                                  This milestone hasn't started yet. Complete earlier milestones first.
                                </p>
                              {/if}
                            </div>
                          </details>
                        {/each}
                      </div>

                      <!-- Last Check-in Info -->
                      {#if desire.goalProgress?.lastCheckinAt}
                        <div class="mt-3 pt-2 border-t border-violet-200 dark:border-violet-800 flex items-center justify-between">
                          <span class="text-xs text-gray-500 dark:text-gray-400">
                            Last check-in: {formatTimestamp(desire.goalProgress.lastCheckinAt)}
                          </span>
                          <button
                            type="button"
                            class="text-xs px-2 py-1 bg-violet-100 hover:bg-violet-200 dark:bg-violet-800 dark:hover:bg-violet-700 text-violet-700 dark:text-violet-200 rounded transition-colors"
                            on:click|stopPropagation={() => requestCheckin(desire.id)}
                            disabled={processingId === desire.id}
                          >
                            {processingId === desire.id ? '⏳' : '🔄'} Request Check-in
                          </button>
                        </div>
                      {:else}
                        <div class="mt-3 pt-2 border-t border-violet-200 dark:border-violet-800 flex items-center justify-end">
                          <button
                            type="button"
                            class="text-xs px-2 py-1 bg-violet-100 hover:bg-violet-200 dark:bg-violet-800 dark:hover:bg-violet-700 text-violet-700 dark:text-violet-200 rounded transition-colors"
                            on:click|stopPropagation={() => requestCheckin(desire.id)}
                            disabled={processingId === desire.id}
                          >
                            {processingId === desire.id ? '⏳' : '🔄'} Request Check-in
                          </button>
                        </div>
                      {/if}
                    </div>
                  </details>
                {/if}

                <!-- Meta info -->
                <div class="flex gap-4 text-xs text-gray-500 dark:text-gray-400 mb-2">
                  <span>Created: {formatTimestamp(desire.createdAt)}</span>
                  <span>Updated: {formatTimestamp(desire.updatedAt)}</span>
                </div>

                {#if desire.status === 'approved' && !desire.plan}
                  <div class="p-3 bg-red-50 dark:bg-red-900/20 border-2 border-red-400 dark:border-red-600 rounded-md mb-2 text-sm text-red-700 dark:text-red-300">
                    ⚠️ <strong>No plan generated.</strong> Click "Generate Plan" to create an execution plan for this desire.
                  </div>
                {/if}

                {#if desire.plan}
                  <!-- Plan Summary Header (clickable to expand) -->
                  <button
                    type="button"
                    class="w-full text-left p-2 bg-gray-50 dark:bg-gray-800/50 rounded-md mb-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors"
                    on:click|stopPropagation={() => togglePlanDetail(desire.id)}
                    aria-expanded={expandedPlanId === desire.id}
                  >
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-xs font-semibold">
                        📋 Plan v{desire.plan.version || 1}:
                      </span>
                      <span class="text-xs muted">
                        {desire.plan.steps.length} steps, {desire.plan.estimatedRisk} risk
                        {#if desire.planHistory && desire.planHistory.length > 0}
                          <span class="italic text-violet-500">({desire.planHistory.length} previous)</span>
                        {/if}
                      </span>
                      <span class="ml-auto text-xs text-gray-500">{expandedPlanId === desire.id ? '▼' : '▶'}</span>
                    </div>
                    {#if desire.plan.operatorGoal}
                      <p class="text-xs muted mt-1 italic">Goal: {desire.plan.operatorGoal}</p>
                    {/if}
                  </button>

                  <!-- Expanded Plan Details -->
                  {#if expandedPlanId === desire.id}
                    <div class="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 rounded-md p-4 mb-2">
                      <h5 class="font-semibold text-sm mb-2 text-gray-700 dark:text-gray-200">Execution Steps</h5>
                      <div class="flex flex-col gap-3">
                        {#each desire.plan.steps as step, i}
                          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded p-3">
                            <div class="flex items-center gap-2 flex-wrap mb-1">
                              <span class="inline-flex items-center justify-center w-6 h-6 bg-blue-600 text-white rounded-full text-xs font-semibold">{step.order || i + 1}</span>
                              <span class="font-medium flex-1">{step.action}</span>
                              <span class="inline-block px-1.5 py-0.5 rounded-full text-[0.625rem] font-medium {getRiskColor(step.risk)}">{step.risk}</span>
                              {#if step.requiresApproval}
                                <span class="inline-block px-1.5 py-0.5 rounded-full text-[0.625rem] font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200">needs approval</span>
                              {/if}
                            </div>
                            {#if step.skill}
                              <div class="flex gap-2 mt-1 pl-8">
                                <span class="text-xs muted">Skill:</span>
                                <code class="text-xs bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded font-mono">{step.skill}</code>
                              </div>
                            {/if}
                            {#if step.expectedOutcome}
                              <div class="flex gap-2 mt-1 pl-8">
                                <span class="text-xs muted">Expected:</span>
                                <span class="text-xs">{step.expectedOutcome}</span>
                              </div>
                            {/if}
                            {#if step.inputs && Object.keys(step.inputs).length > 0}
                              <div class="flex gap-2 mt-1 pl-8">
                                <span class="text-xs muted">Inputs:</span>
                                <code class="text-xs bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded font-mono">{JSON.stringify(step.inputs)}</code>
                              </div>
                            {/if}
                          </div>
                        {/each}
                      </div>

                      <!-- Plan History Toggle -->
                      {#if desire.planHistory && desire.planHistory.length > 0}
                        <button
                          class="w-full mt-3 p-1.5 text-xs bg-transparent border border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400 rounded cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700/50"
                          on:click|stopPropagation={() => togglePlanHistory(desire.id)}
                        >
                          {showHistoryFor === desire.id ? '▼ Hide' : '▶ Show'} Previous Versions ({desire.planHistory.length})
                        </button>

                        {#if showHistoryFor === desire.id}
                          <div class="mt-2 p-2 bg-amber-50 dark:bg-amber-900/30 rounded">
                            {#each desire.planHistory as oldPlan, idx}
                              <div class="mb-3 pb-3 border-b border-amber-200 dark:border-amber-800 last:border-b-0 last:mb-0 last:pb-0">
                                <h6 class="text-xs font-semibold text-amber-700 dark:text-amber-300">Version {oldPlan.version || idx + 1} ({formatTimestamp(oldPlan.createdAt)})</h6>
                                {#if oldPlan.basedOnCritique}
                                  <p class="text-xs italic text-amber-600 dark:text-amber-400 my-1">Critique: "{oldPlan.basedOnCritique}"</p>
                                {/if}
                                <ul class="list-none p-0 m-0 mt-1 text-xs text-amber-700 dark:text-amber-400">
                                  {#each oldPlan.steps as step, i}
                                    <li>{step.order || i + 1}. {step.action}</li>
                                  {/each}
                                </ul>
                              </div>
                            {/each}
                          </div>
                        {/if}
                      {/if}

                      <!-- Critique & Revision Section -->
                      {#if ['reviewing', 'approved', 'awaiting_approval', 'planning'].includes(desire.status)}
                        <div class="mt-4 pt-4 border-t border-dashed border-gray-200 dark:border-gray-700">
                          <h5 class="font-semibold text-sm mb-2 text-gray-700 dark:text-gray-200">✏️ Request Revision</h5>
                          <p class="text-xs muted mb-2">
                            Not happy with the plan? Provide feedback and request a revision.
                          </p>
                          <textarea
                            class="input-field resize-y"
                            placeholder="Enter your critique or suggestions for improving this plan..."
                            bind:value={critiqueText[desire.id]}
                            rows="3"
                          ></textarea>
                          <div class="mt-2 flex justify-end">
                            <button
                              class="px-3 py-1.5 text-xs font-medium rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
                              disabled={revisingId === desire.id || !critiqueText[desire.id]?.trim()}
                              on:click|stopPropagation={() => handleRevise(desire.id)}
                            >
                              {revisingId === desire.id ? 'Requesting...' : '🔄 Request Revision'}
                            </button>
                          </div>
                        </div>
                      {/if}
                    </div>
                  {/if}
                {/if}

                {#if desire.review}
                  <div class="p-2 bg-gray-50 dark:bg-gray-800/50 rounded mb-2">
                    <span class="text-xs font-semibold">Review:</span>
                    <span class="text-xs muted">{desire.review.verdict} (alignment: {(desire.review.alignmentScore * 100).toFixed(0)}%)</span>
                    {#if desire.review.reasoning}
                      <p class="text-xs muted mt-1 italic">{desire.review.reasoning}</p>
                    {/if}
                    {#if desire.review.concerns && desire.review.concerns.length > 0}
                      <div class="mt-2">
                        <span class="text-xs font-semibold">Concerns:</span>
                        <ul class="list-none p-0 m-0 mt-1">
                          {#each desire.review.concerns as concern}
                            <li class="text-xs muted">• {concern}</li>
                          {/each}
                        </ul>
                      </div>
                    {/if}
                  </div>
                {/if}

                {#if desire.userCritique}
                  <div class="p-2 bg-amber-50 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700 rounded mb-2">
                    <span class="text-xs font-semibold">⏳ Pending Revision:</span>
                    <p class="text-xs muted">"{desire.userCritique}"</p>
                    <span class="text-xs muted">Submitted: {formatTimestamp(desire.critiqueAt || null)}</span>
                  </div>
                {/if}

                <!-- Execution Status Display -->
                {#if desire.execution}
                  <div
                    class="p-3 rounded-md mb-2 border {(desire.execution.status === 'in_progress' || desire.execution.status === 'running') ? 'bg-green-50 dark:bg-green-900/20 border-green-500 animate-pulse' : 'bg-blue-50 dark:bg-blue-900/20 border-blue-400'}"
                  >
                    <div class="flex justify-between items-center mb-1">
                      <span class="text-sm font-semibold">
                        {#if desire.execution.status === 'in_progress' || desire.execution.status === 'running'}
                          ⚡ Executing...
                        {:else if desire.execution.status === 'completed'}
                          ✅ Execution Complete
                        {:else if desire.execution.status === 'failed'}
                          ❌ Execution Failed
                        {:else}
                          📊 Execution: {desire.execution.status}
                        {/if}
                      </span>
                      <span class="text-xs muted">
                        Step {desire.execution.stepsCompleted || 0} / {desire.execution.stepsTotal || desire.plan?.steps.length || '?'}
                      </span>
                    </div>
                    {#if desire.execution.error}
                      <p class="text-xs text-red-600 dark:text-red-400 mt-1">{desire.execution.error}</p>
                    {/if}
                    <div class="text-xs muted mt-1">
                      Started: {formatTimestamp(desire.execution.startedAt)}
                      {#if desire.execution.completedAt}
                        • Completed: {formatTimestamp(desire.execution.completedAt)}
                      {/if}
                    </div>
                  </div>
                {/if}

                <!-- Outcome Review Display -->
                {#if desire.outcomeReview}
                  <div
                    class="p-3 rounded-md mb-2 border {desire.outcomeReview.successScore >= 0.7 ? 'bg-green-50 dark:bg-green-900/20 border-green-500' : desire.outcomeReview.successScore >= 0.4 ? 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-500' : 'bg-red-50 dark:bg-red-900/20 border-red-500'}"
                  >
                    <div class="flex justify-between items-center mb-2">
                      <span class="text-sm font-semibold">
                        📊 Outcome: {desire.outcomeReview.verdict}
                      </span>
                      <span class="text-xs font-semibold px-2 py-0.5 rounded-full bg-black/10 dark:bg-white/10">
                        {(desire.outcomeReview.successScore * 100).toFixed(0)}% success
                      </span>
                    </div>
                    <p class="text-xs mb-2 italic">{desire.outcomeReview.reasoning}</p>
                    {#if desire.outcomeReview.executionSummary}
                      <div class="mt-3 p-2 bg-blue-600/10 dark:bg-blue-400/10 rounded border-l-4 border-blue-600">
                        <span class="text-xs font-semibold">📋 What was done:</span>
                        <pre class="mt-1 text-xs whitespace-pre-wrap text-gray-600 dark:text-gray-400">{desire.outcomeReview.executionSummary}</pre>
                      </div>
                    {/if}
                    {#if desire.outcomeReview.lessonsLearned && desire.outcomeReview.lessonsLearned.length > 0}
                      <div class="mt-2">
                        <span class="text-xs font-semibold">Lessons:</span>
                        <ul class="list-none p-0 m-0 mt-1">
                          {#each desire.outcomeReview.lessonsLearned as lesson}
                            <li class="text-xs muted">• {lesson}</li>
                          {/each}
                        </ul>
                      </div>
                    {/if}
                  </div>
                {/if}

                <!-- Journey Log Button - More Prominent -->
                {#if desire.metrics || desire.scratchpad}
                  <button
                    class="w-full flex items-center gap-3 p-3 rounded-lg border-2 text-sm font-medium cursor-pointer text-left mb-2 transition-all hover:translate-y-[-1px] hover:shadow-md {showScratchpadFor !== desire.id ? 'bg-white dark:bg-gray-800' : 'border-b-transparent rounded-b-none'}"
                    style="border-color: {getNatureColor(desire.metrics)};"
                    on:click={() => toggleScratchpadWithLoad(desire.id)}
                  >
                    <span class="text-xl">📜</span>
                    <span class="flex-1">
                      {showScratchpadFor === desire.id ? 'Hide' : 'Explore'} Journey Log
                    </span>
                    {#if desire.scratchpad?.entryCount}
                      <span class="px-2 py-1 rounded-full text-white text-xs font-semibold" style="background: {getNatureColor(desire.metrics)};">
                        {desire.scratchpad.entryCount} events
                      </span>
                    {/if}
                    <span class="text-xs text-gray-500 dark:text-gray-400 ml-auto">{showScratchpadFor === desire.id ? '▲' : '▼'}</span>
                  </button>

                  {#if showScratchpadFor === desire.id}
                    <div class="bg-gray-50 dark:bg-gray-800/50 border-2 border-t-0 rounded-b-lg p-4 -mt-2 mb-2" style="border-color: {getNatureColor(desire.metrics)};">
                      <!-- Metrics Summary -->
                      <div class="flex flex-wrap gap-4 pb-3 border-b border-gray-200 dark:border-gray-700 mb-3 text-xs text-gray-500 dark:text-gray-400">
                        <span>📋 Plans: {desire.metrics?.planVersionCount || 0}</span>
                        <span>🔄 Attempts: {desire.metrics?.executionAttemptCount || 0}</span>
                        <span>✅ Successes: {desire.metrics?.executionSuccessCount || 0}</span>
                        <span>💪 Reinforced: {desire.metrics?.reinforcementCount || 0}</span>
                        <span>📉 Decays: {desire.metrics?.decayCount || 0}</span>
                        <span>👤 User Input: {desire.metrics?.userInputCount || 0}</span>
                        <span>🔁 Cycles: {desire.metrics?.cycleCount || 0}</span>
                      </div>

                      <!-- Plan Version Browser -->
                      {#if planVersions.length > 0 || planListError || planError || planRead || (desire.planHistory && desire.planHistory.length > 0)}
                        <div class="pt-3 border-t border-gray-200 dark:border-gray-700 mt-3">
                          <h6 class="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">📋 Plan Versions</h6>
                          {#if planListError}<p class="text-red-600" role="alert">{planListError} <button class="underline" on:click={() => loadPlanVersions(desire.id)}>Retry plan versions</button></p>{/if}
                          {#if planError && selectedPlanVersion !== null}<p class="text-red-600" role="alert">{planError} <button class="underline" on:click={() => selectedPlanVersion !== null && loadPlanVersion(desire.id, selectedPlanVersion)}>Retry selected plan</button></p>{/if}
                          {#if planRead}<p class="text-xs muted">Loading selected plan...</p>{/if}
                          <div class="flex flex-wrap gap-2 mb-2">
                            {#if desire.plan}
                              <button
                                class="px-2 py-1 text-xs rounded border transition-all {!selectedPlanVersion ? 'bg-blue-600 border-blue-700 text-white' : 'bg-gray-100 dark:bg-gray-700 border-gray-200 dark:border-gray-600'}"
                                on:click={() => showCurrentPlan(desire.plan)}
                              >
                                Current (v{desire.plan.version || 1})
                              </button>
                            {/if}
                            {#each planVersions as version}
                              {@const vNum = parseInt(version.replace('v', '').replace('.json', ''))}
                              <button
                                class="px-2 py-1 text-xs rounded border transition-all {selectedPlanVersion === vNum ? 'bg-blue-600 border-blue-700 text-white' : 'bg-gray-100 dark:bg-gray-700 border-gray-200 dark:border-gray-600'}"
                                on:click={() => loadPlanVersion(desire.id, vNum)}
                              >
                                {version.replace('.json', '')}
                              </button>
                            {/each}
                          </div>
                          {#if viewingPlan && selectedPlanVersion}
                            <div class="bg-blue-50 dark:bg-blue-900/30 border border-blue-400 rounded p-2 mt-2">
                              <p class="text-xs muted">Viewing v{viewingPlan.version}: {viewingPlan.operatorGoal || 'No goal'}</p>
                              <div class="mt-1">
                                {#each viewingPlan.steps as step, i}
                                  <div class="py-0.5 text-xs text-gray-600 dark:text-gray-400">
                                    {step.order || i + 1}. {step.action}
                                  </div>
                                {/each}
                              </div>
                            </div>
                          {/if}
                        </div>
                      {/if}

                      <!-- Scratchpad File Browser -->
                      <div class="pt-3 border-t border-gray-200 dark:border-gray-700 mt-3">
                        <h6 class="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">📜 Journey Events</h6>
                        {#if scratchpadError}<p class="text-red-600" role="alert">{scratchpadError} <button class="underline" on:click={() => loadScratchpadEntries(desire.id, scratchpadOffset)}>Retry journey events</button></p>{/if}

                        {#if scratchpadLoading}
                          <p class="text-xs muted">Loading events...</p>
                        {:else if scratchpadEntries.length > 0}
                          <div class="max-h-72 overflow-y-auto flex flex-col gap-2">
                            {#each scratchpadEntries as entry, idx}
                              <div
                                class="flex items-start gap-2 p-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded transition-colors {entry.data ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800' : ''} {expandedEntryIndex === idx ? 'bg-green-50 dark:bg-green-900/20 border-green-500' : ''}"
                                on:click={() => entry.data && (expandedEntryIndex = expandedEntryIndex === idx ? null : idx)}
                                on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && entry.data && (expandedEntryIndex = expandedEntryIndex === idx ? null : idx)}
                                tabindex={entry.data ? 0 : -1}
                                role="button"
                                aria-disabled={!entry.data}
                                aria-expanded={entry.data ? expandedEntryIndex === idx : undefined}
                              >
                                <span class="text-base flex-shrink-0">{getScratchpadEntryIcon(entry.type)}</span>
                                <div class="flex-1 flex flex-col gap-0.5">
                                  <div class="flex justify-between items-start gap-2">
                                    <span class="text-sm">{entry.description}</span>
                                    {#if entry.data}
                                      <span class="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">{expandedEntryIndex === idx ? '▲' : '▼'}</span>
                                    {/if}
                                  </div>
                                  <span class="text-[0.625rem] text-gray-500 dark:text-gray-400">
                                    {formatTimestamp(entry.timestamp)} by {entry.agentName || entry.actor}
                                  </span>
                                  {#if expandedEntryIndex === idx && entry.data}
                                    <div class="mt-2 pt-2 border-t border-dashed border-gray-300 dark:border-gray-600">
                                      <pre class="text-xs font-mono bg-gray-50 dark:bg-gray-900 p-3 rounded overflow-x-auto whitespace-pre-wrap break-words max-h-72 overflow-y-auto">{JSON.stringify(entry.data, null, 2)}</pre>
                                    </div>
                                  {/if}
                                </div>
                              </div>
                            {/each}
                          </div>

                          <!-- Pagination -->
                          {#if scratchpadTotal > scratchpadLimit}
                            <div class="flex justify-between items-center mt-3 pt-2 border-t border-gray-200 dark:border-gray-700">
                              <button
                                class="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                                disabled={scratchpadOffset === 0}
                                on:click={() => loadScratchpadEntries(desire.id, Math.max(0, scratchpadOffset - scratchpadLimit))}
                              >
                                ← Newer
                              </button>
                              <span class="flex-1 text-center text-xs muted">
                                {scratchpadOffset + 1}-{Math.min(scratchpadOffset + scratchpadLimit, scratchpadTotal)} of {scratchpadTotal}
                              </span>
                              <button
                                class="px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                                disabled={scratchpadOffset + scratchpadLimit >= scratchpadTotal}
                                on:click={() => loadScratchpadEntries(desire.id, scratchpadOffset + scratchpadLimit)}
                              >
                                Older →
                              </button>
                            </div>
                          {/if}
                        {:else if !scratchpadError}
                          <p class="text-xs muted">No journey events logged yet</p>
                        {/if}

                        <!-- File List (clickable) -->
                        {#if scratchpadFiles.length > 0}
                          <details class="mt-3 pt-2 border-t border-gray-200 dark:border-gray-700" open>
                            <summary class="text-xs font-semibold text-gray-700 dark:text-gray-300 cursor-pointer select-none">📁 {scratchpadFiles.length} scratchpad files</summary>
                            <div class="mt-2 flex flex-col gap-1 max-h-60 overflow-y-auto">
                              {#each scratchpadFiles as file}
                                <button
                                  type="button"
                                  class="w-full text-left px-2 py-1.5 text-xs font-mono rounded transition-colors flex items-center gap-2 {
                                    selectedFileName === file
                                      ? 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300 border border-violet-300 dark:border-violet-700'
                                      : 'bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300'
                                  }"
                                  on:click={() => toggleScratchpadFile(desire.id, file)}
                                >
                                  <span class="flex-shrink-0">
                                    {#if file.includes('plan')}📋
                                    {:else if file.includes('execution')}⚡
                                    {:else if file.includes('status')}🔄
                                    {:else if file.includes('note')}📝
                                    {:else}📄{/if}
                                  </span>
                                  <span class="flex-1 truncate">{file}</span>
                                  {#if selectedFileName === file}
                                    <span class="text-violet-500">▼</span>
                                  {:else}
                                    <span class="text-gray-400">▶</span>
                                  {/if}
                                </button>

                                <!-- File content viewer (inline below selected file) -->
                                {#if selectedFileName === file}
                                  <div class="ml-4 p-3 bg-gray-50 dark:bg-gray-900 border-l-2 border-violet-500 rounded-r text-xs">
                                    {#if fileViewLoading}
                                      <p class="text-gray-500">Loading...</p>
                                    {:else if fileError}
                                      <p class="text-red-600" role="alert">{fileError} <button class="underline" on:click={() => loadScratchpadFile(desire.id, file)}>Retry file</button></p>
                                    {:else if selectedFileContent}
                                        <!-- File metadata -->
                                        <div class="flex flex-wrap gap-3 mb-2 pb-2 border-b border-gray-200 dark:border-gray-700">
                                          {#if selectedFileContent.type}
                                            <span class="px-2 py-0.5 bg-violet-100 dark:bg-violet-900/50 text-violet-700 dark:text-violet-300 rounded text-[0.65rem] uppercase font-semibold">{selectedFileContent.type}</span>
                                          {/if}
                                          {#if selectedFileContent.timestamp}
                                            <span class="text-gray-500">🕐 {formatTimestamp(selectedFileContent.timestamp)}</span>
                                          {/if}
                                          {#if selectedFileContent.actor}
                                            <span class="text-gray-500">👤 {selectedFileContent.actor}</span>
                                          {/if}
                                        </div>

                                        <!-- Description -->
                                        {#if selectedFileContent.description}
                                          <p class="text-gray-700 dark:text-gray-300 mb-2">{selectedFileContent.description}</p>
                                        {/if}

                                        <!-- Data payload -->
                                        {#if selectedFileContent.data && Object.keys(selectedFileContent.data).length > 0}
                                          <details class="mt-2">
                                            <summary class="cursor-pointer text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 select-none">📦 Data payload</summary>
                                            <pre class="mt-1 p-2 bg-gray-100 dark:bg-gray-800 rounded text-[0.65rem] overflow-x-auto max-h-40">{JSON.stringify(selectedFileContent.data, null, 2)}</pre>
                                          </details>
                                        {/if}
                                    {:else}
                                      <p class="text-gray-500">No content</p>
                                    {/if}
                                  </div>
                                {/if}
                              {/each}
                            </div>
                          </details>
                        {/if}
                      </div>

                      {#if desire.folderPath}
                        <p class="text-xs muted font-mono mt-2">
                          📁 {desire.folderPath}
                        </p>
                      {/if}
                    </div>
                  {/if}
                {/if}

                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div class="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-200 dark:border-gray-700" on:click|stopPropagation>
                  <!-- Stage progression buttons -->
                  {#if desire.status === 'nascent'}
                    <button
                      class="btn-primary btn-xs"
                      disabled={processingId === desire.id}
                      on:click={() => handleAdvanceStage(desire.id, 'pending')}
                    >
                      → Pending
                    </button>
                  {/if}
                  {#if desire.status === 'pending'}
                    <button
                      class="px-3 py-1.5 text-xs font-medium rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
                      style="background: linear-gradient(135deg, #6d28d9, #8b5cf6);"
                      disabled={processingId === desire.id || agentProcessingId === desire.id}
                      on:click={() => handleGeneratePlan(desire.id)}
                    >
                      {#if agentProcessingId === desire.id && agentOperation === 'planning'}
                        <span class="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1"></span>
                      {:else}
                        🧠
                      {/if}
                      Generate Plan
                    </button>
                  {/if}
                  {#if desire.status === 'planning'}
                    <button
                      class="px-3 py-1.5 text-xs font-medium rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
                      style="background: linear-gradient(135deg, #6d28d9, #8b5cf6);"
                      disabled={processingId === desire.id || agentProcessingId === desire.id}
                      on:click={() => handleGeneratePlan(desire.id)}
                    >
                      {#if agentProcessingId === desire.id && agentOperation === 'planning'}
                        <span class="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1"></span>
                      {:else}
                        🧠
                      {/if}
                      {desire.plan ? 'Regenerate Plan' : 'Generate Plan'}
                    </button>
                  {/if}
                  {#if desire.status === 'awaiting_approval'}
                    <button
                      class="btn-success btn-xs"
                      disabled={processingId === desire.id}
                      on:click={() => handleApprove(desire.id)}
                    >
                      ✅ Approve Plan
                    </button>
                  {/if}
                  {#if desire.status === 'approved'}
                    {#if desire.plan}
                      <button
                        class="px-3 py-1.5 text-xs font-medium rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
                        style="background: linear-gradient(135deg, #6d28d9, #8b5cf6);"
                        disabled={processingId === desire.id || agentProcessingId === desire.id}
                        on:click={() => handleExecute(desire.id)}
                      >
                        {#if agentProcessingId === desire.id && agentOperation === 'executing'}
                          <span class="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1"></span>
                        {:else}
                          🚀
                        {/if}
                        Execute
                      </button>
                    {:else}
                      <!-- No plan - need to generate one first -->
                      <button
                        class="px-3 py-1.5 text-xs font-medium rounded text-white disabled:opacity-50 disabled:cursor-not-allowed bg-amber-500 hover:bg-amber-600"
                        disabled={processingId === desire.id || agentProcessingId === desire.id}
                        on:click={() => handleGeneratePlan(desire.id)}
                        title="Generate an execution plan for this desire"
                      >
                        {#if agentProcessingId === desire.id && agentOperation === 'planning'}
                          <span class="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1"></span>
                        {:else}
                          🧠
                        {/if}
                        Generate Plan
                      </button>
                    {/if}
                  {/if}

                  <!-- Reset/Unstick for desires in later stages (to go back to planning) -->
                  {#if ['failed', 'needs_attention', 'awaiting_approval', 'reviewing', 'approved', 'questioning', 'awaiting_review'].includes(desire.status)}
                    <button
                      class="px-3 py-1.5 text-xs font-medium rounded text-white inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                      style="background: linear-gradient(135deg, #f59e0b, #d97706);"
                      disabled={processingId === desire.id}
                      on:click={() => handleReset(desire.id)}
                      title="Reset this desire back to planning stage (clears questions for fresh start)"
                    >
                      🔄 Reset to Planning
                    </button>
                  {/if}

                  <!-- Outcome Review for awaiting_review desires -->
                  {#if desire.status === 'awaiting_review'}
                    <button
                      class="px-3 py-1.5 text-xs font-medium rounded text-white disabled:opacity-50 disabled:cursor-not-allowed"
                      style="background: linear-gradient(135deg, #6d28d9, #8b5cf6);"
                      disabled={processingId === desire.id || agentProcessingId === desire.id}
                      on:click={() => handleOutcomeReview(desire.id)}
                      title="Run outcome review to verify completion"
                    >
                      {#if agentProcessingId === desire.id}
                        <span class="inline-block w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin mr-1"></span>
                        {currentLoadingMessage || 'Reviewing...'}
                      {:else}
                        🔍 Run Outcome Review
                      {/if}
                    </button>
                  {/if}

                  <!-- Reject -->
                  {#if ['nascent', 'pending', 'planning', 'reviewing', 'awaiting_approval', 'approved', 'needs_attention'].includes(desire.status)}
                    <button
                      class="btn-danger btn-xs"
                      disabled={processingId === desire.id}
                      on:click={() => handleReject(desire.id)}
                    >
                      ❌ Reject
                    </button>
                  {/if}
                  <!-- Archive - for active desires (send to dormant state) -->
                  {#if ['nascent', 'pending', 'planning', 'reviewing', 'awaiting_approval', 'approved', 'needs_attention', 'paused', 'completed'].includes(desire.status)}
                    <button
                      class="px-3 py-1.5 text-xs font-medium rounded text-white inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                      style="background: linear-gradient(135deg, #8b5cf6, #7c3aed);"
                      disabled={processingId === desire.id}
                      on:click={() => handleArchive(desire.id)}
                      title="Archive this desire (can be revived later)"
                    >
                      📦 Archive
                    </button>
                  {/if}

                  {#if ['nascent', 'pending', 'planning', 'questioning', 'reviewing', 'awaiting_approval', 'approved', 'needs_attention'].includes(desire.status)}
                    <button
                      class="px-3 py-1.5 text-xs font-medium rounded bg-slate-600 hover:bg-slate-700 text-white disabled:opacity-50"
                      disabled={processingId === desire.id}
                      on:click={() => handlePause(desire.id)}
                      title="Pause autonomous processing without archiving history"
                    >
                      ⏸ Pause
                    </button>
                  {/if}

                  <!-- Revive - for archived desires (bring back to active) -->
                  {#if ['rejected', 'abandoned', 'archived', 'failed', 'paused'].includes(desire.status)}
                    <button
                      class="px-3 py-1.5 text-xs font-medium rounded text-white inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                      style="background: linear-gradient(135deg, #10b981, #059669);"
                      disabled={processingId === desire.id}
                      on:click={() => handleRevive(desire.id)}
                      title="Revive this desire back to pending"
                    >
                      🔄 Revive
                    </button>
                  {/if}

                  {#if ['nascent', 'pending', 'rejected', 'abandoned', 'archived', 'failed', 'completed', 'awaiting_review'].includes(desire.status)}
                    <button
                      class="px-3 py-1.5 text-xs font-medium rounded bg-gray-500 hover:bg-gray-600 text-white disabled:opacity-50"
                      disabled={processingId === desire.id}
                      on:click={() => handleDelete(desire.id)}
                    >
                      🗑️ Delete
                    </button>
                  {/if}
                </div>
              </div>
            {/if}
            <!-- ========== END EXPANDED VIEW ========== -->
          </div>
        {/each}
      {/if}
    </div>
  {/if}

  <!-- Progress received from the active workflow -->
  {#if agentProcessingId && currentLoadingMessage}
    <div class="fixed inset-0 bg-black/75 flex items-center justify-center z-[9999] backdrop-blur-sm">
      <div
        class="border-2 border-violet-500 rounded-2xl p-8 text-center shadow-[0_0_40px_rgba(139,92,246,0.4)] animate-pulse"
        class:max-w-3xl={streamingOutput}
        class:w-[90%]={streamingOutput}
        class:max-h-[80vh]={streamingOutput}
        class:overflow-y-auto={streamingOutput}
        style="background: linear-gradient(135deg, #1e1e2e 0%, #2d1b4e 50%, #1e1e2e 100%);"
      >
        <div class="text-6xl animate-bounce drop-shadow-[0_0_10px_rgba(139,92,246,0.8)]">🧠</div>
        <div class="mt-4 text-xl text-purple-200 italic tracking-wide">{currentLoadingMessage}</div>

        <!-- Streaming status -->
        {#if streamingPhase}
          <div class="mt-4 p-3 bg-violet-600/20 rounded-lg text-left">
            <div class="text-base text-violet-300 font-medium">{streamingPhase}</div>
            {#if streamingSteps > 0}
              <div class="text-sm text-gray-400 mt-1 font-mono">Steps: {streamingSteps}</div>
            {/if}
          </div>
        {/if}

        <!-- Progress log display -->
        {#if streamingOutput}
          <div class="mt-4 text-left bg-black/30 rounded-lg overflow-hidden">
            <div class="flex justify-between items-center px-3 py-2 bg-violet-600/30 text-xs text-violet-200 font-medium">
              <span>📋 Progress Log</span>
              <span class="font-mono text-gray-400">{streamingOutput.split('\n').length} steps</span>
            </div>
            <pre class="p-3 font-mono text-xs leading-relaxed text-purple-200 whitespace-pre-wrap break-words max-h-72 overflow-y-auto">{streamingOutput}</pre>
          </div>
        {/if}

        <div class="mt-6 w-48 h-1.5 bg-gray-700 rounded-full overflow-hidden mx-auto">
          <div
            class="h-full w-[30%] rounded-full animate-[loading-progress_1.5s_ease-in-out_infinite]"
            style="background: linear-gradient(90deg, #8b5cf6, #a78bfa, #8b5cf6);"
          ></div>
        </div>

        <!-- Close button -->
        <button
          class="mt-4 px-6 py-2 bg-white/15 border border-white/30 rounded-md text-white/90 text-sm cursor-pointer transition-all hover:bg-white/25 hover:border-white/50 hover:text-white"
          on:click={() => finishOperation()}
          title="Close overlay"
        >
          ✕ Close
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .btn-xs {
    @apply px-2 py-1 text-xs;
  }

  @keyframes loading-progress {
    0% {
      transform: translateX(-100%);
    }

    100% {
      transform: translateX(400%);
    }
  }
</style>
