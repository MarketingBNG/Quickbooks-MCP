// Intuit OAuth 2.0 + QuickBooks Online API client
import { store } from "./store.js";
import type { Grant, IntuitTokens } from "./types.js";

const AUTH_URL = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
const API_BASE = process.env.INTUIT_ENV === "production"
  ? "https://quickbooks.api.intuit.com"
  : "https://sandbox-quickbooks.api.intuit.com";
const MINOR_VERSION = "75";
const SCOPES = "com.intuit.quickbooks.accounting openid profile email";

const basicAuth = () =>
  "Basic " + Buffer.from(`${process.env.INTUIT_CLIENT_ID}:${process.env.INTUIT_CLIENT_SECRET}`).toString("base64");
const callbackUrl = () => `${process.env.BASE_URL}/intuit/callback`;

export function intuitAuthorizeUrl(state: string): string {
  const u = new URL(AUTH_URL);
  u.search = String(new URLSearchParams({
    client_id: process.env.INTUIT_CLIENT_ID!,
    response_type: "code",
    scope: SCOPES,
    redirect_uri: callbackUrl(),
    state,
  }));
  return u.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<IntuitTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(), Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const json = await res.json() as Record<string, any>;
  if (!res.ok) throw new Error(`Intuit token error: ${json.error || res.status} ${json.error_description || ""}`);
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    accessExp: Date.now() + (json.expires_in - 60) * 1000,
  };
}

export const exchangeCode = (code: string) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: callbackUrl() });

export async function revoke(refreshToken: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { Authorization: basicAuth(), Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ token: refreshToken }),
  }).catch(() => {});
}

// Serialize refreshes per grant: Intuit rotates refresh tokens, so concurrent refreshes would race.
const refreshing = new Map<string, Promise<void>>();
async function freshAccessToken(grant: Grant, force = false): Promise<string> {
  if (!force && grant.intuit.accessExp > Date.now()) return grant.intuit.accessToken;
  if (!refreshing.has(grant.id)) {
    refreshing.set(grant.id, (async () => {
      try {
        const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: grant.intuit.refreshToken });
        grant.intuit = t;
        store.putGrant(grant);
      } finally { refreshing.delete(grant.id); }
    })());
  }
  await refreshing.get(grant.id);
  return grant.intuit.accessToken;
}

interface QboOptions { query?: Record<string, unknown>; body?: unknown }

// QuickBooks responses vary by entity, so callers index into them freely
export async function qbo(grant: Grant, method: string, path: string, { query, body }: QboOptions = {}): Promise<any> {
  const url = new URL(`${API_BASE}/v3/company/${grant.realmId}/${path}`);
  url.searchParams.set("minorversion", MINOR_VERSION);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));

  const send = async (token: string) => fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let res = await send(await freshAccessToken(grant));
  if (res.status === 401) res = await send(await freshAccessToken(grant, true));
  const text = await res.text();
  if (!res.ok) throw new Error(`QuickBooks API ${res.status}: ${text.slice(0, 1000)}`);
  return JSON.parse(text);
}
