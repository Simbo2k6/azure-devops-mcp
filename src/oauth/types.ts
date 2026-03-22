// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/** A client dynamically registered by an MCP consumer (e.g. Claude.ai). */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUris: string[];
  createdAt: number;
}

/**
 * State kept server-side while the user is being redirected through Azure AD.
 * Keyed by the `state` value sent to Azure AD so we can correlate the callback.
 */
export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  /** The original `state` value supplied by the MCP client (Claude.ai). */
  clientState: string;
  createdAt: number;
}

/**
 * Short-lived auth code issued to the MCP client after the Azure AD callback.
 * Exchanged for a session token at /oauth/token.
 */
export interface AuthCodeData {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  /** Azure DevOps access token obtained from Azure AD on behalf of the user. */
  adoToken: string;
  createdAt: number;
}

/** Long-lived session that maps the opaque Bearer token → ADO token. */
export interface SessionData {
  adoToken: string;
  orgName: string;
  createdAt: number;
  expiresAt: number;
}
