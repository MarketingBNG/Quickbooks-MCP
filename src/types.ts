// Shared shapes for the store and OAuth flows.
export interface IntuitTokens { accessToken: string; refreshToken: string; accessExp: number }

// A "grant" = one user's connection to one QuickBooks company (holds Intuit tokens)
export interface Grant { id: string; realmId: string; intuit: IntuitTokens; createdAt: number }

export interface Client {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  client_secret?: string;
  client_secret_expires_at?: number;
}

export interface AccessToken { grantId: string; clientId: string; exp: number }
export interface RefreshToken { grantId: string; clientId: string }

export interface PendingAuth { clientId: string; redirectUri: string; state?: string; codeChallenge: string; exp: number }
export interface AuthCode { clientId: string; redirectUri: string; codeChallenge: string; grantId: string; exp: number }

declare global {
  namespace Express {
    interface Request { grant?: Grant }
  }
}
