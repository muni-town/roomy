/**
 * Tests for the OAuth failure diagnostic.
 *
 * The contract: a sign-in failure names the step it failed at and carries the
 * error body of the request that failed. Both client libraries collapse the
 * failure to one message (`OAuthCallbackError.from` copies the inner message
 * and keeps the inner error as `cause`), so the status and body only survive
 * if this reader walks the cause chain. The registration case is the one that
 * matters in production: the whole scope set is refused when one token is
 * missing from the API client's allowlist, and only the body names the token.
 *
 * The errors are built with the real classes from `@happyview/oauth-client`
 * (re-exported by the browser package) so the shapes under test are the ones
 * the flow actually throws.
 */
import { describe, it, expect } from "vitest";
import {
  ApiError,
  OAuthCallbackError,
  ResolutionError,
  TokenExchangeError,
} from "@happyview/oauth-client-browser";

import { describeOAuthFailure } from "./oauth-failure";

const STATE = new URLSearchParams("state=abc123&code=xyz");

describe("describeOAuthFailure", () => {
  it("names session registration and carries the rejected scope token", () => {
    // What HappyView's POST /oauth/sessions returns when one requested token
    // is not registered on its API client — it rejects the whole set.
    const body = {
      error: "scope 'rpc:space.roomy.voice.join?aud=*' is not allowed for this client",
    };
    const apiError = new ApiError(
      `Failed to register session: 400 ${body.error}`,
      400,
      body,
    );
    const wrapped = OAuthCallbackError.from(apiError, STATE, "abc123");

    const failure = describeOAuthFailure(wrapped);

    expect(failure.step).toBe("session registration");
    expect(failure.status).toBe(400);
    expect(failure.body).toEqual(body);
    expect(failure.summary).toContain("session registration");
    expect(failure.summary).toContain("HTTP 400");
    expect(failure.summary).toContain("rpc:space.roomy.voice.join?aud=*");
  });

  it("names token exchange and keeps the PDS's raw error body", () => {
    // The PDS answers the code exchange with a JSON error body; the client
    // keeps it as the raw response text.
    const rawBody =
      '{"error":"invalid_grant","error_description":"Code was not issued to this client"}';
    const inner = new TokenExchangeError(
      `Token exchange failed: 400 ${rawBody}`,
      400,
      rawBody,
    );
    const wrapped = OAuthCallbackError.from(inner, STATE, "abc123");

    const failure = describeOAuthFailure(wrapped);

    expect(failure.step).toBe("token exchange");
    expect(failure.status).toBe(400);
    expect(failure.body).toBe(rawBody);
    expect(failure.summary).toContain("token exchange");
    expect(failure.summary).toContain("invalid_grant");
  });

  it("names the authorization step and reads the PDS's own error", () => {
    // The PDS refused on the consent screen and redirected back with
    // `error=`/`error_description=` instead of a code.
    const params = new URLSearchParams(
      "state=abc123&error=invalid_scope&error_description=scope+not+allowed",
    );

    const failure = describeOAuthFailure(new OAuthCallbackError(params, undefined, "abc123"));

    expect(failure.step).toBe("authorization");
    expect(failure.authorizationError).toEqual({
      error: "invalid_scope",
      description: "scope not allowed",
    });
    expect(failure.summary).toContain("invalid_scope");
    expect(failure.summary).toContain("scope not allowed");
  });

  it("names the pushed authorization request when PAR is refused", () => {
    // Thrown before any navigation, so there is no callback wrapper.
    const failure = describeOAuthFailure(
      new ResolutionError('PAR request failed: 400 {"error":"invalid_scope"}'),
    );

    expect(failure.step).toBe("pushed authorization request");
    expect(failure.summary).toContain("PAR request failed");
  });

  it("names endpoint resolution when the PDS cannot be reached", () => {
    const failure = describeOAuthFailure(
      new ResolutionError("Failed to fetch auth server metadata from https://pds.example: 429"),
    );

    expect(failure.step).toBe("resolution");
    expect(failure.summary).toContain("429");
  });

  it("still describes a failure that is not an Error", () => {
    const failure = describeOAuthFailure("network blew up");

    expect(failure.step).toBe("unknown");
    expect(failure.summary).toContain("network blew up");
  });
});
