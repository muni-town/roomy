import { writeFile, readFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type {
  NodeSavedSession,
  NodeSavedSessionStore,
  NodeSavedState,
  NodeSavedStateStore,
} from '@atproto/oauth-client-node';

/**
 * Add new types for Jazz Workers
 */
export interface JazzWorker {
  publicName: string;
  credentials: JazzAccountCredentials;
  createdAt: number;
}

export type JazzAccountCredentials =
  | {
      type: 'passphrase';
      passphrase: string;
    }
  | {
      type: 'worker';
      accountID: string;
      accountSecret: string;
    };

/**
 * CLI session data that extends OAuth session data
 */
export interface CliSessionData {
  did: string;
  handle?: string;
  // Add discriminator for session type
  sessionType?: 'oauth' | 'jazz-only';
  jazzWorker: JazzWorker;
}

/**
 * Extended session data that combines OAuth and CLI data
 */
export interface ExtendedSessionData extends NodeSavedSession {
  cliData?: CliSessionData;
}

/**
 * File-based implementation of NodeSavedSessionStore
 * Stores OAuth session data (access tokens, refresh tokens, etc.)
 */
export class FileSessionStore implements NodeSavedSessionStore {
  private filePath: string;
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || join(homedir(), '.roomy-cli');
    this.filePath = join(this.configDir, 'oauth-sessions.json');
  }

  async set(sub: string, sessionData: NodeSavedSession): Promise<void> {
    await this.ensureConfigDir();

    let sessions: Record<string, ExtendedSessionData> = {};
    try {
      if (existsSync(this.filePath)) {
        const data = await readFile(this.filePath, 'utf-8');
        sessions = JSON.parse(data);
      }
    } catch {
      // File doesn't exist or is invalid, start with empty object
    }

    // Preserve existing CLI data if updating OAuth session
    const existingSession = sessions[sub];
    const extendedSessionData: ExtendedSessionData = {
      ...sessionData,
      cliData: existingSession?.cliData,
    };

    sessions[sub] = extendedSessionData;
    await writeFile(this.filePath, JSON.stringify(sessions, null, 2), {
      mode: 0o600,
    });
  }

  async get(sub: string): Promise<NodeSavedSession | undefined> {
    try {
      if (!existsSync(this.filePath)) {
        return undefined;
      }

      const data = await readFile(this.filePath, 'utf-8');
      const sessions: Record<string, ExtendedSessionData> = JSON.parse(data);
      return sessions[sub];
    } catch {
      return undefined;
    }
  }

  /**
   * Get CLI session data for a specific DID
   */
  async getCliData(sub: string): Promise<CliSessionData | undefined> {
    try {
      if (!existsSync(this.filePath)) {
        return undefined;
      }

      const data = await readFile(this.filePath, 'utf-8');
      const sessions: Record<string, ExtendedSessionData> = JSON.parse(data);
      return sessions[sub]?.cliData;
    } catch {
      return undefined;
    }
  }

  /**
   * Set CLI session data for a specific DID
   */
  async setCliData(sub: string, cliData: CliSessionData): Promise<void> {
    await this.ensureConfigDir();

    let sessions: Record<string, ExtendedSessionData> = {};
    try {
      if (existsSync(this.filePath)) {
        const data = await readFile(this.filePath, 'utf-8');
        sessions = JSON.parse(data);
      }
    } catch {
      // File doesn't exist or is invalid, start with empty object
    }

    if (sessions[sub]) {
      // OAuth session exists, just add CLI data
      sessions[sub].cliData = cliData;
    } else {
      // For Jazz-only sessions, create a proper structure
      if (cliData.sessionType === 'jazz-only') {
        const sessionData: ExtendedSessionData = {
          ...dummySession,
          cliData,
        };
        sessions[sub] = sessionData;
      } else {
        // Existing fallback for backward compatibility
        (sessions as any)[sub] = { sub, cliData };
      }
    }

    await writeFile(this.filePath, JSON.stringify(sessions, null, 2), {
      mode: 0o600,
    });
  }

  async del(sub: string): Promise<void> {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }

      const data = await readFile(this.filePath, 'utf-8');
      const sessions: Record<string, ExtendedSessionData> = JSON.parse(data);
      delete sessions[sub];

      if (Object.keys(sessions).length === 0) {
        await unlink(this.filePath);
      } else {
        await writeFile(this.filePath, JSON.stringify(sessions, null, 2), {
          mode: 0o600,
        });
      }
    } catch {
      // File doesn't exist, nothing to delete
    }
  }

  /**
   * Get all CLI session data
   */
  async getAllCliData(): Promise<CliSessionData[]> {
    try {
      if (!existsSync(this.filePath)) {
        return [];
      }

      const data = await readFile(this.filePath, 'utf-8');
      const sessions: Record<string, ExtendedSessionData> = JSON.parse(data);

      const cliSessions: CliSessionData[] = [];
      for (const sessionData of Object.values(sessions)) {
        if (sessionData.cliData) {
          cliSessions.push(sessionData.cliData);
        }
      }

      return cliSessions;
    } catch {
      return [];
    }
  }

  private async ensureConfigDir(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
  }
}

