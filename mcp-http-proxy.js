/**
 * mcp-http-proxy.js
 * Thin HTTP wrapper around the stdio MCP server.
 * Matches the pattern used by mediawiki-mcp.
 */

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 3001;
const API_KEY = process.env.MCP_API_KEY || '';
const SHEET_ID = process.env.SHEET_ID || '';
const GOOGLE_KEY_FILE = process.env.GOOGLE_KEY_FILE || '';

if (!API_KEY)        throw new Error('Missing MCP_API_KEY in .env');
if (!SHEET_ID)       throw new Error('Missing SHEET_ID in .env');
if (!GOOGLE_KEY_FILE) throw new Error('Missing GOOGLE_KEY_FILE in .env');

// Spawn the stdio MCP server process
const mcpProcess = spawn('node', [path.join(__dirname, 'dist/index.js')], {
    env: {
        ...process.env,
        SHEET_ID,
        GOOGLE_KEY_FILE
    },
    stdio: ['pipe', 'pipe', 'inherit']
});

mcpProcess.on('exit', (code) => {
    console.error(`MCP process exited with code ${code}`);
    process.exit(code ?? 1);
});

// Buffer for incomplete JSON responses from stdio
let responseBuffer = '';
const pendingRequests = new Map();

mcpProcess.stdout.on('data', (data) => {
    responseBuffer += data.toString();
    const lines = responseBuffer.split('\n');
    responseBuffer = lines.pop() ?? '';

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
            const json = JSON.parse(trimmed);
            const id = json.id;
            if (id !== undefined && pendingRequests.has(id)) {
                const { res } = pendingRequests.get(id);
                pendingRequests.delete(id);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(json));
            }
        } catch (e) {
            console.error('Failed to parse MCP response line:', trimmed);
        }
    }
});

// HTTP server
const server = http.createServer((req, res) => {   
     // Health check endpoint (no auth required)
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', transport: 'stdio-proxy' }));
        return;
    }
    // Auth check
    const authHeader = req.headers['authorization'] || '';
    if (authHeader !== `Bearer ${API_KEY}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Method not allowed' }));
        return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
        try {
            const payload = JSON.parse(body);
            const id = payload.id ?? Date.now();
            payload.id = id;

            pendingRequests.set(id, { res });

            // Timeout after 30s
            setTimeout(() => {
                if (pendingRequests.has(id)) {
                    pendingRequests.delete(id);
                    res.writeHead(504, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'MCP server timeout' }));
                }
            }, 30000);

            mcpProcess.stdin.write(JSON.stringify(payload) + '\n');
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
    });
});

server.listen(PORT, () => {
    console.log(`Boveda Sheets MCP HTTP proxy listening on port ${PORT}`);
    console.log(`Proxying to MCP server in stdio mode`);
    console.log(`Sheet ID: ${SHEET_ID}`);
});
