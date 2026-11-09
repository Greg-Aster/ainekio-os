/**
 * Unified API Router
 *
 * Routes requests to handlers based on path and method.
 * Works for both web (Astro) and mobile (nodejs-mobile).
 */

import type { UnifiedRequest, UnifiedResponse, RouteDefinition } from './types.js';
import {
  notFoundResponse,
  unauthorizedResponse,
  forbiddenResponse,
} from './types.js';
import { restoreAuthenticatedSession } from '../sessions.js';

// Core is the API registry for every transport.
import { handleAppInfo } from './handlers/app-info.js';
import { handleGetStatus } from './handlers/status.js';
import { handleCapture } from './handlers/memories.js';
import { handleListTasks, handleCreateTask, handleUpdateTask } from './handlers/tasks.js';
import { handleGetMe, handleLogin, handleLogout, handleListUsers, handleRegister, handleCreateSyncUser, handleGuest, handleChangePassword, handleResetPassword, handleChangeUsername, handleUpdateProfile } from './handlers/auth.js';
import { handleImportProfile, handleExportPriorityProfile, handleGetProfileMemories } from './handlers/profile-sync.js';
import {
  handleDeleteProfileSyncConfig,
  handleGetProfileSyncConfig,
  handlePutProfileSyncConfig,
} from './handlers/profile-sync-config.js';
import { handleGetPersonaCore, handleUpdatePersonaCore } from './handlers/persona.js';
import { handleGetCognitiveMode, handleSetCognitiveMode } from './handlers/cognitive-mode.js';
import { handleGetBuffer, handleClearBuffer } from './handlers/conversation.js';
import { handleListDesires, handleGetDesire, handleCreateDesire, handleUpdateDesire, handleDeleteDesire, handleApproveDesire, handleRejectDesire, handleResetDesire, handleGetDesireExecutions, handleAdvanceDesire, handleAnswerDesireQuestions, handleCheckinDesire, handleConfirmCompleteDesire, handleExecuteDesire, handleDesireFeedback, handleReadyToPlanDesire, handleRequestDesireRevision, handleReviseDesire } from './handlers/agency.js';
import { handleGenerateDesirePlanStream, handleOutcomeReviewStream, handleRunDesireStream } from './handlers/agency-workflows.js';
import {
  handleGetAddons,
  handleInstallAddonStream,
  handleUninstallAddon,
} from './handlers/addons.js';
import {
  handleGetTrainingConfig,
  handleUpdateTrainingConfig,
  handleGetTrainingData,
  handleUpdateTrainingData,
  handleGetTrainingOperation,
  handleLaunchTraining,
  handleCancelTraining,
} from './handlers/training.js';
import {
  handleGetProfileVisibility,
  handleSetProfileVisibility,
  handleListProfiles,
} from './handlers/profiles.js';
import { handleGetVoiceSample } from './handlers/voice-samples.js';
import { handleGetProfilePath, handleMigrateProfilePath, handleSwitchProfilePath, handleResetProfilePath, handleValidateProfilePath } from './handlers/profile-path.js';
import { handleListStorageDevices } from './handlers/storage-devices.js';
import {
  handleGetOnboardingState,
  handleUpdateOnboardingState,
  handleSkipOnboarding,
  handleCompleteOnboarding,
  handleUploadInboxFile,
} from './handlers/onboarding.js';
import {
  handleGetChatSettings,
  handleUpdateChatSettings,
  handleApplyChatPreset,
} from './handlers/chat-settings.js';
import {
  handleGetTrust,
  handleSetTrust,
} from './handlers/trust.js';
import {
  handleGetAgentConfig,
  handleSetAgentConfig,
} from './handlers/agent-config.js';
import {
  handleGetAuditControl,
  handleSetAuditControl,
} from './handlers/audit-control.js';
import { handleGetSystemStatus } from './handlers/system-status.js';
import {
  handleGetTrustCoupling,
  handleSetTrustCoupling,
} from './handlers/trust-coupling.js';
import {
  handleGetLoggingConfig,
  handleSetLoggingConfig,
} from './handlers/logging-config.js';
import { handleGetAudit } from './handlers/audit.js';
import { handleGetSleepStatus } from './handlers/sleep-status.js';
import { handleGetModelInfo } from './handlers/model-info.js';
import { handleGetGpuStatus } from './handlers/gpu-status.js';
import { handleGetMonitor, handleSetMonitorAgentVariable } from './handlers/monitor.js';
import { handleGetVoiceStatus } from './handlers/voice-status.js';
import { handleGetSecurityPolicy } from './handlers/security-policy.js';
import { handleGetRuntimeMode, handleSetRuntimeMode } from './handlers/runtime-mode.js';
import { handleSelectProfile, handleDeleteProfile, handleCreateProfile } from './handlers/profiles-manage.js';
import { handleGetRecoveryCodes, handleRegenerateRecoveryCodes } from './handlers/recovery-codes.js';
import { handleDeleteMemory } from './handlers/memories-delete.js';
import { handleValidateMemory } from './handlers/memories-validate.js';
import {
  handleGetTriggerManager,
  handlePatchTriggerManagerConfig,
  handleTriggerManagerControl,
} from './handlers/trigger-manager.js';
import {
  handleAgentCatalogControl,
  handleGetAgentCatalog,
} from './handlers/agent-catalog.js';
import { handleGetMoodSettings, handleUpdateMoodSettings } from './handlers/mood-settings.js';
import { handleGetBigBrotherConfig, handleSetBigBrotherConfig } from './handlers/big-brother-config.js';
import { handleGetPersonaToggle, handleSetPersonaToggle } from './handlers/persona-toggle.js';
import { handleGetStorageStatus } from './handlers/storage-status.js';
import { handleGetAgencyConfig, handleSetAgencyConfig } from './handlers/agency-config.js';
import { handleActivityPing } from './handlers/activity-ping.js';
import {
  handleClearQueueTasks,
  handleDeleteQueueTask,
  handleCancelQueueExecution,
  handleConfirmQueueCandidate,
  handleEnqueueTask,
  handleSubmitCoordinatorWork,
  handleGetQueueStatus,
  handleGetQueueTask,
  handleQueueStream,
  handleQueueTaskStream,
  handleQueueControl,
  handleTriggerAgent,
} from './handlers/unified-queue.js';
import { handleGetRunpodConfig } from './handlers/runpod-config.js';
import { handleValidateRunpodKey } from './handlers/runpod-validate.js';
import { handleSemanticTurn } from './handlers/semantic-turn.js';
import { handleGetTrainingModels } from './handlers/training-models.js';
import { handleGetVoiceModels } from './handlers/voice-models.js';
import { handleGetTrainingHistory, handleReviewTrainingCandidate } from './handlers/training-history.js';
import { handleGetMemoryContent, handlePutMemoryContent } from './handlers/memory-content.js';
import { handleListPersonaArchives, handlePersonaArchiveAction } from './handlers/persona-archives.js';
import { handleGetPsychoanalyzerConfig, handleSetPsychoanalyzerConfig } from './handlers/psychoanalyzer-config.js';
import { handleGetPersonaFacet, handleSetPersonaFacet } from './handlers/persona-facet.js';
import { handleGetAgencyMetrics } from './handlers/agency-metrics.js';
import { handleGetAgencyPlans, handleUpdateAgencyPlan } from './handlers/agency-plans.js';
import { handleGetAgencyScratchpad } from './handlers/agency-scratchpad.js';
import { handleGetCognitiveGraph, handleCreateCognitiveGraph, handleDeleteCognitiveGraph } from './handlers/cognitive-graph.js';
import { handleListCognitiveGraphs } from './handlers/cognitive-graphs.js';
import { handleGetGraphTraces } from './handlers/graph-traces.js';
import { handleExecuteGraphStream } from './handlers/execute-graph-stream.js';
import { handleGetNodeSchemas } from './handlers/node-schemas.js';
import { handleGetPersonaCoreManage, handleUpdatePersonaCoreManage } from './handlers/persona-core-manage.js';
import { handleGetPersonaFacetsManage, handleUpdatePersonaFacetsManage } from './handlers/persona-facets-manage.js';
import { handleGetLlmBackendConfig, handleSetLlmBackendConfig } from './handlers/llm-backend-config.js';
import { handleGetLlmBackendStatus } from './handlers/llm-backend-status.js';
import { handleOllamaControl } from './handlers/llm-backend-ollama.js';
import { handleGetOllamaLoras, handleCreateOllamaLora } from './handlers/ollama-loras.js';
import { handleLlmChat } from './handlers/llm-proxy.js';
import { handleGetCloudflareStatus, handleCloudflareStart, handleCloudflareStop, handleCloudflareToggle } from './handlers/cloudflare.js';
import { handleGetTrainingStatus } from './handlers/training-status.js';
import { handleGetTrainingConsoleLogs } from './handlers/training-console-logs.js';
import { handleGetTrainingRunning } from './handlers/training-running.js';
import { handleGetTrainingDatasetStats } from './handlers/training-dataset-stats.js';
import {
  handleGetAutomaticTraining,
  handleUpdateAutomaticTraining,
} from './handlers/training-automation.js';
import { handleGetTrainingLogs } from './handlers/training-logs.js';
import { handleGetVeracryptStatus } from './handlers/veracrypt-status.js';
import { handleGetTrainingLogFile } from './handlers/training-log-file.js';
import { handleGetGpuInfo } from './handlers/gpu-info.js';
import { handleGetMobileVersion } from './handlers/mobile-version.js';
import { handleResetFactory, handleResetFactoryGet } from './handlers/reset-factory.js';
import { handleGetPersonaIcon } from './handlers/persona-icon.js';
import { handleGetMobileDownload } from './handlers/mobile-download.js';
import { handleGetCredentialsSync, handleSaveCredentialsSync } from './handlers/credentials-sync.js';
import { handleStt } from './handlers/stt.js';
import { handleAgentsControl, handleRunAgent } from './handlers/agent.js';
import { handleEnvironmentBridgeActionResult, handleEnvironmentBridgeVisualResult, handleEnvironmentBridgeDiagnosticAudio, handleEnvironmentBridgeDiagnosticMedia, handleEnvironmentBridgeObservation, handleEnvironmentBridgeStatus, handleEnvironmentBridgeBehaviorSettings, handleEnvironmentBridgeStream, handleEnvironmentBridgeTelemetry } from './handlers/environment-bridge.js';
import { handleTtsGenerate, handleTtsStatus } from './handlers/tts.js';
import { handleGetAllMemories } from './handlers/memories-all.js';
import { handleGetEnvironmentTraining, handleReviewEnvironmentTraining } from './handlers/environment-training.js';
import { handleGetIndex, handleBuildIndex } from './handlers/vector-index.js';
import { handleGetModelRegistry, handleAssignModelRole, handleUpdateModelSettings } from './handlers/model-registry.js';
import { handleClearPersonaChat, handleCancelChatAlias } from './handlers/persona-chat.js';
import { handleGetServerUpdate, handlePostServerUpdate, handleRestartServer } from './handlers/server-update.js';
import { handleRemoteServerHealth, handleRemoteServerTest, handleRemoteServerConnect, handleRemoteServerDisconnect } from './handlers/remote-server.js';
import {
  handleListUserGuide,
  handleGetUserGuideChapter,
  handleSearchUserGuide,
} from './handlers/user-guide.js';
import { handleSubmitFeedback } from './handlers/feedback.js';
import { handleSystemError } from './handlers/system-error.js';
import { handleGetEmbeddingsConfig, handleUpdateEmbeddingsConfig } from './handlers/embeddings.js';
import { handleGetPersonaInsights } from './handlers/persona-insights.js';
import { handleExtractOnboardingPersona } from './handlers/onboarding-persona.js';
import { handleGetEventBusStatus, handlePostEventBusStatus } from './handlers/event-bus-status.js';
import { handleGetAstroServers, handlePostAstroServers } from './handlers/astro-servers.js';
import {
  handleTtsQueueDelivery,
  handleTtsQueueInterrupt,
  handleTtsQueueStream,
} from './handlers/tts-queue-stream.js';
import {
  handleBigBrotherControl,
  handleBigBrotherStatus,
} from './handlers/big-brother-terminal.js';
import { handleDecryptProfilePath, handleEncryptProfilePath } from './handlers/profile-encryption.js';
import { handleKokoroServer } from './handlers/tts-service-routes.js';
import { handleWhisperServer } from './handlers/whisper-server.js';
import { handleBufferStream } from './handlers/buffer-stream.js';
import { handleMonitorStream } from './handlers/monitor-stream.js';
import { handleTtsStream } from './handlers/tts-stream.js';
import { handleCreateProject, handleListProjects as handleListProjectsApi, handleGetProject, handleGetActionableTasks, handleGetBlockedTasks } from './handlers/projects.js';
import {
  handleGetVoiceSettings,
  handleSaveVoiceSettings,
} from './handlers/voice-settings.js';
import { handleResponsePipelineApi } from './handlers/response-pipeline.js';
import { handleSkipCuriosityQuestion } from './handlers/curiosity-questions.js';
import {
  handlePersonaGeneratorStart,
  handlePersonaGeneratorLoad,
  handlePersonaGeneratorAnswer,
  handlePersonaGeneratorUpdateAnswer,
  handlePersonaGeneratorFinalize,
  handlePersonaGeneratorApply,
  handlePersonaGeneratorDiscard,
  handlePersonaGeneratorAddNotes,
  handlePersonaGeneratorResetPersona,
  handlePersonaGeneratorPurgeSessions,
} from './handlers/persona-generator.js';
import { handleTerminalState, handleTerminalSession, handleTerminalEvents, handleTerminalMessage } from './handlers/terminal.js';
import { handleGetActiveOperatorStatus, handleGetActiveOperatorConfig, handleUpdateActiveOperatorConfig, handleActiveOperatorControl } from './handlers/active-operator.js';
import { handleGetServerInfo } from './handlers/server-info.js';

