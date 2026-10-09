// QuickBooks Online remote MCP server.
// Acts as an OAuth 2.1 authorization server for MCP clients (Claude, ChatGPT) and delegates
// the actual user sign-in to Intuit. Each MCP access token maps to one user's QuickBooks company.
import express, { type Request, type Response, type NextFunction } from "express";
import crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { store, pendingAuth, authCodes, randomToken } from "./store.js";
import { intuitAuthorizeUrl, exchangeCode, revoke } from "./intuit.js";
import { buildServer } from "./tools.js";
import type { Client, Grant } from "./types.js";

for (const k of ["BASE_URL", "INTUIT_CLIENT_ID", "INTUIT_CLIENT_SECRET", "ENCRYPTION_KEY"])
  if (!process.env[k]) throw new Error(`Missing env var ${k}`);

const BASE = process.env.BASE_URL!.replace(/\/$/, "");
const MCP_URL = `${BASE}/mcp`;
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version");
  res.set("Access-Control-Expose-Headers", "WWW-Authenticate, Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const oauthError = (res: Response, status: number, error: string, description: string) =>
  res.status(status).json({ error, error_description: description });

// Expire short-lived OAuth state
setInterval(() => {
  const now = Date.now();
  for (const m of [pendingAuth, authCodes]) for (const [k, v] of m) if (v.exp < now) m.delete(k);
}, 60_000).unref();

// ---------- Discovery (RFC 9728 + RFC 8414) ----------
const protectedResource = {
  resource: MCP_URL,
  authorization_servers: [BASE],
  scopes_supported: ["quickbooks"],
  bearer_methods_supported: ["header"],
  resource_name: "QuickBooks Online",
};
app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
  (req, res) => res.json(protectedResource));

const asMetadata = {
  issuer: BASE,
  authorization_endpoint: `${BASE}/authorize`,
  token_endpoint: `${BASE}/token`,
  registration_endpoint: `${BASE}/register`,
  revocation_endpoint: `${BASE}/revoke`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
  scopes_supported: ["quickbooks"],
};
app.get(["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"],
  (req, res) => res.json(asMetadata));

// ---------- Dynamic Client Registration (RFC 7591) ----------
const validRedirect = (u: unknown): boolean => {
  try {
    const url = new URL(String(u));
    return url.protocol === "https:" || ["localhost", "127.0.0.1"].includes(url.hostname);
  } catch { return false; }
};

app.post("/register", (req, res) => {
  const b = req.body || {};
  const uris: unknown = b.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || !uris.every(validRedirect))
    return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be https (or localhost)");
  const method = b.token_endpoint_auth_method || "none";
  const client: Client = {
    client_id: randomToken(),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: b.client_name || "MCP client",
    redirect_uris: uris as string[],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
    ...(method !== "none" ? { client_secret: randomToken(), client_secret_expires_at: 0 } : {}),
  };
  store.putClient(client);
  res.status(201).json(client);
});

// ---------- Authorization ----------
app.get("/authorize", (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const client = store.getClient(q.client_id || "");
  if (!client) return res.status(400).send("Unknown client_id. Re-add the connector.");
  if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) return res.status(400).send("redirect_uri not registered");

  const back = (params: Record<string, string>) => {
    const u = new URL(q.redirect_uri!);
    for (const [k, v] of Object.entries({ ...params, state: q.state })) if (v) u.searchParams.set(k, v);
    res.redirect(u.toString());
  };
  if (q.response_type !== "code") return back({ error: "unsupported_response_type" });
  if (!q.code_challenge || (q.code_challenge_method || "plain") !== "S256")
    return back({ error: "invalid_request", error_description: "PKCE S256 required" });

  const intuitState = randomToken();
  pendingAuth.set(intuitState, {
    clientId: client.client_id,
    redirectUri: q.redirect_uri,
    state: q.state,
    codeChallenge: q.code_challenge,
    exp: Date.now() + 10 * 60_000,
  });
  res.redirect(intuitAuthorizeUrl(intuitState));
});

