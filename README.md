# QuickBooks Online MCP Connector

A remote MCP server that lets anyone connect **their own** QuickBooks Online company to **Claude** or **ChatGPT** by signing in with their Intuit ID.

```
Claude / ChatGPT ──OAuth 2.1 + PKCE──▶ this server ──OAuth 2.0──▶ Intuit sign-in
        │                                  │
        └──── MCP (Bearer token) ─────────▶ /mcp ──▶ QuickBooks API (that user's company)
```

## 1. Create the Intuit app
1. Go to https://developer.intuit.com → **Dashboard → Create an app → QuickBooks Online and Payments**.
2. Scope: **com.intuit.quickbooks.accounting**.
3. Under **Keys & credentials**, add this redirect URI: `https://YOUR-DOMAIN/intuit/callback`
4. Copy the Client ID and Client Secret. Use the **Development** keys + `INTUIT_ENV=sandbox` to test.
   For real customers, finish Intuit's production questionnaire and switch to the **Production** keys + `INTUIT_ENV=production`.
   (Intuit asks for host domain, launch URL `https://YOUR-DOMAIN/`, and disconnect URL `https://YOUR-DOMAIN/intuit/disconnect`.)

## 2. Run it
```bash
cp .env.example .env     # fill in values
npm install
npm run build            # compiles src/*.ts -> dist/
npm start
```
It must be reachable over public **HTTPS** (Render, Railway, Fly.io, Azure App Service, etc.).
For local testing, use a tunnel: `ngrok http 3000`, then set `BASE_URL` to the ngrok URL.

Keep `ENCRYPTION_KEY` and `DATA_FILE` the same between deploys, or everyone has to reconnect.

## 3. Connect
**Claude** (claude.ai → Settings → Connectors → *Add custom connector*): URL `https://YOUR-DOMAIN/mcp`.
For a team or enterprise plan, an owner adds it once and members click **Connect**.

**ChatGPT** (Settings → Apps & Connectors → Advanced → enable *Developer mode* → *Create*):
URL `https://YOUR-DOMAIN/mcp`, Authentication **OAuth**. Workspace admins can publish it for the whole workspace.

Each user is sent to Intuit, signs in, picks their company, and is redirected back.
No client IDs need to be shared. Both apps register themselves automatically through dynamic client registration.

## Tools
| Tool | Purpose |
|---|---|
| `get_company_info` | Company profile |
| `query` | QBO SQL-style queries (invoices, customers, bills, …) |
| `get_entity` | One record by type + Id |
| `get_report` | P&L, Balance Sheet, Cash Flow, AR/AP aging, etc. |
| `create_entity` / `update_entity` | Create or sparse-update records |
| `send_invoice` | Email an invoice |
| `search` / `fetch` | Name search (used by ChatGPT deep research) |

## Production notes
- The store is an encrypted JSON file, which is fine for one instance. Use Postgres or Redis if you run more than one.
- Intuit refresh tokens last about 100 days and rotate. They refresh automatically, but a user who is idle longer than that must reconnect.
- To limit the connector to read-only access, delete the `create_entity`, `update_entity`, and `send_invoice` tools in `src/tools.ts` and rebuild.
