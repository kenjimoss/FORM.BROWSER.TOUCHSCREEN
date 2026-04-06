# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```bash
npm start
```

This launches the Electron desktop application.

## Architecture

**Tab Browser** is an Electron app where browser tabs are movable, resizable, shape-morphable windows positioned freely on a 2D workspace — like a spatial window manager.

**Process model:**
- `main.js` — Electron main process; creates the BrowserWindow with webview support enabled
- `renderer.js` — All app logic runs here (no preload script, context isolation is off)
- `index.html` — Shell UI: toolbar + `#workspace` container + `#tab-template` clone source
- `styles.css` — Dark theme styling; shapes use `clip-path` polygons and SVG masks

**Core abstraction: `TabWindow` class (`renderer.js`)**

Each tab is a `TabWindow` instance wrapping a cloned `#tab-template` DOM element containing a `<webview>`. Key state:
- `position` / `size` — absolute placement on `#workspace`
- `shape` — one of: `circle`, `rounded-rect`, `triangle`, `rectangle`, `pentagon`, `hexagon`
- `triangleVertices` — custom vertex positions (only for triangle shape)

**Interaction model:**
- Drag: click within the 10px border zone of a tab header area
- Resize: 8-directional from 5px edge zones
- Triangle vertex drag: Shift+click on a vertex handle
- Shape switching: Ctrl+1–6 (logged to console on startup)
- Delete active tab: Delete key

**Shape rendering:**
- Most shapes use CSS `clip-path: polygon(...)` — note this clips `box-shadow`, so shapes use `filter: drop-shadow()` instead
- Triangle shape uses an SVG mask element for proper border rendering
- Shape geometry is recalculated on every resize

**URL navigation:**
- Auto-prefixes `https://` if no protocol detected
- Falls back to Google search if input looks like a query

**Z-index layers:** toolbar=1000, active tab=100, dragging tab=200
