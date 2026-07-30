"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mcp_js_1 = require("@modelcontextprotocol/sdk/server/mcp.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const sheets_1 = require("@googleapis/sheets");
const zod_1 = require("zod");
const fs = require("fs");

// ── Config ────────────────────────────────────────────────────────────────────
const SHEET_ID = process.env.SHEET_ID || '';
const KEY_FILE = process.env.GOOGLE_KEY_FILE || '';

if (!SHEET_ID) throw new Error('Missing required env var: SHEET_ID');
if (!KEY_FILE) throw new Error('Missing required env var: GOOGLE_KEY_FILE');
if (!fs.existsSync(KEY_FILE)) throw new Error(`Service account key file not found: ${KEY_FILE}`);

const BRANDS = [
    'Vivi',
    'Bovedainc',
    'Skipper',
    'Boveda Music',
    'Boveda Brands',
    'BovBiz US',
    'BovBiz EU'
];

// ── Google Sheets client ──────────────────────────────────────────────────────
const authClient = new sheets_1.auth.GoogleAuth({
    keyFile: KEY_FILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
});

const sheetsClient = sheets_1.sheets({ version: 'v4', auth: authClient });

// ── Shared helpers ────────────────────────────────────────────────────────────
function normalizeBrand(input) {
    const lower = input.toLowerCase().trim();
    return BRANDS.find(b => b.toLowerCase() === lower) ?? null;
}

function tabName(brand, type) {
    return `${brand} – ${type}`;
}

async function getSheetRows(tab, headerRow = 1) {
    const range = `'${tab}'!${headerRow}:10000`;
    const response = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range
    });
    return response.data.values ?? [];
}

function matchesKeyword(row, keyword) {
    const kw = keyword.toLowerCase();
    return row.some(cell => cell?.toLowerCase().includes(kw));
}

function rowsToObjects(headers, rows) {
    return rows.map(row =>
        Object.fromEntries(
            headers.map((h, i) => [h.trim(), (row[i] ?? '').trim()])
        )
    );
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new mcp_js_1.McpServer({
    name: 'boveda-sheets-mcp',
    version: '1.0.0'
});

// Tool: list brands
server.registerTool(
    'sheets_list_brands',
    {
        title: 'List Brands',
        description: `List all available brands in the Boveda web management sheet. Returns brand names that can be used as the 'brand' parameter in other tools.`,
        inputSchema: zod_1.z.object({}),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    },
    async () => {
        const output = { brands: [...BRANDS] };
        return {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output
        };
    }
);

// Tool: search pages
server.registerTool(
    'sheets_search_pages',
    {
        title: 'Search Brand Pages',
        description: `Search the Pages tab for a specific brand in the Boveda web management sheet.

Columns available: Category, Page (Internal Name), URL, Status, Hosting, Access Point, Access Points Summary, Notes, Domain

Use this tool for queries like:
- "What is the URL for the Cookie Policy for Skipper?"
- "What are the access points for Vivi Cure?"
- "Show me all active pages for Boveda Music"
- "What pages does Skipper have in the Blog category?"

Args:
  - brand (string): Brand name, e.g. "Skipper", "Vivi", "BovBiz EU"
  - keyword (string, optional): Filter rows by keyword matched against any column

Returns: Array of matching page rows with all columns.`,
        inputSchema: zod_1.z.object({
            brand: zod_1.z.string().describe('Brand name, e.g. "Skipper", "Vivi", "BovBiz EU"'),
            keyword: zod_1.z.string().optional().describe('Optional keyword to filter rows, matched against any column')
        }),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    },
    async ({ brand, keyword }) => {
        const resolved = normalizeBrand(brand);
        if (!resolved) {
            return {
                content: [{
                    type: 'text',
                    text: `Unknown brand: "${brand}". Available brands: ${BRANDS.join(', ')}`
                }],
                isError: true
            };
        }

        const tab = tabName(resolved, 'Pages');
        let rows;
        try {
            rows = await getSheetRows(tab, 3);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                content: [{ type: 'text', text: `Failed to read sheet tab "${tab}": ${msg}` }],
                isError: true
            };
        }

        if (rows.length === 0) {
            return { content: [{ type: 'text', text: `No data found in tab: ${tab}` }] };
        }

        const [headers, ...dataRows] = rows;
        const filtered = keyword
            ? dataRows.filter(row => matchesKeyword(row, keyword))
            : dataRows;

        if (filtered.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `No pages found for brand "${resolved}"${keyword ? ` matching "${keyword}"` : ''}.`
                }]
            };
        }

        const output = {
            brand: resolved,
            tab,
            keyword: keyword ?? null,
            count: filtered.length,
            pages: rowsToObjects(headers, filtered)
        };

        return {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output
        };
    }
);

// Tool: search nav
server.registerTool(
    'sheets_search_nav',
    {
        title: 'Search Brand Navigation',
        description: `Search the Nav tab for a specific brand in the Boveda web management sheet.

Columns available: Nav Area, Link Label, URL, Status, Notes

Use this tool for queries like:
- "What is in the Skipper navigation?"
- "Show me all nav links for Vivi"
- "What is the URL for the Boveda Music main nav?"
- "Are there any inactive nav items for BovBiz?"

Args:
  - brand (string): Brand name, e.g. "Skipper", "Vivi", "BovBiz EU"
  - keyword (string, optional): Filter rows by keyword matched against any column

Returns: Array of matching nav rows with all columns.`,
        inputSchema: zod_1.z.object({
            brand: zod_1.z.string().describe('Brand name, e.g. "Skipper", "Vivi", "BovBiz EU"'),
            keyword: zod_1.z.string().optional().describe('Optional keyword to filter rows, matched against any column')
        }),
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false
        }
    },
    async ({ brand, keyword }) => {
        const resolved = normalizeBrand(brand);
        if (!resolved) {
            return {
                content: [{
                    type: 'text',
                    text: `Unknown brand: "${brand}". Available brands: ${BRANDS.join(', ')}`
                }],
                isError: true
            };
        }

        const tab = tabName(resolved, 'Nav');
        let rows;
        try {
            rows = await getSheetRows(tab, 2);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                content: [{ type: 'text', text: `Failed to read sheet tab "${tab}": ${msg}` }],
                isError: true
            };
        }

        if (rows.length === 0) {
            return { content: [{ type: 'text', text: `No data found in tab: ${tab}` }] };
        }

        const [headers, ...dataRows] = rows;
        const filtered = keyword
            ? dataRows.filter(row => matchesKeyword(row, keyword))
            : dataRows;

        if (filtered.length === 0) {
            return {
                content: [{
                    type: 'text',
                    text: `No nav items found for brand "${resolved}"${keyword ? ` matching "${keyword}"` : ''}.`
                }]
            };
        }

        const output = {
            brand: resolved,
            tab,
            keyword: keyword ?? null,
            count: filtered.length,
            nav: rowsToObjects(headers, filtered)
        };

        return {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output
        };
    }
);

// ── Start ─────────────────────────────────────────────────────────────────────
async function main() {
    const transport = new stdio_js_1.StdioServerTransport();
    await server.connect(transport);
    console.error('Boveda Sheets MCP server running (stdio)');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
