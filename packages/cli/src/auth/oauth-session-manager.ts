import { join } from 'path';
import { homedir } from 'os';
import type {
  NodeSavedSession,
  OAuthSession,
} from '@atproto/oauth-client-node';
import { RoomyOAuthClient } from './oauth-client.js';
import {
  FileSessionStore,
  type CliSessionData,
  JazzCredentialsStore,
  type JazzWorker,
} from './stores.js';
import { Agent } from '@atproto/api';
import { lexicons } from '../atproto/lexicons.js';

/**
 * Enhanced session manager that works with NodeOAuthClient
 * Manages both OAuth sessions and Jazz passphrases using unified FileSessionStore
 */
export class OAuthSessionManager {
  private configDir: string;
  private oauthClient: RoomyOAuthClient;
  private sessionStore: FileSessionStore;
  private jazzCredentialsStore: JazzCredentialsStore;
  private agent: Agent | null = null;

  constructor() {
    this.configDir = join(homedir(), '.roomy-cli');
    this.oauthClient = new RoomyOAuthClient();
    this.sessionStore = new FileSessionStore(this.configDir);
    this.jazzCredentialsStore = new JazzCredentialsStore(this.configDir);
  }

  async login(handle: string): Promise<CliSessionData> {
    console.log(`🔐 Starting OAuth login for ${handle}...`);

    // Start OAuth flow
    const oauthSession = await this.oauthClient.authorize(handle);
    this.setAgent(oauthSession);

    console.log('✅ OAuth authorization complete');

    // Get Jazz passphrase from keyserver
    console.log('🎵 Getting Jazz credentials...');
    const passphrase = await this.getJazzPassphrase();

    const cliSessionData: CliSessionData = {
      did: oauthSession.sub,
      handle,
      sessionType: 'oauth',
      jazzWorker: {
        createdAt: Date.now(),
        publicName: handle,
        credentials: {
          type: 'passphrase',
          passphrase,
        },
      },
    };

    // Save CLI session data to the unified session store
    // OAuth session is already saved by the OAuth client
    await this.sessionStore.setCliData(oauthSession.sub, cliSessionData);
    console.log(`✅ Login complete for ${handle}`);

    return cliSessionData;
  }

  async loadSession(): Promise<CliSessionData | null> {
    try {
      // Get all CLI sessions to find the most recent one
      // In practice, there should typically be only one active session
      const allSessions = await this.sessionStore.getAllCliData();

      if (allSessions.length === 0) {
        return null;
      }

      // Return the first (and typically only) session
      // In the future, we could implement last-used logic here
      // For Jazz-only sessions, we need to reload the worker data
      // since it's stored separately for security
      const session = allSessions[0];
      if (!session) return null;

      const freshWorker = await this.jazzCredentialsStore.getWorker(
        session.jazzWorker.credentials.type === 'worker'
          ? session.jazzWorker.credentials.accountID
          : session.jazzWorker.publicName
      );
      if (freshWorker) {
        session.jazzWorker = freshWorker;
      }

      return session;
    } catch (error) {
      console.warn('⚠️  Failed to load session, please log in again');
      return null;
    }
  }

  /**
   * Get the current session with both OAuth and CLI data
   */
  async getCurrentSession(): Promise<{
    oauth?: NodeSavedSession;
    cli: CliSessionData;
  } | null> {
    const cliSession = await this.loadSession();
    if (!cliSession) return null;

    // For Jazz-only sessions, there's no OAuth session
    if (cliSession.sessionType === 'jazz-only') {
      return {
        cli: cliSession,
      };
    }

    const oauthSession = await this.sessionStore.get(cliSession.did);
    if (!oauthSession) return null;

    return {
      oauth: oauthSession,
      cli: cliSession,
    };
  }

  async clearSession(): Promise<void> {
    try {
      // Load current session to get DID for OAuth cleanup
      const session = await this.loadSession();
      if (session?.did) {
        // Clean up both OAuth and CLI session data
        await this.sessionStore.del(session.did);
        console.log('🗑️  Session cleared');
      } else {
        console.log('⚠️  No active session found');
      }
    } catch (error) {
      console.error('❌ Failed to clear session:', error);
      throw error;
    }
  }

  /**
   * Get Jazz passphrase from the Roomy keyserver
   */
  private async getJazzPassphrase(): Promise<string> {
    try {
      let passphrase: string | null = null;

      let agent = await this.getAgent();

      const resp = await agent.call(
        'chat.roomy.v1.passphrase',
        undefined,
        undefined,
        {
          headers: {
            'atproto-proxy':
              'did:web:jazz.keyserver.roomy.chat#roomy_keyserver',
          },
        }
      );

      passphrase = resp.data;

      if (!passphrase) {
        throw new Error('No passphrase found');
      }
      return passphrase;
    } catch (error) {
      console.error('Failed to get Jazz passphrase:', error);
      throw new Error('Could not retrieve Jazz credentials');
    }
  }

  /**
   * Get a fresh OAuth agent for making authenticated requests
   */
  async getAgent(): Promise<Agent> {
    if (this.agent) {
      return this.agent;
    }

    const cliSession = await this.loadSession();
    if (!cliSession?.did) {
      throw new Error('No valid session found');
    }

    // The OAuth client will handle token refresh automatically
    const session = await this.oauthClient.restore(cliSession.did);
    this.agent = new Agent(session);
    lexicons.forEach((l) => this.agent!.lex.add(l));
    return this.agent;
  }

  setAgent(session: OAuthSession) {
    this.agent = new Agent(session);
    lexicons.forEach((l) => this.agent!.lex.add(l));
  }

  /**
   * Get the session store instance for direct access if needed
   */
  getSessionStore(): FileSessionStore {
    return this.sessionStore;
  }

  /**
   * Add a Jazz Server Worker to the session manager
   */
  async addJazzWorker(
    accountID: string,
    publicName: string,
    accountSecret: string
  ): Promise<CliSessionData> {
    const jazzWorker: JazzWorker = {
      publicName,
      credentials: {
        type: 'worker',
        accountID,
        accountSecret,
      },
      createdAt: Date.now(),
    };

    // Store the worker credentials separately
    await this.jazzCredentialsStore.setWorker(accountID, jazzWorker);

    // Create CLI session data for the Jazz worker
    const cliSessionData: CliSessionData = {
      did: `jazz:${accountID}`, // Use a special DID format for Jazz workers
      handle: publicName,
      sessionType: 'jazz-only',
      jazzWorker,
    };

    // Save to the main session store
    await this.sessionStore.setCliData(cliSessionData.did, cliSessionData);

    console.log(`✅ Added Jazz Server Worker: ${publicName} (${accountID})`);
    return cliSessionData;
  }

  /**
   * List all Jazz Server Workers
   */
  async listJazzWorkers(): Promise<JazzWorker[]> {
    return await this.jazzCredentialsStore.listWorkers();
  }

  /**
   * Get Jazz credentials for a specific worker
   */
  async getJazzCredentials(
    accountIDOrHandle: string
  ): Promise<JazzWorker | undefined> {
    const worker = await this.jazzCredentialsStore.getWorker(accountIDOrHandle);
    return worker;
  }

  /**
   * Remove a Jazz Server Worker
   */
  async removeJazzWorker(accountID: string): Promise<void> {
    // Remove from both stores
    await this.jazzCredentialsStore.deleteWorker(accountID);
    await this.sessionStore.del(`jazz:${accountID}`);
    console.log(`🗑️  Removed Jazz Server Worker: ${accountID}`);
  }
}
