#!/usr/bin/env node

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const execFileAsync = promisify(execFile);
const PORT = 8439;

// Redirect all logging to stderr (stdout is reserved for MCP stdio transport)
const log = (...args) => process.stderr.write(`[openscad-viewer] ${args.join(' ')}\n`);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let currentFile = null;
let currentStlPath = null;
let currentStlBuffer = null;
let lastBoundingBox = null;
let watcher = null;
let debounceTimer = null;

const wsClients = new Set();
const pendingRequests = new Map();
let requestIdCounter = 0;

// ---------------------------------------------------------------------------
// OpenSCAD helpers
// ---------------------------------------------------------------------------

function checkOpenSCAD() {
  return new Promise((resolve) => {
    execFile('openscad', ['--version'], (err) => resolve(!err));
  });
}

async function compileScad(scadPath) {
  const tmpStl = path.join(os.tmpdir(), `openscad-viewer-${Date.now()}.stl`);
  try {
    await execFileAsync('openscad', ['-o', tmpStl, scadPath], { timeout: 60000 });
    return { stlPath: tmpStl, error: null };
  } catch (err) {
    return { stlPath: null, error: err.stderr || err.message };
  }
}

// ---------------------------------------------------------------------------
// STL bounding-box parser (binary + ASCII)
// ---------------------------------------------------------------------------

function parseStlBoundingBox(buffer) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  // Try binary STL
  if (buffer.length >= 84) {
    const numTriangles = buffer.readUInt32LE(80);
    const expectedSize = 84 + numTriangles * 50;

    if (numTriangles > 0 && buffer.length >= expectedSize) {
      for (let i = 0; i < numTriangles; i++) {
        const base = 84 + i * 50 + 12; // skip normal vector
        for (let v = 0; v < 3; v++) {
          const off = base + v * 12;
          const x = buffer.readFloatLE(off);
          const y = buffer.readFloatLE(off + 4);
          const z = buffer.readFloatLE(off + 8);
          min[0] = Math.min(min[0], x);  max[0] = Math.max(max[0], x);
          min[1] = Math.min(min[1], y);  max[1] = Math.max(max[1], y);
          min[2] = Math.min(min[2], z);  max[2] = Math.max(max[2], z);
        }
      }
      if (min[0] !== Infinity) return { min, max };
    }
  }

  // ASCII fallback
  const text = buffer.toString('utf8');
  const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const x = parseFloat(m[1]), y = parseFloat(m[2]), z = parseFloat(m[3]);
    min[0] = Math.min(min[0], x);  max[0] = Math.max(max[0], x);
    min[1] = Math.min(min[1], y);  max[1] = Math.max(max[1], y);
    min[2] = Math.min(min[2], z);  max[2] = Math.max(max[2], z);
  }
  return { min, max };
}

// ---------------------------------------------------------------------------
// Dependency parsing for .scad files
// ---------------------------------------------------------------------------

function parseScadDependencies(scadPath) {
  try {
    const content = fs.readFileSync(scadPath, 'utf8');
    const deps = [];
    const re = /(?:include|use)\s*<([^>]+)>/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      const dep = path.resolve(path.dirname(scadPath), m[1]);
      if (fs.existsSync(dep)) deps.push(dep);
    }
    return deps;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function sendAndWait(msg, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const requestId = ++requestIdCounter;
    msg.requestId = requestId;

    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error('Timeout waiting for browser response'));
    }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve(data) { clearTimeout(timer); pendingRequests.delete(requestId); resolve(data); },
      reject(err)   { clearTimeout(timer); pendingRequests.delete(requestId); reject(err); },
    });

    const data = JSON.stringify(msg);
    for (const ws of wsClients) {
      if (ws.readyState === 1) { ws.send(data); return; }
    }

    clearTimeout(timer);
    pendingRequests.delete(requestId);
    reject(new Error('No browser connected'));
  });
}

// ---------------------------------------------------------------------------
// File watcher
// ---------------------------------------------------------------------------

function setupWatcher(filePath) {
  if (watcher) watcher.close();

  const files = [filePath];
  if (path.extname(filePath).toLowerCase() === '.scad') {
    files.push(...parseScadDependencies(filePath));
  }

  watcher = chokidar.watch(files, { ignoreInitial: true });
  watcher.on('change', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => handleFileChange().catch(err => {
      log(`Watch handler error: ${err.message}`);
    }), 300);
  });
}

async function handleFileChange() {
  log(`File changed: ${currentFile}`);
  const ext = path.extname(currentFile).toLowerCase();

  if (ext === '.scad') {
    const result = await compileScad(currentFile);

    // Re-setup watcher (dependencies may have changed, even on errors)
    setupWatcher(currentFile);

    if (result.error) {
      log(`Compilation error: ${result.error}`);
      broadcast({ type: 'error', message: result.error });
      return;
    }
    currentStlPath = result.stlPath;
    currentStlBuffer = await fsp.readFile(result.stlPath);
    lastBoundingBox = parseStlBoundingBox(currentStlBuffer);
  } else {
    currentStlBuffer = await fsp.readFile(currentFile);
    lastBoundingBox = parseStlBoundingBox(currentStlBuffer);
  }

  broadcast({ type: 'model-updated' });
}

// ---------------------------------------------------------------------------
// Open a file (used by both CLI startup and MCP `open` tool)
// ---------------------------------------------------------------------------

