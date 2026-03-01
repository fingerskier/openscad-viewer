const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { parseStlBoundingBox, parseScadDependencies, openFile, cleanup } = require('../index.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SAMPLES_DIR = path.join(__dirname, '..', 'samples');
const EXAMPLE_STL = path.join(SAMPLES_DIR, 'example.stl');

/**
 * Build a minimal binary STL buffer with one triangle.
 * Binary STL: 80-byte header + 4-byte triangle count + N*50 bytes.
 */
function makeBinaryStl(triangles) {
  const header = Buffer.alloc(80, 0);
  const countBuf = Buffer.alloc(4);
  countBuf.writeUInt32LE(triangles.length, 0);

  const triBuffers = triangles.map(({ normal, vertices }) => {
    const buf = Buffer.alloc(50, 0);
    // normal (3 floats)
    buf.writeFloatLE(normal[0], 0);
    buf.writeFloatLE(normal[1], 4);
    buf.writeFloatLE(normal[2], 8);
    // 3 vertices (3 floats each)
    for (let v = 0; v < 3; v++) {
      buf.writeFloatLE(vertices[v][0], 12 + v * 12);
      buf.writeFloatLE(vertices[v][1], 12 + v * 12 + 4);
      buf.writeFloatLE(vertices[v][2], 12 + v * 12 + 8);
    }
    return buf;
  });

  return Buffer.concat([header, countBuf, ...triBuffers]);
}

// ---------------------------------------------------------------------------
// parseStlBoundingBox
// ---------------------------------------------------------------------------

describe('parseStlBoundingBox', () => {
  it('parses ASCII STL from sample file', () => {
    const buf = fs.readFileSync(EXAMPLE_STL);
    const { min, max } = parseStlBoundingBox(buf);

    assert.deepStrictEqual(min, [0, 0, 0]);
    assert.deepStrictEqual(max, [10, 10, 12]);
  });

  it('parses a minimal ASCII STL string', () => {
    const ascii = `solid test
  facet normal 0 0 1
    outer loop
      vertex 1 2 3
      vertex 4 5 6
      vertex 7 8 9
    endloop
  endfacet
endsolid test`;
    const buf = Buffer.from(ascii, 'utf8');
    const { min, max } = parseStlBoundingBox(buf);

    assert.deepStrictEqual(min, [1, 2, 3]);
    assert.deepStrictEqual(max, [7, 8, 9]);
  });

  it('parses a binary STL buffer', () => {
    const buf = makeBinaryStl([
      {
        normal: [0, 0, 1],
        vertices: [
          [-1, -2, -3],
          [4, 5, 6],
          [7, 8, 9],
        ],
      },
    ]);
    const { min, max } = parseStlBoundingBox(buf);

    assert.deepStrictEqual(min, [-1, -2, -3]);
    assert.deepStrictEqual(max, [7, 8, 9]);
  });

  it('handles binary STL with multiple triangles', () => {
    const buf = makeBinaryStl([
      {
        normal: [0, 0, 1],
        vertices: [
          [0, 0, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
      },
      {
        normal: [0, 0, -1],
        vertices: [
          [10, 10, 10],
          [20, 20, 20],
          [15, 15, 15],
        ],
      },
    ]);
    const { min, max } = parseStlBoundingBox(buf);

    assert.deepStrictEqual(min, [0, 0, 0]);
    assert.deepStrictEqual(max, [20, 20, 20]);
  });

  it('returns Infinity/-Infinity for empty buffer', () => {
    const { min, max } = parseStlBoundingBox(Buffer.alloc(0));

    assert.deepStrictEqual(min, [Infinity, Infinity, Infinity]);
    assert.deepStrictEqual(max, [-Infinity, -Infinity, -Infinity]);
  });

  it('returns Infinity/-Infinity for buffer too small for binary STL', () => {
    const { min, max } = parseStlBoundingBox(Buffer.alloc(50));

    assert.deepStrictEqual(min, [Infinity, Infinity, Infinity]);
    assert.deepStrictEqual(max, [-Infinity, -Infinity, -Infinity]);
  });
});

// ---------------------------------------------------------------------------
// parseScadDependencies
// ---------------------------------------------------------------------------

describe('parseScadDependencies', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for file with no includes', () => {
    const scadFile = path.join(tmpDir, 'no-deps.scad');
    fs.writeFileSync(scadFile, 'cube([10, 10, 10]);');

    const deps = parseScadDependencies(scadFile);
    assert.deepStrictEqual(deps, []);
  });

  it('finds include and use dependencies that exist on disk', () => {
    const libFile = path.join(tmpDir, 'lib.scad');
    fs.writeFileSync(libFile, 'module foo() { cube(1); }');

    const mainFile = path.join(tmpDir, 'main.scad');
    fs.writeFileSync(mainFile, 'include <lib.scad>\nuse <lib.scad>\ncube(1);');

    const deps = parseScadDependencies(mainFile);
    assert.strictEqual(deps.length, 2);
    assert.ok(deps.every((d) => d === libFile));
  });

  it('ignores dependencies that do not exist on disk', () => {
    const mainFile = path.join(tmpDir, 'missing-dep.scad');
    fs.writeFileSync(mainFile, 'include <nonexistent.scad>\ncube(1);');

    const deps = parseScadDependencies(mainFile);
    assert.deepStrictEqual(deps, []);
  });

  it('returns empty array for nonexistent source file', () => {
    const deps = parseScadDependencies('/tmp/does-not-exist-12345.scad');
    assert.deepStrictEqual(deps, []);
  });
});