// ============================================================================
// Route Registry
// ============================================================================

const routes: RouteDefinition[] = [
  // System
  { method: 'GET', pattern: '/api/status', handler: handleGetStatus },
  { method: 'GET', pattern: '/api/app-info', handler: handleAppInfo },
  { method: 'GET', pattern: '/api/server-info', handler: handleGetServerInfo },
  { method: 'GET', pattern: '/api/event-bus-status', handler: handleGetEventBusStatus },
  { method: 'POST', pattern: '/api/event-bus-status', handler: handlePostEventBusStatus, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: '/api/big-brother-status', handler: handleBigBrotherStatus, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/big-brother-status', handler: handleBigBrotherControl, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: '/api/astro-servers', handler: handleGetAstroServers, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/astro-servers', handler: handlePostAstroServers, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/profile-path/encrypt', handler: handleEncryptProfilePath, requiresAuth: true },
  { method: 'POST', pattern: '/api/profile-path/decrypt', handler: handleDecryptProfilePath, requiresAuth: true },
  { method: 'GET', pattern: '/api/kokoro-server', handler: handleKokoroServer },
  { method: 'POST', pattern: '/api/kokoro-server', handler: handleKokoroServer, requiresAuth: true },
  { method: ['GET', 'POST'], pattern: '/api/whisper-server', handler: handleWhisperServer, requiresAuth: true },
  { method: 'GET', pattern: '/api/buffer-stream', handler: handleBufferStream },
  { method: 'GET', pattern: '/api/monitor/stream', handler: handleMonitorStream, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/tts-stream', handler: handleTtsStream, requiresAuth: true },

  // Auth
  { method: 'GET', pattern: '/api/auth/me', handler: handleGetMe },
  { method: 'POST', pattern: '/api/auth/login', handler: handleLogin, public: true, publicReason: 'auth bootstrap login' },
  { method: 'POST', pattern: '/api/auth/logout', handler: handleLogout, public: true, publicReason: 'logout clears stale cookies' },
  { method: 'POST', pattern: '/api/auth/register', handler: handleRegister, public: true, publicReason: 'first-user/account bootstrap' },
  { method: 'POST', pattern: '/api/auth/guest', handler: handleGuest, public: true, publicReason: 'explicit guest session bootstrap' },
  { method: 'POST', pattern: '/api/auth/sync-user', handler: handleCreateSyncUser, public: true, publicReason: 'mobile/profile sync bootstrap with credentials' },
  { method: 'GET', pattern: '/api/auth/users', handler: handleListUsers },
  { method: 'POST', pattern: '/api/auth/change-password', handler: handleChangePassword, requiresAuth: true },
  { method: 'POST', pattern: '/api/auth/reset-password', handler: handleResetPassword, public: true, publicReason: 'password recovery code flow' },
  { method: 'POST', pattern: '/api/auth/change-username', handler: handleChangeUsername, requiresAuth: true },
  { method: 'PUT', pattern: '/api/auth/update-profile', handler: handleUpdateProfile, requiresAuth: true },
  { method: 'GET', pattern: '/api/profile-sync/export-priority', handler: handleExportPriorityProfile, requiresAuth: true },
  { method: 'POST', pattern: '/api/profile-sync/export-priority', handler: handleExportPriorityProfile, public: true, publicReason: 'cross-device sync authenticates with body credentials' },
  { method: 'POST', pattern: '/api/profile-sync/import', handler: handleImportProfile, requiresAuth: true },
  { method: 'GET', pattern: '/api/profile-sync/memories', handler: handleGetProfileMemories, requiresAuth: true },
  { method: 'POST', pattern: '/api/profile-sync/memories', handler: handleGetProfileMemories, public: true, publicReason: 'cross-device sync authenticates with body credentials' },
  { method: 'GET', pattern: '/api/profile-sync/config', handler: handleGetProfileSyncConfig, requiresAuth: true },
  { method: 'PUT', pattern: '/api/profile-sync/config', handler: handlePutProfileSyncConfig, requiresAuth: true },
  { method: 'DELETE', pattern: '/api/profile-sync/config', handler: handleDeleteProfileSyncConfig, requiresAuth: true },

  // Memories
  { method: 'POST', pattern: '/api/capture', handler: handleCapture, requiresAuth: true },

  // Tasks
  { method: 'GET', pattern: '/api/tasks', handler: handleListTasks },  // Anonymous returns empty list
  { method: 'POST', pattern: '/api/tasks', handler: handleCreateTask, requiresAuth: true },
  { method: 'PATCH', pattern: '/api/tasks', handler: handleUpdateTask, requiresAuth: true },  // taskId from body
  // Task dependencies (Phase 4)
  { method: 'GET', pattern: '/api/tasks/actionable', handler: handleGetActionableTasks, requiresAuth: true },
  { method: 'GET', pattern: '/api/tasks/blocked', handler: handleGetBlockedTasks, requiresAuth: true },

  // Projects (Phase 4: Task Graph)
  { method: 'GET', pattern: '/api/projects', handler: handleListProjectsApi, requiresAuth: true },
  { method: 'POST', pattern: '/api/projects', handler: handleCreateProject, requiresAuth: true },
  { method: 'GET', pattern: /^\/api\/projects\/(?<id>[^\/]+)$/, handler: handleGetProject, requiresAuth: true },

  // Voice Loop (Phase 5)
  { method: 'GET', pattern: '/api/voice-settings', handler: handleGetVoiceSettings, requiresAuth: true },
  { method: 'POST', pattern: '/api/voice-settings', handler: handleSaveVoiceSettings, requiresAuth: true },

  // Terminal agent transport (all access is owner-only and same-origin).
  { method: 'GET', pattern: '/api/terminal/state', handler: handleTerminalState, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/terminal/sessions', handler: handleTerminalSession, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/terminal/message', handler: handleTerminalMessage, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: '/api/terminal/events', handler: handleTerminalEvents, requiresAuth: true, guard: 'owner' },

  // Active Operator
  { method: 'GET', pattern: '/api/active-operator/status', handler: handleGetActiveOperatorStatus, requiresAuth: true },
  { method: 'GET', pattern: '/api/active-operator/config', handler: handleGetActiveOperatorConfig, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/active-operator/config', handler: handleUpdateActiveOperatorConfig, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/active-operator/control', handler: handleActiveOperatorControl, requiresAuth: true, guard: 'owner' },

  // Agent process controls
  { method: 'POST', pattern: '/api/agents/control', handler: handleAgentsControl, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/agents/run', handler: handleRunAgent, requiresAuth: true, guard: 'owner' },

  // Environment bridge
  { method: 'POST', pattern: '/api/environment-bridge/behavior-settings', handler: handleEnvironmentBridgeBehaviorSettings, public: true, publicReason: 'service-token authenticated robot control for the active owner' },
  { method: 'GET', pattern: '/api/environment-bridge/status', handler: handleEnvironmentBridgeStatus, requiresAuth: true },
  { method: 'GET', pattern: '/api/environment-bridge/diagnostics/media', handler: handleEnvironmentBridgeDiagnosticMedia, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/environment-bridge/diagnostics/audio', handler: handleEnvironmentBridgeDiagnosticAudio, public: true, publicReason: 'service-token authenticated bounded diagnostic audio ingestion' },
  { method: 'POST', pattern: '/api/environment-bridge/telemetry', handler: handleEnvironmentBridgeTelemetry, public: true, publicReason: 'service-token authenticated bounded diagnostic telemetry ingestion' },
  { method: 'POST', pattern: '/api/environment-bridge/observation', handler: handleEnvironmentBridgeObservation, public: true, publicReason: 'service-token authenticated environment observation ingestion' },
  { method: 'GET', pattern: '/api/environment-bridge/stream', handler: handleEnvironmentBridgeStream, public: true, publicReason: 'service-token authenticated environment action stream' },
  { method: 'POST', pattern: '/api/environment-bridge/visual-result', handler: handleEnvironmentBridgeVisualResult, public: true, publicReason: 'service-token authenticated selected camera read result' },
  { method: 'POST', pattern: '/api/environment-bridge/action-result', handler: handleEnvironmentBridgeActionResult, public: true, publicReason: 'service-token authenticated environment action result ingestion' },

  // Persona
  { method: 'GET', pattern: '/api/persona-core', handler: handleGetPersonaCore, requiresAuth: true },
  { method: 'POST', pattern: '/api/persona-core', handler: handleUpdatePersonaCore, requiresAuth: true },

  // Cognitive Mode
  { method: 'GET', pattern: '/api/cognitive-mode', handler: handleGetCognitiveMode },
  { method: 'POST', pattern: '/api/cognitive-mode', handler: handleSetCognitiveMode, requiresAuth: true, guard: 'owner' },

  // Conversation Buffer
  { method: 'GET', pattern: '/api/conversation-buffer', handler: handleGetBuffer },
  { method: 'DELETE', pattern: '/api/conversation-buffer', handler: handleClearBuffer, requiresAuth: true },

  // Persona Chat (full cognitive graph pipeline - SAME for web and mobile)
  { method: 'DELETE', pattern: '/api/persona_chat', handler: handleClearPersonaChat, requiresAuth: true },
  { method: 'POST', pattern: '/api/cancel-chat', handler: handleCancelChatAlias, requiresAuth: true },

  // Feedback
  { method: 'POST', pattern: '/api/feedback', handler: handleSubmitFeedback, requiresAuth: true },
  { method: 'POST', pattern: '/api/system-error', handler: handleSystemError, requiresAuth: true },

  // Embeddings
  { method: 'GET', pattern: '/api/embeddings', handler: handleGetEmbeddingsConfig },
  { method: 'POST', pattern: '/api/embeddings', handler: handleUpdateEmbeddingsConfig, requiresAuth: true, guard: 'owner' },

  // Agency - Desires
  { method: 'GET', pattern: '/api/agency/desires', handler: handleListDesires, requiresAuth: true },
  { method: 'POST', pattern: '/api/agency/desires', handler: handleCreateDesire, requiresAuth: true },
  { method: 'GET', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)$/, handler: handleGetDesire, requiresAuth: true },
  { method: 'PUT', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)$/, handler: handleUpdateDesire, requiresAuth: true },
  { method: 'DELETE', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)$/, handler: handleDeleteDesire, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/approve$/, handler: handleApproveDesire, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/reject$/, handler: handleRejectDesire, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/reset$/, handler: handleResetDesire, requiresAuth: true },
  { method: 'GET', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/executions$/, handler: handleGetDesireExecutions, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/advance$/, handler: handleAdvanceDesire, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/answer$/, handler: handleAnswerDesireQuestions, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/checkin$/, handler: handleCheckinDesire, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/confirm-complete$/, handler: handleConfirmCompleteDesire, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/execute$/, handler: handleExecuteDesire, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/feedback$/, handler: handleDesireFeedback, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/generate-plan-stream$/, handler: handleGenerateDesirePlanStream, requiresAuth: true },
  { method: 'GET', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/outcome-review-stream$/, handler: handleOutcomeReviewStream },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/ready-to-plan$/, handler: handleReadyToPlanDesire, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/request-revision$/, handler: handleRequestDesireRevision, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/revise$/, handler: handleReviseDesire, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/agency\/desires\/(?<id>[^\/]+)\/run-stream$/, handler: handleRunDesireStream, requiresAuth: true },

  // Addons
  { method: 'GET', pattern: '/api/addons', handler: handleGetAddons },
  { method: 'POST', pattern: '/api/addons/install-stream', handler: handleInstallAddonStream, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/addons/uninstall', handler: handleUninstallAddon, requiresAuth: true, guard: 'owner' },

  // Training
  { method: 'GET', pattern: '/api/training-config', handler: handleGetTrainingConfig, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/training-config', handler: handleUpdateTrainingConfig, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: '/api/training-data', handler: handleGetTrainingData, requiresAuth: true },
  { method: 'POST', pattern: '/api/training-data', handler: handleUpdateTrainingData, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: '/api/tts-queue-stream', handler: handleTtsQueueStream, requiresAuth: true },
  { method: 'POST', pattern: '/api/tts-queue-delivery', handler: handleTtsQueueDelivery, requiresAuth: true },
  { method: 'POST', pattern: '/api/tts-queue-interrupt', handler: handleTtsQueueInterrupt, requiresAuth: true },

  // Profiles
  { method: 'GET', pattern: '/api/profiles/visibility', handler: handleGetProfileVisibility, requiresAuth: true },
  { method: 'POST', pattern: '/api/profiles/visibility', handler: handleSetProfileVisibility, requiresAuth: true },
  { method: 'GET', pattern: '/api/profiles/list', handler: handleListProfiles, requiresAuth: true },

  // Onboarding
  { method: 'POST', pattern: '/api/ingest', handler: handleUploadInboxFile, requiresAuth: true },
  { method: 'GET', pattern: '/api/onboarding/state', handler: handleGetOnboardingState, requiresAuth: true },
  { method: 'POST', pattern: '/api/onboarding/state', handler: handleUpdateOnboardingState, requiresAuth: true },
  { method: 'POST', pattern: '/api/onboarding/skip', handler: handleSkipOnboarding, requiresAuth: true },
  { method: 'POST', pattern: '/api/onboarding/complete', handler: handleCompleteOnboarding, requiresAuth: true },
  { method: 'POST', pattern: '/api/onboarding/extract-persona', handler: handleExtractOnboardingPersona, requiresAuth: true },

  // Chat Settings
  { method: 'GET', pattern: '/api/chat-settings', handler: handleGetChatSettings },
  { method: 'PUT', pattern: '/api/chat-settings', handler: handleUpdateChatSettings, requiresAuth: true },
  { method: 'POST', pattern: '/api/chat-settings', handler: handleApplyChatPreset, requiresAuth: true },

  // Trust
  { method: 'GET', pattern: '/api/trust', handler: handleGetTrust, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/trust', handler: handleSetTrust, requiresAuth: true, guard: 'owner' },

  // Agent Config
  { method: 'GET', pattern: '/api/agent-config', handler: handleGetAgentConfig, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/agent-config', handler: handleSetAgentConfig, requiresAuth: true, guard: 'owner' },

  // Audit Control
  { method: 'GET', pattern: '/api/audit-control', handler: handleGetAuditControl, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/audit-control', handler: handleSetAuditControl, requiresAuth: true, guard: 'owner' },

  // System Status
  { method: 'GET', pattern: '/api/system-status', handler: handleGetSystemStatus },

  // Trust Coupling
  { method: 'GET', pattern: '/api/trust-coupling', handler: handleGetTrustCoupling, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/trust-coupling', handler: handleSetTrustCoupling, requiresAuth: true, guard: 'owner' },

  // Logging Config
  { method: 'GET', pattern: '/api/logging-config', handler: handleGetLoggingConfig },
  { method: 'POST', pattern: '/api/logging-config', handler: handleSetLoggingConfig, requiresAuth: true, guard: 'owner' },

  // Audit
  { method: 'GET', pattern: '/api/audit', handler: handleGetAudit, requiresAuth: true, guard: 'owner' },

  // Sleep Status
  { method: 'GET', pattern: '/api/sleep-status', handler: handleGetSleepStatus },

  // Model Info
  { method: 'GET', pattern: '/api/model-info', handler: handleGetModelInfo },

  // GPU Status
  { method: 'GET', pattern: '/api/gpu-status', handler: handleGetGpuStatus },

  // Monitor
  { method: 'GET', pattern: '/api/monitor', handler: handleGetMonitor, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/monitor/agent-variable', handler: handleSetMonitorAgentVariable, requiresAuth: true, guard: 'owner' },

  // Voice Status
  { method: 'GET', pattern: '/api/voice-status', handler: handleGetVoiceStatus },

  // Approvals

  // Security Policy
  { method: 'GET', pattern: '/api/security/policy', handler: handleGetSecurityPolicy },

  // Runtime Mode
  { method: 'GET', pattern: '/api/runtime/mode', handler: handleGetRuntimeMode, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/runtime/mode', handler: handleSetRuntimeMode, requiresAuth: true, guard: 'owner' },

  // Profile Management
  { method: 'POST', pattern: '/api/profiles/select', handler: handleSelectProfile, requiresAuth: true },
  { method: 'POST', pattern: '/api/profiles/delete', handler: handleDeleteProfile, requiresAuth: true },
  { method: 'POST', pattern: '/api/profiles/create', handler: handleCreateProfile, requiresAuth: true, guard: 'owner' },

  // Recovery Codes
  { method: 'GET', pattern: '/api/recovery-codes', handler: handleGetRecoveryCodes, requiresAuth: true },
  { method: 'POST', pattern: '/api/recovery-codes', handler: handleRegenerateRecoveryCodes, requiresAuth: true },

  // Memory Delete
  { method: 'POST', pattern: '/api/memories/delete', handler: handleDeleteMemory, requiresAuth: true },

  // Memory Validate
  { method: 'POST', pattern: '/api/memories/validate', handler: handleValidateMemory, requiresAuth: true },

  // Trigger Manager
  { method: 'GET', pattern: '/api/trigger-manager', handler: handleGetTriggerManager, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/trigger-manager/control', handler: handleTriggerManagerControl, requiresAuth: true, guard: 'owner' },
  { method: 'PATCH', pattern: '/api/trigger-manager/config', handler: handlePatchTriggerManagerConfig, requiresAuth: true, guard: 'owner' },

  // Agent Catalog
  { method: 'GET', pattern: '/api/agent-catalog', handler: handleGetAgentCatalog, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/agent-catalog/control', handler: handleAgentCatalogControl, requiresAuth: true, guard: 'owner' },

  // Mood Agent
  { method: 'GET', pattern: '/api/mood-settings', handler: handleGetMoodSettings, requiresAuth: true },
  { method: 'PUT', pattern: '/api/mood-settings', handler: handleUpdateMoodSettings, requiresAuth: true },

  // Big Brother Config
  { method: 'GET', pattern: '/api/big-brother-config', handler: handleGetBigBrotherConfig, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/big-brother-config', handler: handleSetBigBrotherConfig, requiresAuth: true, guard: 'owner' },

  // Persona Toggle
  { method: 'GET', pattern: '/api/persona-toggle', handler: handleGetPersonaToggle, requiresAuth: true },
  { method: 'POST', pattern: '/api/persona-toggle', handler: handleSetPersonaToggle, requiresAuth: true },

  // Storage Status
  { method: 'GET', pattern: '/api/storage-status', handler: handleGetStorageStatus, requiresAuth: true },

  // Agency Config
  { method: 'GET', pattern: '/api/agency/config', handler: handleGetAgencyConfig, requiresAuth: true },
  { method: 'PUT', pattern: '/api/agency/config', handler: handleSetAgencyConfig, requiresAuth: true, guard: 'owner' },

  // Activity Ping
  { method: 'POST', pattern: '/api/activity-ping', handler: handleActivityPing, requiresAuth: true },

  // Unified Queue
  { method: 'GET', pattern: '/api/unified-queue', handler: handleGetQueueStatus, requiresAuth: true },
  { method: 'POST', pattern: '/api/unified-queue', handler: handleEnqueueTask, requiresAuth: true },
  { method: 'POST', pattern: '/api/internal/work-coordinator/enqueue', handler: handleSubmitCoordinatorWork, public: true, publicReason: 'runtime service-token authenticated coordinator handoff' },
  { method: 'POST', pattern: '/api/unified-queue/control', handler: handleQueueControl, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/unified-queue/clear', handler: handleClearQueueTasks, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: /^\/api\/unified-queue\/trigger\/(?<agentId>[^\/]+)$/, handler: handleTriggerAgent, requiresAuth: true },
  { method: 'GET', pattern: /^\/api\/unified-queue\/tasks\/(?<id>[^\/]+)\/stream$/, handler: handleQueueTaskStream },
  { method: 'GET', pattern: /^\/api\/unified-queue\/tasks\/(?<id>[^\/]+)$/, handler: handleGetQueueTask, requiresAuth: true },
  { method: 'DELETE', pattern: /^\/api\/unified-queue\/tasks\/(?<id>[^\/]+)$/, handler: handleDeleteQueueTask, requiresAuth: true },
  { method: 'DELETE', pattern: /^\/api\/unified-queue\/executions\/(?<id>[^\/]+)$/, handler: handleCancelQueueExecution, requiresAuth: true },
  { method: 'POST', pattern: /^\/api\/unified-queue\/executions\/(?<id>[^\/]+)$/, handler: handleConfirmQueueCandidate, requiresAuth: true },
  { method: 'GET', pattern: '/api/queue-stream', handler: handleQueueStream, requiresAuth: true },

  // RunPod
  { method: 'GET', pattern: '/api/runpod/config', handler: handleGetRunpodConfig, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/runpod/validate', handler: handleValidateRunpodKey, requiresAuth: true, guard: 'owner' },

  // Semantic Turn Detection
  { method: 'POST', pattern: '/api/semantic-turn', handler: handleSemanticTurn, requiresAuth: true },

  // Training Models
  { method: 'GET', pattern: '/api/training-models', handler: handleGetTrainingModels },

  // Voice Models
  { method: 'GET', pattern: '/api/voice-models', handler: handleGetVoiceModels },

  // Training History
  { method: 'GET', pattern: '/api/training/history', handler: handleGetTrainingHistory, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/training/history', handler: handleReviewTrainingCandidate, requiresAuth: true, guard: 'owner' },

  // Memory Content
  { method: 'GET', pattern: '/api/memory-content', handler: handleGetMemoryContent, requiresAuth: true },
  { method: 'PUT', pattern: '/api/memory-content', handler: handlePutMemoryContent, requiresAuth: true },

  // Persona Archives
  { method: 'GET', pattern: '/api/persona-archives', handler: handleListPersonaArchives, requiresAuth: true },
  { method: 'POST', pattern: '/api/persona-archives', handler: handlePersonaArchiveAction, requiresAuth: true },

  // Psychoanalyzer Config
  { method: 'GET', pattern: '/api/psychoanalyzer-config', handler: handleGetPsychoanalyzerConfig, requiresAuth: true },
  { method: 'POST', pattern: '/api/psychoanalyzer-config', handler: handleSetPsychoanalyzerConfig, requiresAuth: true, guard: 'owner' },

  // Persona Facet
  { method: 'GET', pattern: '/api/persona-facet', handler: handleGetPersonaFacet },
  { method: 'POST', pattern: '/api/persona-facet', handler: handleSetPersonaFacet, requiresAuth: true },

  // Agency Metrics
  { method: 'GET', pattern: '/api/agency/metrics', handler: handleGetAgencyMetrics, requiresAuth: true },

  // Agency Plans
  { method: 'GET', pattern: '/api/agency/plans', handler: handleGetAgencyPlans, requiresAuth: true },
  { method: 'PUT', pattern: '/api/agency/plans', handler: handleUpdateAgencyPlan, requiresAuth: true },

  // Agency Scratchpad
  { method: 'GET', pattern: '/api/agency/scratchpad', handler: handleGetAgencyScratchpad, requiresAuth: true },

  // Cognitive Graphs
  { method: 'GET', pattern: '/api/cognitive-graphs', handler: handleListCognitiveGraphs, requiresAuth: true },
  { method: 'GET', pattern: '/api/cognitive-graph', handler: handleGetCognitiveGraph, requiresAuth: true },
  { method: 'POST', pattern: '/api/cognitive-graph', handler: handleCreateCognitiveGraph, requiresAuth: true },
  { method: 'DELETE', pattern: '/api/cognitive-graph', handler: handleDeleteCognitiveGraph, requiresAuth: true },

  // Graph Execution
  { method: 'GET', pattern: '/api/graph-traces', handler: handleGetGraphTraces, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/execute-graph-stream', handler: handleExecuteGraphStream },

  // Node Schemas
  { method: 'GET', pattern: '/api/node-schemas', handler: handleGetNodeSchemas },

  // Persona Core Manage
  { method: 'GET', pattern: '/api/persona-core-manage', handler: handleGetPersonaCoreManage },
  { method: 'POST', pattern: '/api/persona-core-manage', handler: handleUpdatePersonaCoreManage, requiresAuth: true },

  // Persona Facets Manage
  { method: 'GET', pattern: '/api/persona-facets-manage', handler: handleGetPersonaFacetsManage },
  { method: 'POST', pattern: '/api/persona-facets-manage', handler: handleUpdatePersonaFacetsManage, requiresAuth: true },
  { method: 'GET', pattern: '/api/persona-insights', handler: handleGetPersonaInsights, requiresAuth: true },

  // LLM Backend
  { method: 'GET', pattern: '/api/llm-backend/config', handler: handleGetLlmBackendConfig, requiresAuth: true, guard: 'owner' },
  { method: 'PUT', pattern: '/api/llm-backend/config', handler: handleSetLlmBackendConfig, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: '/api/llm-backend/status', handler: handleGetLlmBackendStatus },
  { method: 'POST', pattern: '/api/llm-backend/ollama', handler: handleOllamaControl, requiresAuth: true, guard: 'owner' },

  // Ollama packages supported LoRAs as normal derived models.
  { method: 'GET', pattern: '/api/ollama/loras', handler: handleGetOllamaLoras, requiresAuth: true },
  { method: 'PUT', pattern: '/api/ollama/loras', handler: handleCreateOllamaLora, requiresAuth: true, guard: 'owner' },

  // LLM Proxy - allows remote clients to use this server's LLM (Ollama or llama.cpp)
  { method: 'POST', pattern: '/api/llm/chat', handler: handleLlmChat, requiresAuth: true },
  // Model Registry - authenticated users can manage their own model preferences
  { method: 'GET', pattern: '/api/model-registry', handler: handleGetModelRegistry, requiresAuth: true },
  { method: 'POST', pattern: '/api/model-registry', handler: handleAssignModelRole, requiresAuth: true },
  { method: 'PUT', pattern: '/api/model-registry', handler: handleUpdateModelSettings, requiresAuth: true },

  // Cloudflare Tunnel
  { method: 'GET', pattern: '/api/cloudflare/status', handler: handleGetCloudflareStatus, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/cloudflare/start', handler: handleCloudflareStart, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/cloudflare/stop', handler: handleCloudflareStop, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/cloudflare/toggle', handler: handleCloudflareToggle, requiresAuth: true, guard: 'owner' },

  // Training
  { method: 'GET', pattern: '/api/training/status', handler: handleGetTrainingStatus, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/training/launch', handler: handleLaunchTraining, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/training/cancel', handler: handleCancelTraining, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: '/api/training/console-logs', handler: handleGetTrainingConsoleLogs, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: '/api/training/running', handler: handleGetTrainingRunning, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: '/api/training/dataset-stats', handler: handleGetTrainingDatasetStats, requiresAuth: true },
  { method: 'GET', pattern: '/api/training/automatic', handler: handleGetAutomaticTraining, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/training/automatic', handler: handleUpdateAutomaticTraining, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: '/api/training/logs', handler: handleGetTrainingLogs, requiresAuth: true, guard: 'owner' },

  // VeraCrypt
  { method: 'GET', pattern: '/api/veracrypt/status', handler: handleGetVeracryptStatus },

  // Training Log File
  { method: 'GET', pattern: '/api/training/log-file', handler: handleGetTrainingLogFile, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: /^\/api\/training\/(?<id>[^\/]+)$/, handler: handleGetTrainingOperation },

  // System GPU Info
  { method: 'GET', pattern: '/api/system/gpu-info', handler: handleGetGpuInfo },

  // Mobile Version
  { method: 'GET', pattern: '/api/mobile/version', handler: handleGetMobileVersion },

  // Profile memory reset (existing route)
  { method: 'POST', pattern: '/api/reset-factory', handler: handleResetFactory, requiresAuth: true, guard: 'owner' },
  { method: 'GET', pattern: '/api/reset-factory', handler: handleResetFactoryGet },

  // Persona Icon (binary image response)
  { method: 'GET', pattern: '/api/persona-icon', handler: handleGetPersonaIcon },

  // Mobile Download (binary APK response)
  { method: 'GET', pattern: '/api/mobile/download', handler: handleGetMobileDownload },


  // Credentials Sync (mobile fetches from desktop server)
  { method: 'GET', pattern: '/api/profile-sync/credentials', handler: handleGetCredentialsSync, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/profile-sync/credentials', handler: handleSaveCredentialsSync, requiresAuth: true, guard: 'owner' },

  // Persona Generator
  { method: 'POST', pattern: '/api/persona/generator/start', handler: handlePersonaGeneratorStart, requiresAuth: true },
  { method: 'GET', pattern: '/api/persona/generator/load', handler: handlePersonaGeneratorLoad, requiresAuth: true },
  { method: 'POST', pattern: '/api/persona/generator/answer', handler: handlePersonaGeneratorAnswer, requiresAuth: true },
  { method: 'POST', pattern: '/api/persona/generator/update-answer', handler: handlePersonaGeneratorUpdateAnswer, requiresAuth: true },
  { method: 'POST', pattern: '/api/persona/generator/finalize', handler: handlePersonaGeneratorFinalize, requiresAuth: true },
  { method: 'POST', pattern: '/api/persona/generator/apply', handler: handlePersonaGeneratorApply, requiresAuth: true },
  { method: 'POST', pattern: '/api/persona/generator/discard', handler: handlePersonaGeneratorDiscard, requiresAuth: true },
  { method: 'POST', pattern: '/api/persona/generator/add-notes', handler: handlePersonaGeneratorAddNotes, requiresAuth: true },
  { method: 'POST', pattern: '/api/persona/generator/reset-persona', handler: handlePersonaGeneratorResetPersona, requiresAuth: true },
  { method: 'POST', pattern: '/api/persona/generator/purge-sessions', handler: handlePersonaGeneratorPurgeSessions, requiresAuth: true },

  // STT (Speech-to-Text)
  { method: 'POST', pattern: '/api/stt', handler: handleStt, requiresAuth: true },

  // TTS (Text-to-Speech)
  { method: 'POST', pattern: '/api/tts', handler: handleTtsGenerate, requiresAuth: true },
  { method: 'GET', pattern: '/api/tts', handler: handleTtsStatus },

  // Response Pipeline
  { method: 'POST', pattern: '/api/response-pipeline', handler: handleResponsePipelineApi, requiresAuth: true },
  { method: 'POST', pattern: '/api/curiosity/questions/skip', handler: handleSkipCuriosityQuestion, requiresAuth: true },

  // Memories All (memory browser)
  { method: 'GET', pattern: '/api/memories_all', handler: handleGetAllMemories, requiresAuth: true },
  { method: 'GET', pattern: '/api/environment-training', handler: handleGetEnvironmentTraining, requiresAuth: true },
  { method: 'POST', pattern: '/api/environment-training/review', handler: handleReviewEnvironmentTraining, requiresAuth: true },

  // Vector Index
  { method: 'GET', pattern: '/api/index', handler: handleGetIndex, requiresAuth: true },
  { method: 'POST', pattern: '/api/index', handler: handleBuildIndex, requiresAuth: true },

  // Voice Samples
  { method: 'GET', pattern: /^\/api\/voice-samples\/(?<sampleId>[^\/]+)$/, handler: handleGetVoiceSample },

  // Profile Path
  { method: 'GET', pattern: '/api/profile-path', handler: handleGetProfilePath, requiresAuth: true },
  { method: 'POST', pattern: '/api/profile-path', handler: handleMigrateProfilePath, requiresAuth: true },
  { method: 'PUT', pattern: '/api/profile-path', handler: handleSwitchProfilePath, requiresAuth: true },
  { method: 'DELETE', pattern: '/api/profile-path', handler: handleResetProfilePath, requiresAuth: true },
  { method: 'POST', pattern: '/api/profile-path/validate', handler: handleValidateProfilePath, requiresAuth: true },
  { method: 'GET', pattern: '/api/profile-path/devices', handler: handleListStorageDevices, requiresAuth: true },

  // Server Update (web/desktop only - git-based updates)
  { method: 'GET', pattern: '/api/server-update', handler: handleGetServerUpdate, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/server-update', handler: handlePostServerUpdate, requiresAuth: true, guard: 'owner' },
  { method: 'POST', pattern: '/api/server-update/restart', handler: handleRestartServer, requiresAuth: true, guard: 'owner' },

  // Remote Server (connect to desktop LLM from mobile/laptop)
  { method: 'GET', pattern: '/api/remote-server/health', handler: handleRemoteServerHealth },
  { method: 'POST', pattern: '/api/remote-server/test', handler: handleRemoteServerTest, requiresAuth: true },
  { method: 'POST', pattern: '/api/remote-server/connect', handler: handleRemoteServerConnect, requiresAuth: true },
  { method: 'DELETE', pattern: '/api/remote-server/disconnect', handler: handleRemoteServerDisconnect, requiresAuth: true },

  // User Guide (unified for web and mobile)
  { method: 'GET', pattern: '/api/user-guide', handler: handleListUserGuide },
  { method: 'GET', pattern: '/api/user-guide/search', handler: handleSearchUserGuide },
  { method: 'GET', pattern: /^\/api\/user-guide\/(?<id>[^\/]+)$/, handler: handleGetUserGuideChapter },
];

// ============================================================================
// Route Matching
// ============================================================================

/**
 * Match a request to a route definition
 */
function matchRoute(method: string, path: string): RouteDefinition | null {
  // Normalize path (remove query string, trailing slash)
  const normalizedPath = path.split('?')[0].replace(/\/$/, '') || '/';

  const candidates = routes.filter(route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    return methods.includes(method);
  });
  // Literal operations (for example tasks/actionable) take precedence over item patterns.
  return candidates.find(route => route.pattern === normalizedPath)
    ?? candidates.find(route => route.pattern instanceof RegExp && route.pattern.test(normalizedPath))
    ?? null;
}

/**
 * Extract path parameters from a path (e.g., /api/tasks/task-123 -> { id: 'task-123' })
 */
function extractPathParams(path: string, pattern: string | RegExp): Record<string, string> {
  const normalizedPath = path.split('?')[0].replace(/\/$/, '') || '/';
  const groups = pattern instanceof RegExp ? pattern.exec(normalizedPath)?.groups : undefined;
  return Object.fromEntries(Object.entries(groups ?? {}).map(([name, value]) => [name, decodeURIComponent(value)]));
}

/**
 * Parse query string from path
 */
function parseQuery(path: string): Record<string, string> {
  const queryString = path.split('?')[1];
  if (!queryString) return {};

  const params: Record<string, string> = {};
  for (const param of queryString.split('&')) {
    const [key, value] = param.split('=');
    if (key) {
      params[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
    }
  }
  return params;
}

// ============================================================================
// Security Guards
// ============================================================================

/**
 * Check if user passes the security guard
 */
function checkGuard(guard: string | undefined, user: UnifiedRequest['user']): boolean {
  if (!guard) return true;

  switch (guard) {
    case 'owner':
      return user.role === 'owner';
    default:
      return false;
  }
}

function isMutatingMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function getHeader(req: UnifiedRequest, name: string): string | undefined {
  const headers = req.headers || {};
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
}

function stripPort(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (normalized.startsWith('[')) {
    return normalized.slice(1, normalized.indexOf(']'));
  }
  return normalized.split(':')[0];
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return true;
  const hostname = stripPort(host);
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function originHost(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
}

function configuredAllowedOrigins(): Set<string> {
  return new Set((process.env.MH_ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean));
}

function requestExposureMode(): 'local' | 'shared' {
  return process.env.MH_EXPOSURE_MODE === 'shared' ? 'shared' : 'local';
}

function checkRequestBoundary(req: UnifiedRequest, route: RouteDefinition): UnifiedResponse | null {
  if (!isMutatingMethod(req.method) || route.public) return null;

  const host = getHeader(req, 'host');
  const origin = getHeader(req, 'origin')?.replace(/\/+$/, '');
  const mode = requestExposureMode();

  if (mode === 'local') {
    if (!isLoopbackHost(host)) {
      return forbiddenResponse('Local mode only accepts loopback host requests');
    }
    if (origin && !isLoopbackHost(originHost(origin))) {
      return forbiddenResponse('Local mode only accepts loopback origin requests');
    }
    return null;
  }

  if (!origin) return null;

  const hostOrigin = host ? `${origin.startsWith('https://') ? 'https' : 'http'}://${host}` : undefined;
  if (hostOrigin && origin === hostOrigin.replace(/\/+$/, '')) return null;
  if (configuredAllowedOrigins().has(origin)) return null;

  return forbiddenResponse('Origin is not allowed for shared mode');
}

// ============================================================================
// Main Router
// ============================================================================

/**
 * Route a request to the appropriate handler
 *
 * This is the main entry point - adapters call this with a UnifiedRequest
 */
export async function routeRequest(req: UnifiedRequest): Promise<UnifiedResponse> {
  // Find matching route
  const route = matchRoute(req.method, req.path);

  if (!route) {
    return notFoundResponse(`Route not found: ${req.method} ${req.path}`);
  }

  const boundaryFailure = checkRequestBoundary(req, route);
  if (boundaryFailure) {
    return boundaryFailure;
  }

  // Mutating routes require authentication by default. Auth bootstrap and
  // external bridge ingestion must opt out explicitly with public/publicReason.
  const requiresAuthentication = route.requiresAuth || (isMutatingMethod(req.method) && !route.public);
  if (requiresAuthentication && !req.user.isAuthenticated) {
    return {
      ...unauthorizedResponse(),
      ...(req.sessionId
        ? {
            cookies: [{
              action: 'delete' as const,
              name: 'mh_session',
              options: { path: '/' },
            }],
          }
        : {}),
    };
  }

  // Check security guard
  if (!checkGuard(route.guard, req.user)) {
    return forbiddenResponse('Insufficient permissions');
  }

  // Extract path params and merge with existing
  const pathParams = extractPathParams(req.path, route.pattern);
  const query = { ...parseQuery(req.path), ...req.query };

  // Create enriched request
  const enrichedReq: UnifiedRequest = {
    ...req,
    params: { ...req.params, ...pathParams },
    query,
  };

  // Execute handler
  try {
    if (req.user.isAuthenticated && req.sessionId) {
      await restoreAuthenticatedSession(req.sessionId, req.user.userId);
    }
    return await route.handler(enrichedReq);
  } catch (error) {
    console.error(`[router] Handler error for ${req.method} ${req.path}:`, error);
    return {
      status: 500,
      error: (error as Error).message || 'Internal server error',
    };
  }
}

/**
 * List all registered routes (for debugging)
 */
export function listRoutes(): Array<{ method: string | string[]; pattern: string }> {
  return routes.map(r => ({
    method: r.method,
    pattern: typeof r.pattern === 'string' ? r.pattern : r.pattern.source,
  }));
}
