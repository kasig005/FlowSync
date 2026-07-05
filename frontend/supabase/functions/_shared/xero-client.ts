// Shared helper for talking to Xero from Supabase Edge Functions (Deno).
//
// Centralises: token exchange, token refresh, the stored-connection lookup,
// and a thin authenticated-fetch wrapper -- so every edge function that
// calls Xero (xero-data, generate-report, fx-history, ...) refreshes and
// errors the same way instead of re-implementing this per function.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

// Refresh a bit before the real expiry to leave headroom for the request
// that follows, rather than refreshing exactly at the edge.
const REFRESH_SKEW_SECONDS = 60;

export interface XeroTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

export interface XeroConnection {
  id: string; // Xero's connectionId (needed to DELETE /connections/{id})
  tenantId: string;
  tenantType: string;
  tenantName: string;
}

export class XeroApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = "XeroApiError";
  }
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return "Basic " + btoa(`${clientId}:${clientSecret}`);
}

// Decode a JWT payload without verifying the signature. Safe here because
// the token came directly from Xero's token endpoint over TLS in this same
// request -- we're not accepting it from an untrusted client. Do not reuse
// this helper for tokens received from anywhere else.
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  return JSON.parse(atob(padded));
}

export function getXeroCredentials(): { clientId: string; clientSecret: string } {
  const clientId = Deno.env.get("XERO_CLIENT_ID");
  const clientSecret = Deno.env.get("XERO_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new Error("XERO_CLIENT_ID / XERO_CLIENT_SECRET are not configured.");
  }
  return { clientId, clientSecret };
}

export function getServiceRoleClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured.");
  return createClient(url, key);
}

export function getAnonClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY are not configured.");
  return createClient(url, key);
}

// Resolves the calling Supabase user from the request's Authorization
// header. The Supabase platform already rejects invalid/expired JWTs before
// the function runs (verify_jwt defaults to true), but the function still
// needs to decode the token itself to know *which* user is calling.
export async function getCallingUserId(req: Request): Promise<string> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new XeroApiError("Missing Authorization header.", 401);
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const { data, error } = await getAnonClient().auth.getUser(jwt);
  if (error || !data.user) throw new XeroApiError("Invalid or expired session.", 401);
  return data.user.id;
}

export async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
): Promise<XeroTokenResponse> {
  const { clientId, clientSecret } = getXeroCredentials();
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new XeroApiError(body.error_description || body.error || "Xero token exchange failed.", 401);
  }
  return body as XeroTokenResponse;
}

async function refreshXeroToken(refreshToken: string): Promise<XeroTokenResponse> {
  const { clientId, clientSecret } = getXeroCredentials();
  const res = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const body = await res.json();
  if (!res.ok) {
    // A failed refresh almost always means the connection was revoked from
    // Xero's side (user disconnected via Connected Apps) -- surface this
    // distinctly so the frontend can prompt reconnection (Checkpoint 3).
    throw new XeroApiError(
      body.error_description || "Xero connection was revoked or expired. Please reconnect.",
      409,
    );
  }
  return body as XeroTokenResponse;
}

// Loads the caller's stored Xero connection, transparently refreshing the
// access token first if it's at or near expiry, and persisting the new
// token so the next call doesn't need to refresh again.
export async function getValidAccessToken(userId: string): Promise<string> {
  const supabase = getServiceRoleClient();
  const { data: row, error } = await supabase
    .from("xero_connections")
    .select("access_token, refresh_token, expires_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw new XeroApiError(`Failed to read Xero connection: ${error.message}`, 500);
  if (!row) throw new XeroApiError("No Xero organisation connected.", 404);

  const expiresAt = new Date(row.expires_at).getTime();
  const now = Date.now();
  if (expiresAt - now > REFRESH_SKEW_SECONDS * 1000) {
    return row.access_token as string;
  }

  const refreshed = await refreshXeroToken(row.refresh_token as string);
  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();

  const { error: updateError } = await supabase
    .from("xero_connections")
    .update({
      access_token: refreshed.access_token,
      // Xero rotates refresh tokens on every use -- always persist the new one.
      refresh_token: refreshed.refresh_token ?? row.refresh_token,
      expires_at: newExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (updateError) throw new XeroApiError(`Failed to persist refreshed token: ${updateError.message}`, 500);

  return refreshed.access_token;
}

export async function listXeroConnections(accessToken: string): Promise<XeroConnection[]> {
  const res = await fetch(XERO_CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new XeroApiError("Failed to load Xero connections.", res.status);
  }
  const body = await res.json();
  return (body as Array<Record<string, string>>).map((c) => ({
    id: c.id,
    tenantId: c.tenantId,
    tenantType: c.tenantType,
    tenantName: c.tenantName,
  }));
}

export async function disconnectXeroConnection(accessToken: string, connectionId: string): Promise<void> {
  const res = await fetch(`${XERO_CONNECTIONS_URL}/${connectionId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404) {
    throw new XeroApiError("Failed to disconnect Xero organisation.", res.status);
  }
}

// Thin wrapper for the Accounting API (api.xro/2.0). Adds auth, the required
// tenant header, and turns non-2xx responses into XeroApiError so callers
// can map them to user-facing messages (Checkpoint 6: Error handling).
export async function callXeroAccountingApi(
  accessToken: string,
  tenantId: string,
  path: string,
): Promise<unknown> {
  const res = await fetch(`${XERO_API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Xero-tenant-id": tenantId,
      Accept: "application/json",
    },
  });

  if (res.status === 401) {
    throw new XeroApiError("Xero rejected the request (expired or insufficient permissions). Please reconnect.", 401);
  }
  if (res.status === 429) {
    throw new XeroApiError("Xero API rate limit reached. Please try again shortly.", 429);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new XeroApiError(`Xero API error (${res.status}): ${text.slice(0, 300)}`, res.status);
  }
  return res.json();
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof XeroApiError) {
    return jsonResponse({ error: err.message }, err.status);
  }
  console.error("Unhandled edge function error:", err);
  return jsonResponse({ error: err instanceof Error ? err.message : "Unexpected error." }, 500);
}