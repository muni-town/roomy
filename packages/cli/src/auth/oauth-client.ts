import {
  NodeOAuthClient,
  OAuthSession,
  type RuntimeLock,
} from '@atproto/oauth-client-node';
import express from 'express';
import open from 'open';
import { createServer } from 'http';
import { join } from 'path';
import { homedir } from 'os';
import type { OAuthConfig } from '../types/index.js';
import { FileSessionStore, FileStateStore, FileRuntimeLock } from './stores.js';
import { AtprotoHandleResolverNode } from '@atproto-labs/handle-resolver-node';

export class RoomyOAuthClient {
  private client: NodeOAuthClient;
  private config: OAuthConfig;
  private callbackServer?: ReturnType<typeof createServer>;

  constructor() {
    // Use localhost client_id with query parameters as per AT Protocol development guidelines
    const redirectUri = 'http://127.0.0.1:8080/callback';
    const scope = 'atproto transition:generic transition:chat.bsky';

    this.config = {
      client_id: `http://localhost/?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}`,
      client_name: 'Roomy CLI',
      client_uri: 'https://roomy.space',
      redirect_uris: [redirectUri],
      scope,
      handleResolver: 'https://resolver.roomy.chat',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    };

    // Set up OAuth storage directory
    const oauthDir = join(homedir(), '.roomy-cli');

    // Create store instances according to AT Protocol requirements
    const sessionStore = new FileSessionStore(oauthDir);
    const stateStore = new FileStateStore(oauthDir);

    // Create runtime lock for preventing concurrent token refreshes
    const fileRuntimeLock = new FileRuntimeLock(oauthDir);
    const requestLock: RuntimeLock = async (key, fn) => {
      return await fileRuntimeLock.lock(key, () => Promise.resolve(fn()));
    };

    this.client = new NodeOAuthClient({
      clientMetadata: this.config,
      handleResolver: this.config.handleResolver,
      sessionStore,
      stateStore,
      requestLock,
    });
  }

  async getHandleResolver() {
    return new AtprotoHandleResolverNode({
      fetch: fetch,
      // fallbackNameservers: ['https://resolver.roomy.chat']
    });
  }

  async authorize(handle: string): Promise<OAuthSession> {
    return new Promise((resolve, reject) => {
      const app = express();

      // Start callback server on port 8080
      this.callbackServer = app.listen(8080, () => {
        console.log('🔐 Starting OAuth authorization...');
      });

      // Handle OAuth callback
      app.get('/callback', async (req, res) => {
        try {
          const searchParams = new URLSearchParams(req.url?.split('?')[1]);
          console.log('searchParams', searchParams);
          const result = await this.client.callback(searchParams);

          console.log('client', this.client);

          res.send(`
            <html>
              <body>
                <h1>✅ Authorization successful!</h1>
                <p>You can now close this window and return to the CLI.</p>
                <script>window.close();</script>
              </body>
            </html>
          `);

          this.callbackServer?.close();
          resolve(result.session);
        } catch (error) {
          res.status(400).send(`
            <html>
              <body>
                <h1>❌ Authorization failed</h1>
                <p>Error: ${(error as Error).message}</p>
              </body>
            </html>
          `);
          this.callbackServer?.close();
          reject(error);
        }
      });

      // Start authorization flow
      this.client
        .authorize(handle, { scope: this.config.scope })
        .then((url) => {
          console.log(`🌐 Opening browser for authorization: ${handle}`);
          open(url.toString());
        })
        .catch(reject);
    });
  }

  async restore(did: string) {
    return await this.client.restore(did);
  }
}
