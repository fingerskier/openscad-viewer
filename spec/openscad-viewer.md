# openscad-viewer Specification

A browser-based OpenSCAD model viewer with MCP tool integration, enabling AI agents to open and inspect 3D models while the user watches in real-time.

## Prerequisites

- **OpenSCAD** must be installed locally and available on `$PATH`. The application checks for this at startup and fails with a clear error message if not found. (Only required for `.scad` files — `.stl` files can be viewed without OpenSCAD.)
- **Node.js**

## Rendering Pipeline

**For `.scad` files:**
```
.scad file → OpenSCAD CLI → .stl (temp) → serve to browser → Three.js renders in 3D
```

1. Server receives a `.scad` file path
2. Server invokes `openscad -o /tmp/output.stl input.scad` to compile
3. Server serves the resulting STL to the browser via HTTP/WebSocket
4. Browser renders the STL using Three.js with orbit camera controls

**For `.stl` files:**
```
.stl file → serve directly to browser → Three.js renders in 3D
```

1. Server receives a `.stl` file path
2. Server serves the STL directly to the browser (no compilation)
3. Browser renders using Three.js — same viewer, same controls

## CLI

```
npx openscad-viewer <file.scad|file.stl>
```

- **File argument is required** — errors if not provided
- **Fixed port**: `8439` — fails if the port is already in use
- **Auto-opens** the default browser to `http://localhost:8439`
- Puts the filename in the browser title bar

## Browser UI

### 3D Viewport

- Three.js renderer displaying the compiled STL model
- Orbit-style camera controls: rotate, pan, zoom (OrbitControls)
- Default camera position: isometric view at a reasonable distance from the model bounding box

### Error Display

- On `.scad` compilation error: **keep the last successfully rendered model visible** and **overlay the OpenSCAD error message** (toast/banner) so the user sees both the last good state and what went wrong

### Title Bar

- Shows the opened file name

## MCP Tools (stdio transport)

The viewer process itself is the MCP server, communicating via stdin/stdout.

### `open`

Opens a `.scad` file in the viewer.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file` | string | yes | Absolute or relative path to a `.scad` or `.stl` file |

**Returns:**

```json
{
  "success": true,
  "file": "/absolute/path/to/model.scad",
  "fileSize": 2048,
  "boundingBox": { "min": [-10, -10, 0], "max": [10, 10, 20] }
}
```

**Errors:**

- File not found
- Unsupported file type (not `.scad` or `.stl`)
- OpenSCAD compilation failure (include the stderr output) — `.scad` only

### `view`

Renders the current model at a specified camera angle and returns an image.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `azimuth` | number | no | 45 | Horizontal angle in degrees (0-360) |
| `elevation` | number | no | 30 | Vertical angle in degrees (-90 to 90) |
| `distance` | number | no | auto | Distance from model center. Auto-calculated from bounding box if omitted. |

**Returns:**

Two content blocks:
1. An inline `image` content block (base64 PNG screenshot of the Three.js viewport)
2. A `text` content block with metadata JSON:

```json
{
  "imagePath": "/tmp/openscad-viewer-capture-xxxxx.png",
  "camera": { "azimuth": 45, "elevation": 30, "distance": 100 }
}
```

**Side effect:** The browser camera **animates smoothly** to the requested position, so the user sees what the agent is looking at.

**Errors:**

- No model currently loaded

## Real-Time Communication

**WebSocket** connection between server and browser for:

1. **Model updates**: When the STL is recompiled (due to file change or new `open`), push the new geometry to the browser
2. **Camera sync**: When an agent calls `view`, push the target camera position to the browser, which animates to it
3. **Error notifications**: Push compilation errors to the browser for overlay display

## File Watching

- Watch the opened file for changes
- **For `.scad` files**, also watch `include`/`use` dependencies — parse for `include <...>` and `use <...>` statements and watch those files too
- On any watched file change:
  - **`.scad`**: Re-run OpenSCAD CLI compilation. If successful, push new STL to browser. If error, push error message (keep last good model).
  - **`.stl`**: Re-serve the updated file directly to the browser.
- Debounce rapid changes (300ms) to avoid excessive recompilation

## Architecture

```
Node.js + Express + React

┌─────────────┐    stdio   ┌──────────────────┐   WebSocket   ┌─────────────┐
│   AI Agent  │◄──────────►│  Node.js Server  │◄─────────────►│   Browser   │
│ (MCP client)│            │  (Express + MCP) │               │  (React +   │
└─────────────┘            │                  │   HTTP/GET    │   Three.js) │
                           │  - file watcher   │──────────────►│             │
                           │  - OpenSCAD CLI  │   (STL files)  └─────────────┘
                           └──────────────────┘
```

## Scope Boundaries (Explicitly Out of Scope)

- Multiple simultaneous model files (one at a time only)
- Formats beyond `.scad` and `.stl` (no OBJ, 3MF, etc.)
- OpenSCAD customizer variable editing
- Lighting or material controls in the UI
- Remote/network access (localhost only)