// Intuit redirects here after the user signs in and picks a company
app.get("/intuit/callback", async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const p = pendingAuth.get(q.state || "");
  if (!p) return res.status(400).send("Sign-in session expired. Please try connecting again.");
  pendingAuth.delete(q.state!);

  const back = (params: Record<string, string>) => {
    const u = new URL(p.redirectUri);
    for (const [k, v] of Object.entries({ ...params, state: p.state })) if (v) u.searchParams.set(k, v);
    res.redirect(u.toString());
  };
  if (q.error) return back({ error: "access_denied", error_description: q.error });
  if (!q.code || !q.realmId) return back({ error: "server_error", error_description: "Missing code/realmId" });

  try {
    const intuit = await exchangeCode(q.code);
    const grant: Grant = { id: randomToken(), realmId: q.realmId, intuit, createdAt: Date.now() };
    store.putGrant(grant);
    const code = randomToken();
    authCodes.set(code, {
      clientId: p.clientId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge,
      grantId: grant.id, exp: Date.now() + 5 * 60_000,
    });
    back({ code });
  } catch (e) {
    console.error(e);
    back({ error: "server_error", error_description: "QuickBooks sign-in failed" });
  }
});

// ---------- Token ----------
function authenticateClient(req: Request): Client | null {
  let id: string = req.body.client_id, secret: string | undefined = req.body.client_secret;
  const h = req.headers.authorization;
  if (h?.startsWith("Basic ")) {
    [id, secret] = Buffer.from(h.slice(6), "base64").toString().split(":").map(decodeURIComponent);
  }
  const client = store.getClient(id);
  if (!client) return null;
  if (client.token_endpoint_auth_method !== "none") {
    const a = Buffer.from(secret || ""), b = Buffer.from(client.client_secret || "");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  }
  return client;
}

app.post("/token", (req, res) => {
  res.set("Cache-Control", "no-store");
  const client = authenticateClient(req);
  if (!client) return oauthError(res, 401, "invalid_client", "Client authentication failed");
  const b = req.body;

  if (b.grant_type === "authorization_code") {
    const c = authCodes.get(b.code);
    authCodes.delete(b.code);
    if (!c || c.exp < Date.now() || c.clientId !== client.client_id || c.redirectUri !== b.redirect_uri)
      return oauthError(res, 400, "invalid_grant", "Invalid or expired code");
    const challenge = crypto.createHash("sha256").update(b.code_verifier || "").digest("base64url");
    if (challenge !== c.codeChallenge) return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
    return res.json({ ...store.issueTokens(c.grantId, client.client_id), scope: "quickbooks" });
  }
  if (b.grant_type === "refresh_token") {
    const t = store.rotateRefresh(b.refresh_token || "", client.client_id);
    if (!t) return oauthError(res, 400, "invalid_grant", "Invalid refresh token");
    return res.json({ ...t, scope: "quickbooks" });
  }
  oauthError(res, 400, "unsupported_grant_type", "");
});

// Revoking our token also disconnects QuickBooks for that grant
app.post("/revoke", async (req, res) => {
  const t = store.lookupAccess(req.body.token || "");
  if (t) {
    const g = store.getGrant(t.grantId);
    if (g) { await revoke(g.intuit.refreshToken); store.deleteGrant(g.id); }
  }
  res.sendStatus(200);
});

// ---------- MCP endpoint ----------
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const h = req.headers.authorization || "";
  const t = h.startsWith("Bearer ") && store.lookupAccess(h.slice(7));
  const grant = t && store.getGrant(t.grantId);
  if (!grant) {
    res.set("WWW-Authenticate",
      `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource", error="invalid_token"`);
    return res.status(401).json({ error: "invalid_token" });
  }
  req.grant = grant;
  next();
}

// Stateless Streamable HTTP: a fresh server bound to the caller's QuickBooks company per request
app.post("/mcp", requireAuth, async (req, res) => {
  const server = buildServer(req.grant!);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error(e);
    if (!res.headersSent)
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});
app.get("/mcp", requireAuth, (req, res) => res.status(405).set("Allow", "POST").end());
app.delete("/mcp", requireAuth, (req, res) => res.status(405).set("Allow", "POST").end());

// Intuit requires these URLs on your app profile for production review
app.get("/", (req, res) => res.send(`<h1>QuickBooks MCP connector</h1><p>MCP endpoint: <code>${MCP_URL}</code></p>`));
app.get("/intuit/disconnect", (req, res) =>
  res.send("<p>Your QuickBooks company has been disconnected. You can remove the connector from Claude/ChatGPT settings.</p>"));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`QuickBooks MCP listening on :${port} — MCP URL ${MCP_URL}`));
