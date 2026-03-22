// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { AuthCodeData, OAuthClient, PendingAuthorization, SessionData } from "./types.js";

// ---------------------------------------------------------------------------
// TTLs
// ---------------------------------------------------------------------------
const PENDING_AUTH_TTL_MS = 10 * 60 * 1000; //  10 min  – user must complete login
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; //   5 min  – one-time use
const SESSION_TTL_MS = 60 * 60 * 1000; //   1 hour – Bearer token lifetime

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------
const clients = new Map<string, OAuthClient>();
const pendingAuthorizations = new Map<string, PendingAuthorization>();
const authCodes = new Map<string, AuthCodeData>();
const sessions = new Map<string, SessionData>();

// ---------------------------------------------------------------------------
// Background cleanup (runs every 5 min, does not prevent process exit)
// ---------------------------------------------------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingAuthorizations) {
    if (now - v.createdAt > PENDING_AUTH_TTL_MS) pendingAuthorizations.delete(k);
  }
  for (const [k, v] of authCodes) {
    if (now - v.createdAt > AUTH_CODE_TTL_MS) authCodes.delete(k);
  }
  for (const [k, v] of sessions) {
    if (now > v.expiresAt) sessions.delete(k);
  }
}, 5 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Client registration
// ---------------------------------------------------------------------------

export function registerClient(redirectUris: string[]): OAuthClient {
  const client: OAuthClient = {
    clientId: randomUUID(),
    clientSecret: randomUUID(),
    redirectUris,
    createdAt: Date.now(),
  };
  clients.set(client.clientId, client);
  return client;
}

export function getClient(clientId: string): OAuthClient | undefined {
  return clients.get(clientId);
}

// ---------------------------------------------------------------------------
// Pending authorizations (Azure AD redirect state)
// ---------------------------------------------------------------------------

export function storePendingAuthorization(azureState: string, data: PendingAuthorization): void {
  pendingAuthorizations.set(azureState, data);
}

/** Returns and removes the pending authorization (one-time use). */
export function consumePendingAuthorization(azureState: string): PendingAuthorization | undefined {
  const data = pendingAuthorizations.get(azureState);
  if (!data) return undefined;
  pendingAuthorizations.delete(azureState);
  if (Date.now() - data.createdAt > PENDING_AUTH_TTL_MS) return undefined;
  return data;
}

// ---------------------------------------------------------------------------
// Auth codes
// ---------------------------------------------------------------------------

export function storeAuthCode(code: string, data: AuthCodeData): void {
  authCodes.set(code, data);
}

/** Returns and removes the auth code (one-time use). */
export function consumeAuthCode(code: string): AuthCodeData | undefined {
  const data = authCodes.get(code);
  if (!data) return undefined;
  authCodes.delete(code);
  if (Date.now() - data.createdAt > AUTH_CODE_TTL_MS) return undefined;
  return data;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function createSession(adoToken: string, orgName: string): string {
  const sessionToken = randomUUID();
  sessions.set(sessionToken, {
    adoToken,
    orgName,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return sessionToken;
}

export function getSession(sessionToken: string): SessionData | undefined {
  const session = sessions.get(sessionToken);
  if (!session) return undefined;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionToken);
    return undefined;
  }
  return session;
}

export function getActiveSessionCount(): number {
  return sessions.size;
}
