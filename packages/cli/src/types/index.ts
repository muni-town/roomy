export interface SessionData {
  did: string;
  accessToken: string;
  refreshToken: string;
  handle: string;
  expiresAt: string;
  passphrase?: string;
}

export interface OAuthConfig {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: [string, ...string[]];
  scope: string;
  handleResolver: string;
  token_endpoint_auth_method: 'none' | 'client_secret_basic' | 'client_secret_post';
  grant_types: ['authorization_code', 'refresh_token'];
  response_types: ['code'];
}

export interface MessageOptions {
  threadId?: string;
  replyTo?: string;
  embeds?: Array<{ type: 'imageUrl'; url: string }>;
}