/**
 * File-based implementation of NodeSavedStateStore
 * Stores OAuth state data for CSRF prevention
 */
export class FileStateStore implements NodeSavedStateStore {
  private filePath: string;
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || join(homedir(), '.roomy-cli');
    this.filePath = join(this.configDir, 'oauth-states.json');
  }

  async set(key: string, internalState: NodeSavedState): Promise<void> {
    await this.ensureConfigDir();

    let states: Record<string, NodeSavedState & { timestamp: number }> = {};
    try {
      if (existsSync(this.filePath)) {
        const data = await readFile(this.filePath, 'utf-8');
        states = JSON.parse(data);
      }
    } catch {
      // File doesn't exist or is invalid, start with empty object
    }

    // Clean up expired states (older than 1 hour)
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    for (const [stateKey, stateData] of Object.entries(states)) {
      if (now - stateData.timestamp > oneHour) {
        delete states[stateKey];
      }
    }

    states[key] = { ...internalState, timestamp: now };
    await writeFile(this.filePath, JSON.stringify(states, null, 2), {
      mode: 0o600,
    });
  }

  async get(key: string): Promise<NodeSavedState | undefined> {
    try {
      if (!existsSync(this.filePath)) {
        return undefined;
      }

      const data = await readFile(this.filePath, 'utf-8');
      const states: Record<string, NodeSavedState & { timestamp: number }> =
        JSON.parse(data);
      const stateData = states[key];

      if (!stateData) {
        return undefined;
      }

      // Check if state has expired (older than 1 hour)
      const now = Date.now();
      const oneHour = 60 * 60 * 1000;
      if (now - stateData.timestamp > oneHour) {
        await this.del(key);
        return undefined;
      }

      // Remove timestamp before returning
      const { timestamp, ...state } = stateData;
      return state;
    } catch {
      return undefined;
    }
  }

  async del(key: string): Promise<void> {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }

      const data = await readFile(this.filePath, 'utf-8');
      const states: Record<string, NodeSavedState & { timestamp: number }> =
        JSON.parse(data);
      delete states[key];

      if (Object.keys(states).length === 0) {
        await unlink(this.filePath);
      } else {
        await writeFile(this.filePath, JSON.stringify(states, null, 2), {
          mode: 0o600,
        });
      }
    } catch {
      // File doesn't exist, nothing to delete
    }
  }

  private async ensureConfigDir(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
  }
}

/**
 * Simple file-based runtime lock implementation
 * For single-instance CLI usage, this provides basic locking
 */
