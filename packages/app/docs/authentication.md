# Authentication

*Note: This documentation page is LLM-generated and needs to be reviewed and edited.*

This document describes the authentication and authorization system used in the Roomy application, which integrates with the AT Protocol (Bluesky) for decentralized identity management.

## Overview

Roomy uses the AT Protocol for authentication, providing users with decentralized identity management through Bluesky. The authentication system combines OAuth-based login with local account management through the Jazz framework.

See also [AT Protocol OAuth Documentation](https://atproto.com/specs/oauth).

## AT Protocol Integration

### OAuth Flow

Roomy uses `'@atproto/oauth-client-browser'` to handle the OAuth flow. The client is initialized in `src/lib/atproto.svelte.ts`.

```ts
// simplified non-Tauri version
let clientMetadata: OAuthClientMetadataInput;

// The `clientMetadata` is fetched from the `/oauth-client.json` file.
const resp = await fetch(
  `/oauth-client.json`,
  {
    headers: [["accept", "application/json"]],
  },
);
clientMetadata = await resp.json();

// Build the oauth client
oauth = new BrowserOAuthClient({
  responseMode: "query",
  handleResolver: "https://resolver.roomy.chat",
  clientMetadata,
});
```

See `app/static/oauth-client.json` for the actual client metadata.

The `handleResolver` is used to resolve the user's handle from the AT Protocol.

The `responseMode` is set to `"query"` to handle the OAuth callback.

### Authentication Process

#### 1. User Initiation

In `src/lib/user.svelte.ts` the `loginWithHandle` function is used to initiate the login process.
```typescript
  /** Login a user using their handle, replacing the existing session if any. Tauri specific code omitted here.*/
  async loginWithHandle(handle: string) {
    localStorage.setItem("redirectAfterAuth", window.location.pathname);
    const url = await atproto.oauth.authorize(handle, {
      scope: atproto.scope,
    });

    window.location.href = url.href;

    // Protect against browser's back-forward cache
    await new Promise<never>((_resolve, reject) => {
      setTimeout(
        reject,
        10000,
        new Error("User navigated back from the authorization page"),
      );
    });
  },
```

For local development ATProto [allows metadata fields to be specified in the client id using URL query parameters](https://atproto.com/specs/oauth#localhost-client-development). This can be seen when the user is redirected to a URL such as: `https://bsky.social/oauth/authorize?client_id=http%3A%2F%2Flocalhost%3Fredirect_uri%3Dhttp%253A%252F%252F127.0.0.1%253A5173%252Foauth%252Fcallback%26scope%3Datproto%2520transition%253Ageneric%2520transition%253Achat.bsky&request_uri=urn%3Aietf%3Aparams%3Aoauth%3Arequest_uri%3Areq-{PAR reference token}]`

Where the URL-decoded Client ID is: `http://localhost` with the following query params:

Redirect URI: `http://127.0.0.1:5173/oauth/callback`

Scope: `atproto transition:generic transition:chat.bsky`

The Request URI is: `urn:ietf:params:oauth:request_uri:req-{PAR reference token}`.

The `PAR reference token` is from the response from a [Pushed Authorization Request](https://atproto.com/specs/oauth#pushed-authorization-requests-par) made by the ATProto OAuth library.

#### 2. OAuth Callback

See `src/routes/(internal)/oauth/callback/+page.svelte` for how the OAuth callback is handled on web. The essential code is:

```typescript
// Handle OAuth callback
await atproto.init();
const searchParams = new URL(globalThis.location.href).searchParams;

atproto.oauth
  .callback(searchParams)
  .then((result) => {
    user.session = result.session;

    window.location.href = localStorage.getItem("redirectAfterAuth") || "/";
  })
  .catch((e) => {
    error = e.toString();
  });
```


## Jazz Framework Integration

### Account Creation

When a user authenticates via AT Protocol, a Jazz account is created for local state management:

```typescript
// Account creation with migration
export const RoomyAccount = co
  .account({
    profile: RoomyProfile,
    root: RoomyRoot,
  })
  .withMigration((account, creationProps?: { name: string }) => {
    // Initialize root data if not present
    if (account.root === undefined) {
      account.root = RoomyRoot.create({
        lastRead: LastReadList.create({}),
      });
    }

    // Initialize profile if not present
    if (account.profile === undefined) {
      account.profile = RoomyProfile.create(
        {
          name: creationProps?.name ?? getRandomUsername(),
          joinedSpaces: createSpaceList(),
          roomyInbox: createInbox(),
        },
        publicGroup("reader"),
      );
    }
  });
```

### Profile Synchronization

User profiles are synchronized between AT Protocol and Jazz:

```typescript
// Profile sync effect
$effect(() => {
  if (!user.profile.data?.handle || !me.current) return;

  // Sync profile data from AT Protocol
  if (me.current.profile.name !== user.profile.data?.handle) {
    me.current.profile.name = user.profile.data?.handle;
  }

  if (me.current.profile.imageUrl !== user.profile.data?.avatar) {
    me.current.profile.imageUrl = user.profile.data?.avatar;
  }

  if (me.current.profile.blueskyHandle !== user.profile.data?.handle) {
    me.current.profile.blueskyHandle = user.profile.data?.handle;
  }

  if (me.current.profile.bannerUrl !== user.profile.data?.banner) {
    me.current.profile.bannerUrl = user.profile.data?.banner;
  }

  if (me.current.profile.description !== user.profile.data?.description) {
    me.current.profile.description = user.profile.data?.description;
  }
});
```

## Authorization Model

### Permission Levels

Roomy implements a hierarchical permission system:

```typescript
// Permission levels
enum PermissionLevel {
  GUEST = 'guest',           // Read-only access
  MEMBER = 'member',         // Basic participation
  MODERATOR = 'moderator',   // Content moderation
  ADMIN = 'admin',           // Space administration
  CREATOR = 'creator'        // Space creator (full control)
}

// Permission checks
function hasPermission(
  user: RoomyAccount,
  space: Space,
  permission: PermissionLevel
): boolean {
  // Space creator has all permissions
  if (space.creatorId === user.id) return true;
  
  // Check admin group membership
  if (permission === PermissionLevel.ADMIN || permission === PermissionLevel.CREATOR) {
    return isInAdminGroup(user, space.adminGroupId);
  }
  
  // Check space membership
  if (permission === PermissionLevel.MEMBER || permission === PermissionLevel.MODERATOR) {
    return isSpaceMember(user, space);
  }
  
  // Guest permissions (read-only)
  return permission === PermissionLevel.GUEST;
}
```

### Space-Level Permissions

```typescript
// Space permission checks
function canCreateChannel(user: RoomyAccount, space: Space): boolean {
  return hasPermission(user, space, PermissionLevel.ADMIN);
}

function canDeleteMessage(user: RoomyAccount, space: Space, message: Message): boolean {
  // Users can delete their own messages
  if (message.author === user.id) return true;
  
  // Admins can delete any message
  return hasPermission(user, space, PermissionLevel.ADMIN);
}

function canInviteUsers(user: RoomyAccount, space: Space): boolean {
  return hasPermission(user, space, PermissionLevel.ADMIN);
}

function canBanUser(user: RoomyAccount, space: Space): boolean {
  return hasPermission(user, space, PermissionLevel.ADMIN);
}
```

### Channel-Level Permissions

```typescript
// Channel-specific permissions
function canPostInChannel(user: RoomyAccount, space: Space, channel: Channel): boolean {
  // Check space-level permissions first
  if (!hasPermission(user, space, PermissionLevel.MEMBER)) return false;
  
  // Check channel-specific restrictions
  if (channel.readOnly) return false;
  
  return true;
}

function canCreateThread(user: RoomyAccount, space: Space, channel: Channel): boolean {
  return canPostInChannel(user, space, channel);
}
```

## Session Management

### Session Validation

```typescript
// Session validation
async function validateSession(): Promise<boolean> {
  try {
    // Check AT Protocol session
    const atpSession = await validateATPSession();
    if (!atpSession) return false;
    
    // Check Jazz account
    const jazzAccount = await validateJazzAccount();
    if (!jazzAccount) return false;
    
    return true;
  } catch (error) {
    console.error('Session validation failed:', error);
    return false;
  }
}

// Periodic session validation
setInterval(async () => {
  const isValid = await validateSession();
  if (!isValid) {
    // Redirect to login
    redirectToLogin();
  }
}, 5 * 60 * 1000); // Check every 5 minutes
```

### Session Persistence

```typescript
// Session persistence
class SessionPersistence {
  private static readonly SESSION_KEY = 'roomy_session';
  private static readonly ATP_SESSION_KEY = 'atp_session';
  
  static saveSession(session: RoomySession) {
    localStorage.setItem(this.SESSION_KEY, JSON.stringify(session));
  }
  
  static loadSession(): RoomySession | null {
    try {
      const stored = localStorage.getItem(this.SESSION_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      console.error('Failed to load session:', error);
      return null;
    }
  }
  
  static clearSession() {
    localStorage.removeItem(this.SESSION_KEY);
    localStorage.removeItem(this.ATP_SESSION_KEY);
  }
}
```

## Security Considerations

### Data Protection

```typescript
// Secure session storage
function storeSessionSecurely(session: RoomySession) {
  // Use secure storage when available
  if (window.isSecureContext) {
    // Store sensitive data in sessionStorage (cleared on tab close)
    sessionStorage.setItem('roomy_session', JSON.stringify(session));
  } else {
    // Fallback to localStorage with encryption (planned)
    localStorage.setItem('roomy_session', JSON.stringify(session));
  }
}

// Input validation
function validateUserInput(input: string): boolean {
  // Prevent XSS
  const sanitized = DOMPurify.sanitize(input);
  if (sanitized !== input) return false;
  
  // Check length limits
  if (input.length > MAX_INPUT_LENGTH) return false;
  
  // Check for malicious patterns
  if (MALICIOUS_PATTERNS.some(pattern => pattern.test(input))) return false;
  
  return true;
}
```

### Privacy Protection

```typescript
// Privacy-focused data handling
class PrivacyManager {
  // Minimal data collection
  static collectUserData(user: RoomyAccount): UserData {
    return {
      id: user.id,
      name: user.profile.name,
      handle: user.profile.blueskyHandle,
      // Don't collect unnecessary data
    };
  }
  
  // Data anonymization
  static anonymizeData(data: any): any {
    return {
      ...data,
      personalInfo: undefined,
      metadata: undefined
    };
  }
  
  // Data export for GDPR compliance
  static exportUserData(user: RoomyAccount): string {
    const data = this.collectUserData(user);
    return JSON.stringify(data, null, 2);
  }
}
```

### Best Practices

1. **Secure Communication**: Use HTTPS for all API calls
2. **Token Management**: Store tokens securely and rotate regularly
3. **Input Validation**: Validate all user inputs
4. **Error Handling**: Don't expose sensitive information in errors
5. **Session Timeout**: Implement automatic session expiration
6. **Rate Limiting**: Prevent abuse through rate limiting
7. **Audit Logging**: Log authentication events for security monitoring

## Error Handling

### Authentication Errors

```typescript
// Authentication error handling
class AuthErrorHandler {
  static handleOAuthError(error: OAuthError) {
    switch (error.code) {
      case 'access_denied':
        showNotification('Access denied by user', 'error');
        break;
      case 'invalid_grant':
        showNotification('Session expired, please login again', 'warning');
        redirectToLogin();
        break;
      case 'server_error':
        showNotification('Authentication service unavailable', 'error');
        break;
      default:
        showNotification('Authentication failed', 'error');
    }
  }
  
  static handleNetworkError(error: NetworkError) {
    if (error.code === 'NETWORK_ERROR') {
      showNotification('Network error, please check your connection', 'warning');
    } else {
      showNotification('Connection failed', 'error');
    }
  }
}
```

### Recovery Mechanisms

```typescript
// Session recovery
async function recoverSession(): Promise<boolean> {
  try {
    // Try to restore from stored session
    const session = SessionPersistence.loadSession();
    if (!session) return false;
    
    // Validate session
    const isValid = await validateSession();
    if (!isValid) {
      SessionPersistence.clearSession();
      return false;
    }
    
    return true;
  } catch (error) {
    console.error('Session recovery failed:', error);
    return false;
  }
}

// Automatic retry for failed requests
async function retryWithAuth<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      if (error.code === 'UNAUTHORIZED' && i < maxRetries - 1) {
        // Try to refresh session
        await refreshSession();
        continue;
      }
      throw error;
    }
  }
  throw new Error('Max retries exceeded');
}
```

## Testing

### Authentication Testing

```typescript
// Unit tests for authentication
describe('Authentication', () => {
  it('should validate OAuth callback', async () => {
    const mockCode = 'valid_code';
    const mockState = 'valid_state';
    
    const session = await handleOAuthCallback(mockCode, mockState);
    
    expect(session).toBeDefined();
    expect(session.did).toBeDefined();
    expect(session.handle).toBeDefined();
  });
  
  it('should handle invalid OAuth callback', async () => {
    const mockCode = 'invalid_code';
    const mockState = 'invalid_state';
    
    await expect(handleOAuthCallback(mockCode, mockState))
      .rejects.toThrow('Invalid authorization code');
  });
  
  it('should check user permissions correctly', () => {
    const user = createMockUser({ id: 'user1', role: 'member' });
    const space = createMockSpace({ creatorId: 'user2' });
    
    expect(hasPermission(user, space, PermissionLevel.MEMBER)).toBe(true);
    expect(hasPermission(user, space, PermissionLevel.ADMIN)).toBe(false);
  });
});
```

### Integration Testing

```typescript
// Integration tests
describe('Authentication Flow', () => {
  it('should complete full authentication flow', async () => {
    // Mock OAuth flow
    const mockTokens = { access_token: 'token', refresh_token: 'refresh' };
    oauthClient.validateCode = jest.fn().mockResolvedValue(mockTokens);
    
    // Complete authentication
    const session = await completeAuthentication();
    
    expect(session).toBeDefined();
    expect(SessionPersistence.loadSession()).toBeDefined();
  });
});
```

## Future Enhancements

### Planned Features

1. **End-to-End Encryption**: Message encryption using WebCrypto API
2. **Multi-Factor Authentication**: Additional security layers
3. **Biometric Authentication**: Fingerprint/face recognition support
4. **Single Sign-On**: Integration with enterprise SSO providers
5. **Advanced Permissions**: Granular permission system
6. **Audit Trail**: Comprehensive authentication logging

### Security Improvements

1. **Token Encryption**: Encrypt stored tokens
2. **Session Rotation**: Automatic session key rotation
3. **Threat Detection**: Detect and prevent suspicious activity
4. **Compliance**: GDPR and CCPA compliance features
5. **Penetration Testing**: Regular security assessments

---

*This authentication documentation provides a comprehensive overview of the authentication and authorization system in Roomy. For implementation details, refer to the source code in the `src/lib/` directory.* 