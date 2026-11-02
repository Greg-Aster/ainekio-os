import { writable, derived } from 'svelte/store';
import {
  GRAPH_EDITOR_WORKSPACE,
  graphEditorLocation,
  isGraphEditorLocation,
} from '../lib/client/flow-editor/graph-editor-location';

export const navigationItems = [
  { id: 'chat', label: 'Chat', icon: '💬', description: 'Conversation interface' },
  { id: 'dashboard', label: 'Dashboard', icon: '📊', description: 'System overview' },
  { id: 'projects', label: 'Projects', icon: '📁', description: 'Task graph & projects' },
  { id: 'agency', label: 'Agency', icon: '🎯', description: 'Desires and Active Operator' },
  { id: 'persona', label: 'Persona', icon: '👤', description: 'Identity & personality' },
  { id: 'voice', label: 'Voice', icon: '🎤', description: 'Audio & training' },
  { id: 'training', label: 'AI Training', icon: '🧠', description: 'LoRA adapters' },
  { id: 'terminal', label: 'Terminal', icon: '⌨', description: 'Shells & provider sessions' },
  { id: 'system', label: 'System', icon: '⚙️', description: 'Settings & tools' },
];

// Views that shouldn't be restored (trigger expensive operations on mount)
const HEAVY_VIEWS = ['training'];

function restoredView(value: string | null, defaultValue: string): string {
  return value && navigationItems.some(item => item.id === value) && !HEAVY_VIEWS.includes(value)
    ? value : defaultValue;
}

// URL hash-based navigation persistence - most reliable across dev server reloads
function createNavigationStore(defaultValue: string) {
  const globalKey = '__MH_ACTIVE_VIEW_STORE__';

  // Reuse existing store during HMR
  if (typeof window !== 'undefined' && (window as any)[globalKey]) {
    return (window as any)[globalKey];
  }

  // Priority: URL hash > localStorage > default
  const getInitialValue = (): string => {
    if (typeof window === 'undefined') return defaultValue;

    const view = new URLSearchParams(window.location.hash.slice(1)).get('view');
    if (view !== null) return restoredView(view, defaultValue);

    try {
      return restoredView(localStorage.getItem('mh_active_view'), defaultValue);
    } catch {}

    return defaultValue;
  };

  const store = writable<string>(getInitialValue());

  if (typeof window !== 'undefined') {
    // Sync store changes to URL hash and localStorage
    store.subscribe(value => {
      // Update URL hash without triggering navigation
      const newHash = `view=${value}`;
      if (window.location.hash !== `#${newHash}`) {
        history.replaceState(null, '', `#${newHash}`);
      }
      // Also persist to localStorage as backup
      try {
        localStorage.setItem('mh_active_view', value);
      } catch {}
    });

    // Listen for browser back/forward navigation
    window.addEventListener('hashchange', () => {
      const view = new URLSearchParams(window.location.hash.slice(1)).get('view');
      store.set(restoredView(view, defaultValue));
    });

    // Cache store for HMR
    (window as any)[globalKey] = store;
  }

  return store;
}

// Navigation store with URL hash persistence - survives dev server reloads
export const activeView = createNavigationStore('chat');

export type DashboardSection = 'overview' | 'tasks' | 'approvals' | 'sleep' | 'agent-catalog' | 'trigger-manager';
export type SystemSection = 'chat' | 'settings' | 'backend' | 'security' | 'network' | 'storage' | 'addons' | 'agent-catalog' | 'trigger-manager';

export type AgencySection = 'desires' | 'operator';
export const agencySection = writable<AgencySection>('desires');

export const dashboardSection = writable<DashboardSection>('overview');
export const systemSection = writable<SystemSection>('settings');

export function openTriggerManagerDashboard(): void {
  dashboardSection.set('trigger-manager');
  activeView.set('dashboard');
}

export function openTriggerManagerSettings(): void {
  systemSection.set('trigger-manager');
  activeView.set('system');
}

export function openAgentCatalogDashboard(): void {
  dashboardSection.set('agent-catalog');
  activeView.set('dashboard');
}

export function openAgentCatalogSettings(): void {
  systemSection.set('agent-catalog');
  activeView.set('system');
}

// ChatLayout publishes status after AuthGate mounts the authenticated app.
export const statusStore = writable<any>(null);
export const statusRefreshTrigger = writable<number>(0); // Increment to trigger refresh

// Derived persona name from status store (for chat cards)
export const personaNameStore = derived(
  statusStore,
  ($status) => $status?.identity?.name || 'MetaHuman'
);

// AuthGate publishes the verified session; mounted components consume it.
export interface CurrentUser {
  id: string;
  username: string;
  role: 'owner' | 'standard' | 'guest' | 'anonymous';
  metadata?: {
    displayName?: string;
    sourceProfile?: string;
    activeProfile?: string;
  };
}
export const currentUserStore = writable<CurrentUser | null>(null);
export const userDisplayNameStore = derived(currentUserStore, user =>
  user?.role === 'anonymous' && user.metadata?.sourceProfile
    ? `Guest: ${user.metadata.sourceProfile}`
    : user?.metadata?.displayName || user?.username || 'Anonymous'
);

// YOLO mode store - shared between components
export const yoloModeStore = writable<boolean>(false);

function createNodeEditorModeStore() {
  const globalKey = '__MH_NODE_EDITOR_MODE_STORE__';

  if (typeof window !== 'undefined' && (window as any)[globalKey]) {
    return (window as any)[globalKey];
  }

  const store = writable<boolean>(
    typeof window !== 'undefined' && isGraphEditorLocation(window.location.href),
  );

  if (typeof window !== 'undefined') {
    let syncingFromHistory = false;

    store.subscribe(enabled => {
      if (syncingFromHistory) return;
      const nextUrl = graphEditorLocation(window.location.href, enabled);
      if (nextUrl !== window.location.href) {
        window.history.replaceState(window.history.state, '', nextUrl);
      }
    });

    window.addEventListener('popstate', () => {
      syncingFromHistory = true;
      store.set(isGraphEditorLocation(window.location.href));
      syncingFromHistory = false;
    });

    (window as any)[globalKey] = store;
  }

  return store;
}

// The editor workspace is URL-scoped so separate tabs can independently show Chat and Graph Editor.
export const nodeEditorMode = createNodeEditorModeStore();

export function graphEditorHref(): string {
  if (typeof window === 'undefined') return `?workspace=${GRAPH_EDITOR_WORKSPACE}`;
  return graphEditorLocation(window.location.href, true);
}

// Right sidebar open state - shared between ChatLayout and RightSidebar
// Used to pause polling in ServerStatus when sidebar is collapsed
const savedRightSidebar = typeof localStorage !== 'undefined'
  ? localStorage.getItem('rightSidebarOpen') === 'true'
  : false;
export const rightSidebarOpen = writable<boolean>(savedRightSidebar);

// Auto-persist rightSidebarOpen to localStorage
if (typeof localStorage !== 'undefined') {
  let rightSidebarPreferenceReady = false;
  rightSidebarOpen.subscribe(open => {
    if (!rightSidebarPreferenceReady) {
      rightSidebarPreferenceReady = true;
      return;
    }
    try {
      localStorage.setItem('rightSidebarOpen', String(open));
    } catch {}
  });
}

// Load YOLO mode from localStorage on init
if (typeof localStorage !== 'undefined') {
  try {
    const prefs = localStorage.getItem('chatPrefs');
    if (prefs) {
      const parsed = JSON.parse(prefs);
      if (typeof parsed.yoloMode === 'boolean') {
        yoloModeStore.set(parsed.yoloMode);
      }
    }
  } catch {}
}