export class FileRuntimeLock {
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || join(homedir(), '.roomy-cli');
  }

  async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const lockFile = join(this.configDir, `lock-${key}.json`);
    const lockData = {
      timestamp: Date.now(),
      pid: process.pid,
    };

    // Check for existing lock
    if (existsSync(lockFile)) {
      try {
        const existingLock = JSON.parse(await readFile(lockFile, 'utf-8'));
        const lockAge = Date.now() - existingLock.timestamp;

        // If lock is older than 45 seconds, consider it stale
        if (lockAge < 45000) {
          throw new Error(`Lock already exists for key: ${key}`);
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('Lock already exists')
        ) {
          throw error;
        }
        // JSON parse error, proceed to create new lock
      }
    }

    // Create lock
    await this.ensureConfigDir();
    await writeFile(lockFile, JSON.stringify(lockData, null, 2));

    try {
      return await fn();
    } finally {
      // Release lock
      try {
        await unlink(lockFile);
      } catch {
        // Lock file might have been cleaned up already
      }
    }
  }

  private async ensureConfigDir(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
  }
}

/**
 * Separate store for Jazz Server Worker credentials
 * Keeps sensitive account secrets separate from OAuth sessions
 */
export class JazzCredentialsStore {
  private filePath: string;
  private configDir: string;

  constructor(configDir?: string) {
    this.configDir = configDir || join(homedir(), '.roomy-cli');
    this.filePath = join(this.configDir, 'jazz-credentials.json');
  }

  async setWorker(accountID: string, worker: JazzWorker): Promise<void> {
    await this.ensureConfigDir();

    let workers: Record<string, JazzWorker> = {};
    try {
      if (existsSync(this.filePath)) {
        const data = await readFile(this.filePath, 'utf-8');
        workers = JSON.parse(data);
      }
    } catch {
      // File doesn't exist or is invalid, start with empty object
    }

    workers[accountID] = worker;
    await writeFile(this.filePath, JSON.stringify(workers, null, 2), {
      mode: 0o600,
    });
  }

  async getWorker(accountIDOrHandle: string): Promise<JazzWorker | undefined> {
    try {
      if (!existsSync(this.filePath)) {
        return undefined;
      }

      const data = await readFile(this.filePath, 'utf-8');
      const workers: Record<string, JazzWorker> = JSON.parse(data);

      if (accountIDOrHandle.startsWith('co_')) {
        let accountId = accountIDOrHandle;
        return workers[accountId];
      } else
        return Object.values(workers).find(
          (w: JazzWorker) => w.publicName === accountIDOrHandle
        );
    } catch {
      return undefined;
    }
  }

  async listWorkers(): Promise<JazzWorker[]> {
    try {
      if (!existsSync(this.filePath)) {
        return [];
      }

      const data = await readFile(this.filePath, 'utf-8');
      const workers: Record<string, JazzWorker> = JSON.parse(data);

      return Object.values(workers);
    } catch {
      return [];
    }
  }

  async deleteWorker(accountID: string): Promise<void> {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }

      const data = await readFile(this.filePath, 'utf-8');
      const workers: Record<string, JazzWorker> = JSON.parse(data);
      delete workers[accountID];

      if (Object.keys(workers).length === 0) {
        await unlink(this.filePath);
      } else {
        await writeFile(this.filePath, JSON.stringify(workers, null, 2), {
          mode: 0o600,
        });
      }
    } catch {
      // File doesn't exist, nothing to delete
    }
  }

  private async ensureConfigDir(): Promise<void> {
    if (!existsSync(this.configDir)) {
      await mkdir(this.configDir, { recursive: true });
    }
  }
}

const dummySession: NodeSavedSession = {
  dpopJwk: {
    kty: 'EC',
    crv: 'P-256',
    x: '123',
    y: '456',
  },
  tokenSet: {
    access_token: '',
    refresh_token: '',
    iss: '',
    sub: 'did:plc:123',
    aud: '',
    scope: 'atproto',
    token_type: 'DPoP',
  },
};