// ---------------------------------------------------------------------------
// openFile
// ---------------------------------------------------------------------------

describe('openFile', () => {
  after(() => cleanup());

  it('opens a valid .stl file and returns metadata', async () => {
    const result = await openFile(EXAMPLE_STL);

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.file, EXAMPLE_STL);
    assert.ok(typeof result.fileSize === 'number');
    assert.ok(result.fileSize > 0);
    assert.ok(result.boundingBox);
    assert.deepStrictEqual(result.boundingBox.min, [0, 0, 0]);
    assert.deepStrictEqual(result.boundingBox.max, [10, 10, 12]);
  });

  it('throws for nonexistent file', async () => {
    await assert.rejects(
      () => openFile('/tmp/nonexistent-file-12345.stl'),
      (err) => {
        assert.ok(err.message.includes('File not found'));
        return true;
      },
    );
  });

  it('throws for unsupported file extension', async () => {
    const tmpFile = path.join(os.tmpdir(), 'test-file.obj');
    fs.writeFileSync(tmpFile, 'dummy');

    try {
      await assert.rejects(
        () => openFile(tmpFile),
        (err) => {
          assert.ok(err.message.includes('Unsupported file type'));
          return true;
        },
      );
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

// ---------------------------------------------------------------------------
// MCP server integration (tool listing and invocation via in-memory transport)
// ---------------------------------------------------------------------------

describe('MCP server integration', () => {
  let mcpServer;
  let client;
  let clientTransport;
  let serverTransport;

  before(async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { z } = await import('zod');

    // Create an MCP server identical to the one in index.js
    mcpServer = new McpServer({ name: 'openscad-viewer', version: '1.0.0' });

    mcpServer.tool(
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

    mcpServer.tool(
      'view',
      'Renders the current model at a specified camera angle and returns a screenshot image path',
      {
        azimuth: z.number().min(0).max(360).optional().describe('Horizontal angle in degrees (0-360). Default: 45'),
        elevation: z.number().min(-90).max(90).optional().describe('Vertical angle in degrees (-90 to 90). Default: 30'),
        distance: z.number().optional().describe('Distance from model center. Auto-calculated if omitted.'),
      },
      async () => {
        // In tests there is no browser, so view always returns an error
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No browser connected' }) }],
          isError: true,
        };
      },
    );

    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await mcpServer.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);
  });

  after(async () => {
    cleanup();
    await clientTransport?.close();
  });

  it('lists the expected tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    assert.deepStrictEqual(names, ['open', 'view']);
  });

  it('open tool has correct input schema', async () => {
    const { tools } = await client.listTools();
    const openTool = tools.find((t) => t.name === 'open');

    assert.ok(openTool);
    assert.strictEqual(openTool.description, 'Opens a .scad or .stl file in the viewer');
    assert.ok(openTool.inputSchema);
    assert.ok(openTool.inputSchema.properties.file);
  });

  it('view tool has correct input schema', async () => {
    const { tools } = await client.listTools();
    const viewTool = tools.find((t) => t.name === 'view');

    assert.ok(viewTool);
    assert.ok(viewTool.inputSchema.properties.azimuth);
    assert.ok(viewTool.inputSchema.properties.elevation);
    assert.ok(viewTool.inputSchema.properties.distance);
  });

  it('open tool succeeds with a valid STL file', async () => {
    const result = await client.callTool({ name: 'open', arguments: { file: EXAMPLE_STL } });

    assert.ok(!result.isError);
    const text = result.content[0].text;
    const parsed = JSON.parse(text);

    assert.strictEqual(parsed.success, true);
    assert.strictEqual(parsed.file, EXAMPLE_STL);
    assert.ok(parsed.fileSize > 0);
    assert.ok(parsed.boundingBox);
  });

  it('open tool returns error for nonexistent file', async () => {
    const result = await client.callTool({
      name: 'open',
      arguments: { file: '/tmp/nonexistent-mcp-test-file.stl' },
    });

    assert.strictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.success, false);
    assert.ok(parsed.error.includes('File not found'));
  });

  it('open tool returns error for unsupported file type', async () => {
    const tmpFile = path.join(os.tmpdir(), 'mcp-test.obj');
    fs.writeFileSync(tmpFile, 'dummy');

    try {
      const result = await client.callTool({ name: 'open', arguments: { file: tmpFile } });

      assert.strictEqual(result.isError, true);
      const parsed = JSON.parse(result.content[0].text);
      assert.ok(parsed.error.includes('Unsupported file type'));
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  it('view tool returns error when no browser is connected', async () => {
    const result = await client.callTool({
      name: 'view',
      arguments: { azimuth: 45, elevation: 30 },
    });

    assert.strictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.error);
  });
});
