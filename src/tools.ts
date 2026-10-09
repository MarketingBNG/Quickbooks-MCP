// MCP tools exposed to Claude / ChatGPT. Each server instance is bound to one user's grant.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { qbo } from "./intuit.js";
import type { Grant } from "./types.js";

const ENTITIES = [
  "Account", "Bill", "BillPayment", "Class", "CreditMemo", "Customer", "Department", "Deposit",
  "Employee", "Estimate", "Invoice", "Item", "JournalEntry", "Payment", "PaymentMethod", "Purchase",
  "PurchaseOrder", "RefundReceipt", "SalesReceipt", "TaxCode", "Term", "TimeActivity", "Transfer",
  "Vendor", "VendorCredit",
] as const;
const REPORTS = [
  "ProfitAndLoss", "ProfitAndLossDetail", "BalanceSheet", "CashFlow", "TrialBalance", "GeneralLedger",
  "AgedReceivables", "AgedReceivableDetail", "AgedPayables", "AgedPayableDetail", "CustomerSales",
  "CustomerIncome", "CustomerBalance", "VendorExpenses", "VendorBalance", "ItemSales", "TransactionList",
] as const;

const ok = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const wrap = <A>(fn: (args: A) => unknown) => async (args: A): Promise<CallToolResult> => {
  try { return ok(await fn(args)); }
  catch (e) { return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] }; }
};
const READ = { readOnlyHint: true, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

export function buildServer(grant: Grant): McpServer {
  const server = new McpServer({ name: "quickbooks", version: "1.0.0" });

  server.registerTool("get_company_info", {
    title: "Get company info",
    description: "Get the connected QuickBooks company's profile (name, address, fiscal year, country).",
    inputSchema: {},
    annotations: READ,
  }, wrap(() => qbo(grant, "GET", `companyinfo/${grant.realmId}`)));

  server.registerTool("query", {
    title: "Query QuickBooks",
    description:
      "Run a QuickBooks Online query (SQL-like). Examples: \"SELECT * FROM Invoice WHERE Balance > '0' ORDERBY DueDate\", " +
      "\"SELECT * FROM Customer WHERE DisplayName LIKE 'Acme%'\", \"SELECT COUNT(*) FROM Bill\". " +
      "Supports WHERE, ORDERBY, STARTPOSITION, MAXRESULTS (max 1000). No JOINs. Entities: " + ENTITIES.join(", "),
    inputSchema: { query: z.string().describe("QBO query statement") },
    annotations: READ,
  }, wrap(({ query }) => qbo(grant, "GET", "query", { query: { query } })));

  server.registerTool("get_entity", {
    title: "Get record by ID",
    description: "Fetch a single QuickBooks record by entity type and Id.",
    inputSchema: { entity: z.enum(ENTITIES), id: z.string() },
    annotations: READ,
  }, wrap(({ entity, id }) => qbo(grant, "GET", `${entity.toLowerCase()}/${id}`)));

  server.registerTool("get_report", {
    title: "Run financial report",
    description: "Run a QuickBooks report such as ProfitAndLoss, BalanceSheet, CashFlow, AgedReceivables.",
    inputSchema: {
      report: z.enum(REPORTS),
      start_date: z.string().optional().describe("YYYY-MM-DD"),
      end_date: z.string().optional().describe("YYYY-MM-DD"),
      date_macro: z.string().optional().describe("e.g. 'This Month', 'Last Fiscal Year', 'This Year-to-date'"),
      accounting_method: z.enum(["Accrual", "Cash"]).optional(),
      summarize_column_by: z.enum(["Total", "Month", "Quarter", "Year", "Customers", "Vendors", "Classes", "Departments"]).optional(),
      customer: z.string().optional().describe("Customer Id filter"),
      vendor: z.string().optional().describe("Vendor Id filter"),
    },
    annotations: READ,
  }, wrap(({ report, ...p }) => qbo(grant, "GET", `reports/${report}`, { query: p })));

  server.registerTool("create_entity", {
    title: "Create record",
    description:
      "Create a QuickBooks record (e.g. Customer, Vendor, Invoice, Bill, Estimate, Payment, JournalEntry). " +
      "`data` is the QBO API JSON body, e.g. Invoice: {\"CustomerRef\":{\"value\":\"58\"},\"Line\":[{\"Amount\":100," +
      "\"DetailType\":\"SalesItemLineDetail\",\"SalesItemLineDetail\":{\"ItemRef\":{\"value\":\"1\"}}}]}. " +
      "Look up referenced Ids with the query tool first. Confirm with the user before creating.",
    inputSchema: { entity: z.enum(ENTITIES), data: z.record(z.any()) },
    annotations: WRITE,
  }, wrap(({ entity, data }) => qbo(grant, "POST", entity.toLowerCase(), { body: data })));

  server.registerTool("update_entity", {
    title: "Update record",
    description:
      "Sparse-update a QuickBooks record. `data` must include Id and the current SyncToken (fetch with get_entity first), " +
      "plus only the fields to change. Confirm with the user before updating.",
    inputSchema: { entity: z.enum(ENTITIES), data: z.record(z.any()) },
    annotations: { ...WRITE, destructiveHint: true },
  }, wrap(({ entity, data }) =>
    qbo(grant, "POST", entity.toLowerCase(), { body: { ...data, sparse: true } })));

  server.registerTool("send_invoice", {
    title: "Email invoice",
    description: "Email an existing invoice to the customer (optionally to a specific address). Confirm with the user first.",
    inputSchema: { invoice_id: z.string(), email: z.string().email().optional() },
    annotations: WRITE,
  }, wrap(({ invoice_id, email }) =>
    qbo(grant, "POST", `invoice/${invoice_id}/send`, { query: { sendTo: email } })));

  // ChatGPT's deep-research / company-knowledge mode looks for tools named exactly `search` and `fetch`.
  server.registerTool("search", {
    title: "Search QuickBooks",
    description: "Search customers, vendors, and items by name. Returns ids usable with fetch.",
    inputSchema: { query: z.string() },
    annotations: READ,
  }, wrap(async ({ query }) => {
    const q = query.replace(/'/g, "\\'");
    const lists = await Promise.all([
      ["Customer", "DisplayName"], ["Vendor", "DisplayName"], ["Item", "Name"],
    ].map(async ([ent, field]): Promise<{ id: string; title: string; url: string }[]> => {
      const r = await qbo(grant, "GET", "query", {
        query: { query: `SELECT * FROM ${ent} WHERE ${field} LIKE '%${q}%' MAXRESULTS 10` },
      });
      return (r.QueryResponse?.[ent] || []).map((x: Record<string, string>) => ({
        id: `${ent}:${x.Id}`, title: `${ent}: ${x[field]}`, url: "",
      }));
    }));
    return { results: lists.flat() };
  }));

  server.registerTool("fetch", {
    title: "Fetch QuickBooks record",
    description: "Fetch a record returned by search, using its id (format Entity:Id).",
    inputSchema: { id: z.string() },
    annotations: READ,
  }, wrap(async ({ id }) => {
    const [ent, recId] = id.split(":");
    if (!(ENTITIES as readonly string[]).includes(ent)) throw new Error("id must look like Customer:58");
    const r = await qbo(grant, "GET", `${ent.toLowerCase()}/${recId}`);
    return { id, title: id, text: JSON.stringify(r[ent] ?? r), url: "", metadata: { entity: ent } };
  }));

  return server;
}
