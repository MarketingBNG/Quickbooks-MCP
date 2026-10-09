// Minimal encrypted JSON-file store. Swap for Postgres/Redis when running more than one instance.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Client, Grant, AccessToken, RefreshToken, PendingAuth, AuthCode } from "./types.js";

const FILE = process.env.DATA_FILE || "./data/store.json";
const KEY = Buffer.from(process.env.ENCRYPTION_KEY || "", "hex");
if (KEY.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes of hex (64 chars)");

function encrypt(obj: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}
function decrypt<T>(str: string): T {
  const buf = Buffer.from(str, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", KEY, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
}

interface Db {
  clients: Record<string, Client>;
  grants: Record<string, Grant>;
  accessTokens: Record<string, AccessToken>;
  refreshTokens: Record<string, RefreshToken>;
}

let db: Db = { clients: {}, grants: {}, accessTokens: {}, refreshTokens: {} };
if (fs.existsSync(FILE)) db = decrypt<Db>(fs.readFileSync(FILE, "utf8"));

function save(): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE + ".tmp", encrypt(db));
  fs.renameSync(FILE + ".tmp", FILE);
}

export const hash = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = (): string => crypto.randomBytes(32).toString("base64url");

// Short-lived, in-memory only
export const pendingAuth = new Map<string, PendingAuth>(); // intuit state -> pending /authorize request
export const authCodes = new Map<string, AuthCode>(); // our auth code -> { clientId, redirectUri, codeChallenge, grantId, exp }

export const store = {
  getClient: (id: string): Client | undefined => db.clients[id],
  putClient(c: Client) { db.clients[c.client_id] = c; save(); },

  // A "grant" = one user's connection to one QuickBooks company (holds Intuit tokens)
  getGrant: (id: string): Grant | undefined => db.grants[id],
  putGrant(g: Grant) { db.grants[g.id] = g; save(); },
  deleteGrant(id: string) {
    delete db.grants[id];
    for (const t of ["accessTokens", "refreshTokens"] as const)
      for (const [k, v] of Object.entries(db[t])) if (v.grantId === id) delete db[t][k];
    save();
  },

  issueTokens(grantId: string, clientId: string) {
    const access = randomToken(), refresh = randomToken();
    db.accessTokens[hash(access)] = { grantId, clientId, exp: Date.now() + 3600_000 };
    db.refreshTokens[hash(refresh)] = { grantId, clientId };
    save();
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh };
  },
  lookupAccess(token: string): AccessToken | null {
    const t = db.accessTokens[hash(token)];
    if (!t || t.exp < Date.now()) return null;
    return t;
  },
  rotateRefresh(token: string, clientId: string) {
    const k = hash(token), t = db.refreshTokens[k];
    if (!t || t.clientId !== clientId || !db.grants[t.grantId]) return null;
    delete db.refreshTokens[k];
    return store.issueTokens(t.grantId, clientId);
  },
};
