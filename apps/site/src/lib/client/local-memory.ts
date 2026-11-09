/**
 * Browser Settings Storage
 *
 * IndexedDB settings used by sync preferences. The existing database schema
 * and migrations remain intact to preserve previously stored browser data.
 */

import { openDB, unwrap, type DBSchema, type IDBPDatabase } from 'idb';

// Version 5 schema, including legacy stores retained for existing browser data.
interface LocalMemoryDB extends DBSchema {
  memories: {
    key: string;  // UUID
    value: {
      id: string;
      type: string;
      content: string;
      timestamp: string;
      metadata: Record<string, any>;
      synced: boolean;
      syncedAt?: string;
      localModifiedAt: string;
      serverModifiedAt?: string;
      deleted?: boolean;
    };
    indexes: {
      'by-timestamp': string;
      'by-type': string;
    };
  };
  persona: {
    key: string;
    value: {
      key: string;  // 'core', 'relationships', 'routines', 'decision-rules'
      data: Record<string, any>;
      syncedAt?: string;
      localModifiedAt: string;
    };
  };
  tasks: {
    key: string;
    value: {
      id: string;
      title: string;
      status: 'pending' | 'active' | 'completed' | 'cancelled';
      priority: number;
      tags: string[];
      createdAt: string;
      updatedAt: string;
      synced: boolean;
      deleted?: boolean;
    };
    indexes: {
      'by-status': string;
    };
  };
  settings: {
    key: string;
    value: {
      key: string;
      value: any;
      updatedAt: string;
    };
  };
  syncMeta: {
    key: string;
    value: {
      key: string;  // 'lastSync', 'serverUrl', etc.
      value: string;
      updatedAt: string;
    };
  };
  // Local user accounts for offline authentication
  users: {
    key: string;  // username
    value: {
      username: string;
      displayName: string;
      passwordHash: string;  // SHA-256 hash for local validation
      profileType: 'local' | 'server';  // Where profile data lives
      profilePath?: string;  // Filesystem path for local profiles
      encrypted: boolean;
      encryptionType?: 'none' | 'aes256';
      serverUrl?: string;  // Which server this user syncs with
      createdAt: string;
      lastLoginAt?: string;
      syncedAt?: string;  // Last sync with server
      pendingVerification?: boolean;  // True if credentials haven't been verified with server
      verificationFailed?: boolean;   // True if server rejected the credentials
    };
    indexes: {
      'by-profileType': string;
    };
  };
}

const DB_NAME = 'metahuman-local';
const DB_VERSION = 5;  // Removes invalid boolean-key indexes and obsolete dialogue buffers.

let dbInstance: IDBPDatabase<LocalMemoryDB> | null = null;

/**
 * Initialize and get the database instance
 */
async function getDB(): Promise<IDBPDatabase<LocalMemoryDB>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<LocalMemoryDB>(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      // Memories store
      if (!db.objectStoreNames.contains('memories')) {
        const memoryStore = db.createObjectStore('memories', { keyPath: 'id' });
        memoryStore.createIndex('by-timestamp', 'timestamp');
        memoryStore.createIndex('by-type', 'type');
      }

      // Persona store
      if (!db.objectStoreNames.contains('persona')) {
        db.createObjectStore('persona', { keyPath: 'key' });
      }

      // Tasks store
      if (!db.objectStoreNames.contains('tasks')) {
        const taskStore = db.createObjectStore('tasks', { keyPath: 'id' });
        taskStore.createIndex('by-status', 'status');
      }

      // Settings store
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }

      // Sync metadata store
      if (!db.objectStoreNames.contains('syncMeta')) {
        db.createObjectStore('syncMeta', { keyPath: 'key' });
      }

      // Users store for local authentication
      if (!db.objectStoreNames.contains('users')) {
        const userStore = db.createObjectStore('users', { keyPath: 'username' });
        userStore.createIndex('by-profileType', 'profileType');
      }

      // Dialogue history is owned by the four server-side graph buffers. Drop
      // the old IndexedDB copy so it cannot resurface as a competing authority.
      const nativeDb = unwrap(db);
      if (nativeDb.objectStoreNames.contains('conversationBuffers')) {
        nativeDb.deleteObjectStore('conversationBuffers');
      }

      // IndexedDB keys cannot be booleans. Version 5 removes the old boolean
      // indexes and uses the canonical boolean fields through bounded scans.
      if (oldVersion < 5) {
        const nativeTransaction = unwrap(transaction);
        if (nativeDb.objectStoreNames.contains('memories')) {
          const memoryStore = nativeTransaction.objectStore('memories');
          if (memoryStore.indexNames.contains('by-synced')) {
            memoryStore.deleteIndex('by-synced');
          }
          if (memoryStore.indexNames.contains('by-deleted')) {
            memoryStore.deleteIndex('by-deleted');
          }
        }
        if (nativeDb.objectStoreNames.contains('tasks')) {
          const taskStore = nativeTransaction.objectStore('tasks');
          if (taskStore.indexNames.contains('by-synced')) {
            taskStore.deleteIndex('by-synced');
          }
        }
      }
    },
  });

  return dbInstance;
}

// ============ Settings Operations ============

/**
 * Get a setting value
 */
export async function getSetting<T>(key: string, defaultValue: T): Promise<T> {
  const db = await getDB();
  const setting = await db.get('settings', key);
  return setting?.value ?? defaultValue;
}

/**
 * Set a setting value
 */
export async function setSetting(key: string, value: any): Promise<void> {
  const db = await getDB();
  await db.put('settings', {
    key,
    value,
    updatedAt: new Date().toISOString(),
  });
}