async function openFile(filePath) {
  const absPath = path.resolve(filePath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  const ext = path.extname(absPath).toLowerCase();
  if (ext !== '.scad' && ext !== '.stl') {
    throw new Error(`Unsupported file type: ${ext}. Only .scad and .stl are supported.`);
  }

  if (ext === '.scad') {
    if (!(await checkOpenSCAD())) {
      throw new Error('OpenSCAD is not installed or not found on $PATH');
    }
    const result = await compileScad(absPath);
    if (result.error) {
      throw new Error(`OpenSCAD compilation failed:\n${result.error}`);
    }
    currentStlPath = result.stlPath;
    currentStlBuffer = await fsp.readFile(result.stlPath);
  } else {
    currentStlPath = absPath;
    currentStlBuffer = await fsp.readFile(absPath);
  }

  currentFile = absPath;
  lastBoundingBox = parseStlBoundingBox(currentStlBuffer);
  setupWatcher(absPath);

  broadcast({ type: 'model-updated' });
  broadcast({ type: 'file-info', filename: path.basename(absPath) });

  return {
    success: true,
    file: absPath,
    fileSize: fs.statSync(absPath).size,
    boundingBox: lastBoundingBox,
  };
}

// ---------------------------------------------------------------------------
// Open default browser (cross-platform, no extra dependency)
// ---------------------------------------------------------------------------

function openBrowser(url) {
  const { exec } = require('child_process');
  switch (process.platform) {
    case 'darwin':  exec(`open "${url}"`);       break;
    case 'win32':   exec(`start "" "${url}"`);   break;
    default:        exec(`xdg-open "${url}"`);   break;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);

  const filePath = args[0] || null;

  if (filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.scad' && !(await checkOpenSCAD())) {
      process.stderr.write(
        'Error: OpenSCAD is not installed or not found on $PATH.\n' +
        'Install OpenSCAD to view .scad files, or provide a .stl file instead.\n'
      );
      process.exit(1);
    }
  } else {
    log('No file specified — starting in standby mode. Use the "open" MCP tool to load a model.');
  }

  // ----- Express ----------------------------------------------------------
  const app = express();
  const server = http.createServer(app);

  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/model.stl', (_req, res) => {
    if (!currentStlBuffer) return res.status(404).send('No model loaded');
    res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.send(currentStlBuffer);
  });

  // ----- WebSocket --------------------------------------------------------
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    log('Browser connected');

    if (currentFile) {
      ws.send(JSON.stringify({ type: 'file-info', filename: path.basename(currentFile) }));
      ws.send(JSON.stringify({ type: 'model-updated' }));
    }

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.requestId && pendingRequests.has(msg.requestId)) {
          pendingRequests.get(msg.requestId).resolve(msg);
        }
      } catch (e) {
        log('Bad message from browser:', e.message);
      }
    });

    ws.on('close', () => { wsClients.delete(ws); log('Browser disconnected'); });
  });

  // ----- Start HTTP server ------------------------------------------------
  try {
    await new Promise((resolve, reject) => {
      server.on('error', (err) => {
        reject(err.code === 'EADDRINUSE'
          ? new Error(`Port ${PORT} is already in use`)
          : err);
      });
      server.listen(PORT, '127.0.0.1', resolve);
    });
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }

  log(`Server running at http://localhost:${PORT}`);

  // ----- Open initial file ------------------------------------------------
  if (filePath) {
    try {
      await openFile(filePath);
      log(`Opened: ${currentFile}`);
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(1);
    }
    openBrowser(`http://localhost:${PORT}`);
  }

  // ----- MCP server (stdio) ----------------------------------------------
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');

  const mcp = new McpServer({ name: 'openscad-viewer', version: '1.0.0' });

  mcp.tool(
    'open',
    'Opens a .scad or .stl file in the viewer',
    { file: z.string().describe('Absolute or relative path to a .scad or .stl file') },
    async ({ file }) => {
      try {
        const result = await openFile(file);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }],
          isError: true,
        };
      }
    },
  );

  mcp.tool(
    'view',
    'Renders the current model at a specified camera angle and returns a screenshot image path',
    {
      azimuth:   z.number().min(0).max(360).optional().describe('Horizontal angle in degrees (0-360). Default: 45'),
      elevation: z.number().min(-90).max(90).optional().describe('Vertical angle in degrees (-90 to 90). Default: 30'),
      distance:  z.number().optional().describe('Distance from model center. Auto-calculated if omitted.'),
    },
    async ({ azimuth, elevation, distance }) => {
      if (!currentFile) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No model currently loaded' }) }],
          isError: true,
        };
      }

      azimuth   = azimuth   ?? 45;
      elevation = elevation ?? 30;

      try {
        const response = await sendAndWait({
          type: 'set-camera',
          azimuth,
          elevation,
          distance: distance ?? null,
        });

        const base64 = response.dataUrl.replace(/^data:image\/png;base64,/, '');
        const tmpPath = path.join(os.tmpdir(), `openscad-viewer-capture-${Date.now()}.png`);
        await fsp.writeFile(tmpPath, base64, 'base64');

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              imagePath: tmpPath,
              camera: { azimuth, elevation, distance: response.distance || distance },
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log('MCP server ready on stdio');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Fatal error: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  parseStlBoundingBox,
  parseScadDependencies,
  openFile,
  cleanup() { if (watcher) { watcher.close(); watcher = null; } },
  main,
};
