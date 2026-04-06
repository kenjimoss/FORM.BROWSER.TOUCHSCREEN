// DOM elements
const newTabBtn = document.getElementById('new-tab-btn');
const urlInput = document.getElementById('url-input');
const goBtn = document.getElementById('go-btn');
const workspace = document.getElementById('workspace');
const tabTemplate = document.getElementById('tab-template');

// Window controls
const { ipcRenderer } = require('electron');
document.getElementById('win-minimize').addEventListener('click', () => ipcRenderer.send('window-minimize'));
document.getElementById('win-maximize').addEventListener('click', () => ipcRenderer.send('window-maximize'));
document.getElementById('win-close').addEventListener('click', () => ipcRenderer.send('window-close'));

// App window resize via edge/corner handles
{
  const MIN_WIN_W = 600, MIN_WIN_H = 400;
  let winResizing = null;

  document.querySelectorAll('.win-resize-handle').forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      winResizing = {
        dir:         handle.dataset.dir,
        startMouseX: e.screenX,
        startMouseY: e.screenY,
        startX:      window.screenLeft,
        startY:      window.screenTop,
        startW:      window.outerWidth,
        startH:      window.outerHeight,
      };
    });
  });

  document.addEventListener('mousemove', (e) => {
    if (!winResizing) return;
    const { dir, startMouseX, startMouseY, startX, startY, startW, startH } = winResizing;
    const dx = e.screenX - startMouseX;
    const dy = e.screenY - startMouseY;
    let x = startX, y = startY, w = startW, h = startH;
    if (dir.includes('e')) w = Math.max(MIN_WIN_W, startW + dx);
    if (dir.includes('s')) h = Math.max(MIN_WIN_H, startH + dy);
    if (dir.includes('w')) { w = Math.max(MIN_WIN_W, startW - dx); x = startX + startW - w; }
    if (dir.includes('n')) { h = Math.max(MIN_WIN_H, startH - dy); y = startY + startH - h; }
    ipcRenderer.invoke('window-resize', { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
  });

  document.addEventListener('mouseup', () => { winResizing = null; });
}

// Desktop blur background
const desktopBlurBg = document.getElementById('desktop-blur-bg');
const BLUR_PADDING = 30;

async function updateDesktopBackground() {
  desktopBlurBg.style.backgroundImage = 'none';
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const { screenshot, displaySize, bounds } = await ipcRenderer.invoke('capture-desktop');
  desktopBlurBg.style.backgroundSize = `${displaySize.width}px ${displaySize.height}px`;
  desktopBlurBg.style.backgroundPosition = `${-bounds.x + BLUR_PADDING}px ${-bounds.y + BLUR_PADDING}px`;
  desktopBlurBg.style.backgroundImage = `url(${screenshot})`;
}

// Desktop blur disabled — workspace uses solid color background
// ipcRenderer.on('window-moved', updateDesktopBackground);
// window.addEventListener('load', () => setTimeout(updateDesktopBackground, 200));

// Maximize state — square corners when fullscreen
const browserContainer = document.querySelector('.browser-container');
ipcRenderer.on('window-maximized',   () => browserContainer.classList.add('maximized'));
ipcRenderer.on('window-unmaximized', () => browserContainer.classList.remove('maximized'));

// State
let tabs = [];
let activeTab = null;
let draggedTab = null;
let dragOffset = { x: 0, y: 0 };
let resizingTab = null;
let resizeData = { direction: null, startX: 0, startY: 0, startWidth: 0, startHeight: 0, startLeft: 0, startTop: 0 };
let vertexDraggingTab = null;
let tabIdCounter = 0;
let _zTop = 0; // monotonically increasing; each activate() call gets the next value
const undoStack = []; // entries: { type: 'merge', mergedTab } | { type: 'merge-add', mergedTab, tab } | { type: 'carve', snapshots }
const PORTFOLIO_URL = 'https://kenjimoss.github.io/portfolio/';

function parseStackZ(el) {
  if (!el) return 0;
  const z = parseInt(String(el.style.zIndex || '0'), 10);
  return Number.isFinite(z) ? z : 0;
}

/** Largest inline z-index among a tab entry (single window or merged group + chrome).
 *  Used by boolean-difference logic to determine which tab is "on top". */
function getEntryMaxStackZ(tab) {
  if (tab.tabs && tab.borderSvg) {
    let m = 0;
    for (const t of tab.tabs) m = Math.max(m, parseStackZ(t.element));
    m = Math.max(m, parseStackZ(tab.borderSvg), parseStackZ(tab.unmergeBtn));
    return m;
  }
  return parseStackZ(tab.element);
}

// Tab Window class
class TabWindow {
  constructor(url = 'https://kenjimoss.github.io/portfolio/') {
    this.id = ++tabIdCounter;
    this.url = url;
    this.title = 'New Tab';
    this.shape = 'rounded'; // default shape
    this.triangleVertices = null; // custom vertex positions for triangle shape
    this.pentagonVertices = null; // custom vertex positions for pentagon shape
    this.hexagonVertices = null; // custom vertex positions for hexagon shape
    this.rectangleVertices = null; // custom vertex positions for rectangle shape
    this.roundedVertices = null; // custom vertex positions for rounded-rect shape
    this.circleVertices = null; // custom vertex positions for distorted circle (polygon mode)
    this.holes = []; // punch-through holes cut by boolean difference; each entry is [{x,y}] in 0–1 normalized coords
    this.size = { width: 400, height: 400 };
    this.minSize = { width: 200, height: 150 };
    this.position = this.getRandomPosition();
    this.element = null;
    this.webview = null;
    this.vertexHandles = null; // transparent hit-target divs for triangle vertices
    this._edgePreviewDot  = null; // white dot shown on border when Ctrl is held (rounded only)
    this._edgePreviewData = null; // { x, y, edgeIndex, t } of current preview position
    this._ctrlKeyUpHandler   = null;
    this._ctrlOverlay        = null; // full-element overlay active while Ctrl is held (captures events above webview)
    this._ctrlKeyDownHandler = null;
    this._borderRing         = null; // ring-shaped overlay covering only the polygon border zone
    this._borderRingSvg      = null; // <svg><defs><clipPath> element for the border ring
    this.createElement();
    tabs.push(this);
    this.changeShape(this.shape);
  }

  // Returns the active vertex array for the current shape, or null for non-vertex shapes.
  // Setting it writes back to the correct shape-specific storage so per-shape distortions
  // are preserved when switching away and returning to a shape.
  get activeVertices() {
    if (this.shape === 'triangle') return this.triangleVertices;
    if (this.shape === 'pentagon') return this.pentagonVertices;
    if (this.shape === 'hexagon') return this.hexagonVertices;
    if (this.shape === 'rectangle') return this.rectangleVertices;
    if (this.shape === 'rounded') return this.roundedVertices;
    if (this.shape === 'circle') return this.circleVertices;
    return null;
  }

  set activeVertices(v) {
    if (this.shape === 'triangle') this.triangleVertices = v;
    else if (this.shape === 'pentagon') this.pentagonVertices = v;
    else if (this.shape === 'hexagon') this.hexagonVertices = v;
    else if (this.shape === 'rectangle') this.rectangleVertices = v;
    else if (this.shape === 'rounded') this.roundedVertices = v;
    else if (this.shape === 'circle') this.circleVertices = v;
  }

  get area() { return this.size.width * this.size.height; }

  getRandomPosition() {
    const workspaceWidth = workspace.offsetWidth || 1400;
    const workspaceHeight = workspace.offsetHeight || 800;
    const padding = 40;

    const maxX = workspaceWidth - this.size.width - padding * 2;
    const maxY = workspaceHeight - this.size.height - padding * 2;

    return {
      x: padding + Math.random() * Math.max(0, maxX),
      y: padding + Math.random() * Math.max(0, maxY)
    };
  }

  createElement() {
    // Clone the template
    const clone = tabTemplate.content.cloneNode(true);
    const tabEl = clone.querySelector('.tab-window');
    
    if (!tabEl) {
      console.error('Tab template not found!');
      return;
    }

    tabEl.dataset.tabId = this.id;
    tabEl.style.left = this.position.x + 'px';
    tabEl.style.top = this.position.y + 'px';
    tabEl.style.width = this.size.width + 'px';
    tabEl.style.height = this.size.height + 'px';
    
    // Add initial shape class
    tabEl.classList.add(`shape-${this.shape}`);

    tabEl.addEventListener('dragstart', (e) => e.preventDefault());

    const titleEl = tabEl.querySelector('.tab-title');
    if (titleEl) {
      titleEl.textContent = this.title;
    }

    // Get the webview element
    this.webview = tabEl.querySelector('.tab-webview');
    if (this.webview) {
      this.webview.src = this.url;
      // Send current shape to the portfolio once the page finishes loading.
      // changeShape() runs before the webview is ready, so the initial _sendShapeUpdate
      // call is lost — this re-delivers it after the page is live.
      this.webview.addEventListener('did-finish-load', () => {
        this._webviewReady = true;
        this._sendShapeUpdate();
      });
    }

    // Mousedown: vertex drag (shift+near vertex) > resize (near edge) > drag (border)
    tabEl.addEventListener('mousedown', (e) => {
      if (this.isMerged) return;
      if (e.target.classList.contains('tab-close')) return;
      this.activate();
      // Ctrl+rounded/circle/triangle/pentagon/hexagon: insert a new vertex on the hovered edge then immediately drag it
      if (e.ctrlKey && !e.shiftKey && (this.shape === 'rounded' || this.shape === 'circle' || this.shape === 'triangle' || this.shape === 'pentagon' || this.shape === 'hexagon') && this._edgePreviewData) {
        e.stopPropagation();
        e.preventDefault();
        const hit = this._edgePreviewData;
        if (this._edgePreviewDot) this._edgePreviewDot.style.display = 'none';
        this._edgePreviewData = null;
        if (this.shape === 'circle' && !this.circleVertices) {
          // First insertion on a pure CSS circle: build octagon + splice new vertex
          this._insertFirstCircleVertex(e, hit);
        } else {
          // Subsequent insertions on rounded, triangle, pentagon, hexagon, or already-polygonal circle
          const verts = (this.shape === 'circle'   ? this.circleVertices
                       : this.shape === 'triangle' ? this.triangleVertices
                       : this.shape === 'pentagon' ? this.pentagonVertices
                       : this.shape === 'hexagon'  ? this.hexagonVertices
                       : this.roundedVertices).slice();
          verts.splice(hit.edgeIndex + 1, 0, { x: hit.x, y: hit.y });
          if (this.shape === 'circle') this.circleVertices = verts;
          else if (this.shape === 'triangle') this.triangleVertices = verts;
          else if (this.shape === 'pentagon') this.pentagonVertices = verts;
          else if (this.shape === 'hexagon') this.hexagonVertices = verts;
          else this.roundedVertices = verts;
          this.removeVertexHandles();
          this.updateShapeClipPath();
          this.createVertexHandles();
          this.startVertexDrag(e, hit.edgeIndex + 1);
        }
        return;
      }
      if (e.shiftKey && this.activeVertices) {
        const vertexIndex = this.getActiveVertexAtPoint(e);
        if (vertexIndex !== null) {
          e.stopPropagation();
          this.startVertexDrag(e, vertexIndex);
          return;
        }
      }
      const direction = this.getEdgeDirection(e);
      if (direction) {
        e.stopPropagation();
        this.startResize(e, direction);
      } else if (this.isInBorderZone(e)) {
        this.startDrag(e);
      }
    });

    // Mousemove: update cursor based on vertex/edge/border proximity
    tabEl.addEventListener('mousemove', (e) => {
      if (draggedTab || resizingTab || vertexDraggingTab) {
        if (this._edgePreviewDot) this._edgePreviewDot.style.display = 'none';
        return;
      }
      // Ctrl+rounded/circle/triangle/pentagon/hexagon: track edge insertion preview dot along the polygon boundary
      if (e.ctrlKey && (this.shape === 'rounded' || this.shape === 'circle' || this.shape === 'triangle' || this.shape === 'pentagon' || this.shape === 'hexagon') && this._edgePreviewDot) {
        const rect = this.element.getBoundingClientRect();
        const hit  = this._getClosestEdgePoint(e.clientX - rect.left, e.clientY - rect.top);
        if (hit) {
          this._edgePreviewDot.style.display = 'block';
          this._edgePreviewDot.style.left = (hit.x * this.size.width)  + 'px';
          this._edgePreviewDot.style.top  = (hit.y * this.size.height) + 'px';
          this._edgePreviewData = hit;
          tabEl.style.cursor = 'crosshair';
          return;
        }
      }
      if (this._edgePreviewDot && this._edgePreviewDot.style.display !== 'none') {
        this._edgePreviewDot.style.display = 'none';
        this._edgePreviewData = null;
      }
      if (e.shiftKey && this.activeVertices) {
        const vertexIndex = this.getActiveVertexAtPoint(e);
        if (vertexIndex !== null) {
          tabEl.style.cursor = 'crosshair';
          return;
        }
      }
      const direction = this.getEdgeDirection(e);
      if (direction) {
        tabEl.style.cursor = TabWindow.CURSOR_MAP[direction];
      } else if (this.isInBorderZone(e)) {
        tabEl.style.cursor = 'move';
      } else {
        tabEl.style.cursor = 'default';
      }
    });

    // Hide edge preview dot when mouse leaves the tab element
    tabEl.addEventListener('mouseleave', () => {
      if (this._edgePreviewDot) {
        this._edgePreviewDot.style.display = 'none';
        this._edgePreviewData = null;
      }
    });

    // Give the element a z-index immediately so it doesn't flash behind existing
    // tabs for the one frame before activate() is called.
    tabEl.style.zIndex = String(_zTop + 1);

    // Append to workspace
    workspace.appendChild(tabEl);
    this.element = tabEl;

    // Drag strips: transparent overlays inside the border zone, stacked above the
    // webview, so the active webview doesn't swallow mousedown/mousemove events
    // near the window edge.  Events on the strips bubble to tabEl's existing
    // mousedown/mousemove handlers unchanged.
    //
    // DRAG_ZONE / BORDER_W are updated per-shape in changeShape().
    // Non-circle default (3px border): zone=10, border=3.
    // Circle (7px border): zone=24, border=7 — restored by changeShape('circle').
    // The strips are positioned within the padding-box (inside the CSS border),
    // so their size = DRAG_ZONE - BORDER_W to reach the same outer-edge distance.
    const DRAG_ZONE = 10;
    const BORDER_W  = 3;
    const iz = (DRAG_ZONE - BORDER_W) + 'px';
    this.dragStrips = [
      { top: '0', left: '0', right: '0', height: iz },   // top
      { bottom: '0', left: '0', right: '0', height: iz }, // bottom
      { top: '0', left: '0', bottom: '0', width: iz },    // left
      { top: '0', right: '0', bottom: '0', width: iz },   // right
    ].map(def => {
      const s = document.createElement('div');
      s.className = 'drag-strip';
      Object.assign(s.style, def);
      // While merged, block bubbling so the individual tab's drag handlers
      // don't fire (PolygonMergedTab owns drag for the combined window).
      s.addEventListener('mousedown', (e) => { if (this.isMerged) e.stopPropagation(); });
      s.addEventListener('mousemove',  (e) => { if (this.isMerged) e.stopPropagation(); });
      tabEl.appendChild(s);
      return s;
    });

    console.log(`Created tab ${this.id} at position`, this.position);
  }

  getEdgeDirection(e) {
    const rect = this.element.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const zone = this.shape === 'circle' ? 5 : 3;

    const nearN = y < zone;
    const nearS = y > h - zone;
    const nearW = x < zone;
    const nearE = x > w - zone;

    if (nearN && nearW) return 'nw';
    if (nearN && nearE) return 'ne';
    if (nearS && nearW) return 'sw';
    if (nearS && nearE) return 'se';
    if (nearN) return 'n';
    if (nearS) return 's';
    if (nearW) return 'w';
    if (nearE) return 'e';
    return null;
  }

  isInBorderZone(e) {
    const rect = this.element.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const border = this.shape === 'circle' ? 24 : 10;

    const v = this.activeVertices;
    if (v && !this._isRectangular(v)) {
      // Distorted shape: check distance to each polygon edge in element-local px coords
      const n = v.length;
      for (let i = 0; i < n; i++) {
        const a = v[i], b = v[(i + 1) % n];
        const ax = a.x * this.size.width,  ay = a.y * this.size.height;
        const bx = b.x * this.size.width,  by = b.y * this.size.height;
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lenSq));
        const nearX = ax + t * dx, nearY = ay + t * dy;
        if (Math.sqrt((x - nearX) ** 2 + (y - nearY) ** 2) <= border) return true;
      }
      return false;
    }

    return x < border || x > rect.width - border ||
           y < border || y > rect.height - border;
  }

  getActiveVertexAtPoint(e) {
    const verts = this.activeVertices;
    if (!verts) return null;
    // Use getBoundingClientRect() only for converting mouse coords to element-local space.
    // Vertex positions are derived from this.size (set synchronously by applyVertexLayout)
    // to avoid any stale-layout discrepancy with rect.width/rect.height.
    const rect = this.element.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const radius = 28;
    for (let i = 0; i < verts.length; i++) {
      const vx = verts[i].x * this.size.width;
      const vy = verts[i].y * this.size.height;
      const dist = Math.sqrt((mx - vx) ** 2 + (my - vy) ** 2);
      if (dist <= radius) return i;
    }
    return null;
  }

  // Returns true when a 4-vertex shape still has its corners at their initial positions
  // (i.e. it hasn't been distorted by vertex dragging yet).
  _isRectangular(v) {
    if (v.length !== 4) return false;
    const eps = 0.01;
    return Math.abs(v[0].x)     < eps && Math.abs(v[0].y)     < eps &&
           Math.abs(v[1].x - 1) < eps && Math.abs(v[1].y)     < eps &&
           Math.abs(v[2].x - 1) < eps && Math.abs(v[2].y - 1) < eps &&
           Math.abs(v[3].x)     < eps && Math.abs(v[3].y - 1) < eps;
  }

  // Render this tab when it has holes cut into it.
  // Uses an SVG <clipPath clip-rule="evenodd"> so the inner polygons subtract from
  // the outer shape, then updates the ::after border mask with outer + inner strokes.
  _updateClipPathWithHoles(v) {
    const svgNS  = 'http://www.w3.org/2000/svg';

    // Outer shape path in objectBoundingBox (0-1) space.
    // Undistorted circles have no activeVertices — approximate as 64-gon so that
    // clip-path: url(#...) produces a circle, not a rectangle.
    let outerPath;
    if (v) {
      outerPath = 'M ' + v.map(p => `${p.x.toFixed(5)},${p.y.toFixed(5)}`).join(' L ') + ' Z';
    } else if (this.shape === 'circle') {
      const pts = Array.from({ length: 64 }, (_, i) => {
        const a = 2 * Math.PI * i / 64;
        return `${(0.5 + 0.5 * Math.cos(a)).toFixed(5)},${(0.5 + 0.5 * Math.sin(a)).toFixed(5)}`;
      });
      outerPath = 'M ' + pts.join(' L ') + ' Z';
      // clip-path takes over from border-radius — clear it so they don't fight.
      this.element.style.borderRadius = '0';
    } else {
      outerPath = 'M 0,0 L 1,0 L 1,1 L 0,1 Z';
    }

    const holePaths = this.holes.map(hole =>
      'M ' + hole.map(p => `${p.x.toFixed(5)},${p.y.toFixed(5)}`).join(' L ') + ' Z'
    ).join(' ');

    // Ensure a hidden <defs> SVG container exists in the document.
    let defs = document.getElementById('tab-clip-defs');
    if (!defs) {
      const svg = document.createElementNS(svgNS, 'svg');
      svg.style.cssText = 'position:absolute;width:0;height:0;pointer-events:none;overflow:hidden;';
      defs = document.createElementNS(svgNS, 'defs');
      defs.id = 'tab-clip-defs';
      svg.appendChild(defs);
      document.body.appendChild(svg);
    }

    const clipId = `clip-tab-${this.id}`;
    let clipEl = document.getElementById(clipId);
    if (!clipEl) {
      clipEl = document.createElementNS(svgNS, 'clipPath');
      clipEl.id = clipId;
      clipEl.setAttribute('clipPathUnits', 'objectBoundingBox');
      defs.appendChild(clipEl);
    }
    let pathEl = clipEl.querySelector('path');
    if (!pathEl) {
      pathEl = document.createElementNS(svgNS, 'path');
      pathEl.setAttribute('clip-rule', 'evenodd');
      clipEl.appendChild(pathEl);
    }
    pathEl.setAttribute('d', outerPath + ' ' + holePaths);

    this.element.style.clipPath = `url(#${clipId})`;

    // ::after border mask — outer polygon stroke + one stroke per inner hole.
    // viewBox 0 0 100 100 so coordinates are percentages.
    const toSvg = (px, py) => `${(px * 100).toFixed(2)},${(py * 100).toFixed(2)}`;

    let svgShapes;
    if (v) {
      svgShapes = `<polygon points='${v.map(p => toSvg(p.x, p.y)).join(' ')}' fill='none' stroke='white' stroke-width='6' vector-effect='non-scaling-stroke'/>`;
    } else if (this.shape === 'circle') {
      const circPts = Array.from({ length: 64 }, (_, i) => {
        const a = 2 * Math.PI * i / 64;
        return toSvg(0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
      }).join(' ');
      svgShapes = `<polygon points='${circPts}' fill='none' stroke='white' stroke-width='6' vector-effect='non-scaling-stroke'/>`;
    } else {
      svgShapes = `<polygon points='0,0 100,0 100,100 0,100' fill='none' stroke='white' stroke-width='6' vector-effect='non-scaling-stroke'/>`;
    }

    for (const hole of this.holes) {
      svgShapes += `<polygon points='${hole.map(p => toSvg(p.x, p.y)).join(' ')}' fill='none' stroke='white' stroke-width='6' vector-effect='non-scaling-stroke'/>`;
    }

    const svgRaw     = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>${svgShapes}</svg>`;
    const svgEncoded = svgRaw.replace(/</g, '%3C').replace(/>/g, '%3E');
    const maskUrl    = `url("data:image/svg+xml,${svgEncoded}")`;

    let styleEl = document.getElementById(`tab-style-${this.id}`);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = `tab-style-${this.id}`;
      document.head.appendChild(styleEl);
    }
    const sel = `.tab-window.shape-${this.shape}[data-tab-id="${this.id}"]`;
    styleEl.textContent = [
      `${sel}::after { content:''; position:absolute; inset:-3px; z-index:5; pointer-events:none; background:#4d4d4d; -webkit-mask-size:100% 100%; mask-size:100% 100%; -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat; -webkit-mask-image:${maskUrl}; mask-image:${maskUrl}; }`,
      `${sel}.active::after { background:#333; }`,
    ].join('\n');
  }

  updateShapeClipPath() {
    const v = this.activeVertices;
    // Holes take priority: delegate to the SVG clip-path + evenodd renderer.
    if (this.holes.length > 0) { this._updateClipPathWithHoles(v); this._sendShapeUpdate(); return; }
    if (!v) return;

    // Vertex coords (0-1) are relative to the element's border-box.
    // The ::after has inset:-3px; with border-width:3px its outer edge aligns
    // exactly with the border-box, so no coordinate offset is needed (pad=0).
    // Using pad=0 places the SVG polygon at the same position as the clip-path
    // polygon, giving a uniform 3px inward stroke on all edges — including the
    // interior (concave) edges of L-shapes and notches from boolean difference.
    const pad = 0;
    const W = this.element.offsetWidth;
    const H = this.element.offsetHeight;
    const aw = W;
    const ah = H;

    let clipPathValue, svgShape;

    if (this.shape === 'rounded' && this._isRectangular(v)) {
      // Undistorted rounded rect: keep border-radius and use a rounded-rect SVG mask
      // so both the body and the border outline have smooth corners.
      // clip-path covers the full element (doesn't clip border-radius) — we need it
      // only so the ::after SVG mask mechanism activates correctly.
      this.element.style.borderRadius = '8px';
      clipPathValue = 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)';

      // rx/ry: 8px border-radius expressed in the ::after's 100×100 user-unit space.
      // With preserveAspectRatio='none', x and y scale independently, so we convert
      // each axis separately so the radius reads as 8px regardless of element size.
      const rx = (800 / aw).toFixed(4);
      const ry = (800 / ah).toFixed(4);
      const rx_ = (pad / aw * 100).toFixed(4);   // element left edge in ::after space
      const ry_ = (pad / ah * 100).toFixed(4);   // element top edge in ::after space
      const rw  = (W   / aw * 100).toFixed(4);
      const rh  = (H   / ah * 100).toFixed(4);
      svgShape = `<rect x='${rx_}' y='${ry_}' width='${rw}' height='${rh}' rx='${rx}' ry='${ry}' fill='none' stroke='white' stroke-width='6' vector-effect='non-scaling-stroke'/>`;
    } else {
      // General polygon (all non-rounded shapes, or rounded after vertex distortion).
      if (this.shape === 'rounded') this.element.style.borderRadius = '0';
      clipPathValue = `polygon(${v.map(p => `${p.x * 100}% ${p.y * 100}%`).join(', ')})`;
      const toSvgPt = (vx, vy) =>
        `${((vx * W + pad) / aw * 100).toFixed(4)},${((vy * H + pad) / ah * 100).toFixed(4)}`;
      svgShape = `<polygon points='${v.map(p => toSvgPt(p.x, p.y)).join(' ')}' fill='none' stroke='white' stroke-width='6' vector-effect='non-scaling-stroke'/>`;
    }

    this.element.style.clipPath = clipPathValue;

    const svgRaw = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' preserveAspectRatio='none'>${svgShape}</svg>`;
    const svgEncoded = svgRaw.replace(/</g, '%3C').replace(/>/g, '%3E');
    const maskUrl = `url("data:image/svg+xml,${svgEncoded}")`;
    let styleEl = document.getElementById(`tab-style-${this.id}`);
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = `tab-style-${this.id}`;
      document.head.appendChild(styleEl);
    }
    // Inject the complete ::after rule so any shape works without a matching CSS ::after block.
    // Two rules: base (default border color) and .active (highlighted border color).
    const sel = `.tab-window.shape-${this.shape}[data-tab-id="${this.id}"]`;
    styleEl.textContent = [
      `${sel}::after { content:''; position:absolute; inset:-3px; z-index:5; pointer-events:none; background:#4d4d4d; -webkit-mask-size:100% 100%; mask-size:100% 100%; -webkit-mask-repeat:no-repeat; mask-repeat:no-repeat; -webkit-mask-image:${maskUrl}; mask-image:${maskUrl}; }`,
      `${sel}.active::after { background:#333; }`,
    ].join('\n');

    this._updateBorderRing();
  }

  // Compute an inset polygon by moving each edge inward by d pixels, then finding
  // adjacent-edge intersections.  Returns normalized {x,y} vertices, or null if the
  // shape is too small to produce a valid inset.
  _computeInsetPolygon(verts, W, H, d) {
    const n = verts.length;
    const px = verts.map(v => ({ x: v.x * W, y: v.y * H }));

    // Centroid — used to pick the inward-facing normal direction for each edge.
    const cx = px.reduce((s, p) => s + p.x, 0) / n;
    const cy = px.reduce((s, p) => s + p.y, 0) / n;

    // Build an offset line for each edge: nx*x + ny*y = c
    const lines = [];
    for (let i = 0; i < n; i++) {
      const a = px[i], b = px[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len < 1e-9) { lines.push(null); continue; }
      // Unit normal (one of two perpendiculars)
      let nx = dy / len, ny = -dx / len;
      // Ensure it points inward (toward centroid)
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
      // Offset the line inward by d pixels: c = dot(n, a) + d
      lines.push({ nx, ny, c: nx * a.x + ny * a.y + d });
    }

    // Intersect consecutive offset lines to get inset vertices.
    const result = [];
    for (let i = 0; i < n; i++) {
      const l1 = lines[i];
      const l2 = lines[(i + 1) % n];
      if (!l1 || !l2) {
        result.push({ x: verts[(i + 1) % n].x, y: verts[(i + 1) % n].y });
        continue;
      }
      const det = l1.nx * l2.ny - l2.nx * l1.ny;
      if (Math.abs(det) < 1e-9) {
        // Parallel edges — use the next vertex unchanged
        result.push({ x: verts[(i + 1) % n].x, y: verts[(i + 1) % n].y });
        continue;
      }
      result.push({
        x: (l1.c * l2.ny - l2.c * l1.ny) / det / W,
        y: (l1.nx * l2.c - l2.nx * l1.c) / det / H,
      });
    }
    return result;
  }

  // Create or update the border-ring overlay that intercepts pointer events in the
  // ~10px zone along each polygon edge so distorted windows can still be dragged.
  // Inactive (pointer-events:none) for undistorted rectangular shapes.
  _updateBorderRing() {
    const v = this.activeVertices;

    // Only needed when the shape is a distorted (non-rectangular) polygon.
    if (!v || this._isRectangular(v)) {
      if (this._borderRing) this._borderRing.style.pointerEvents = 'none';
      return;
    }

    const W = this.size.width, H = this.size.height;
    const d = 10; // border zone width in pixels

    const inset = this._computeInsetPolygon(v, W, H, d);
    if (!inset || inset.length < 3) {
      if (this._borderRing) this._borderRing.style.pointerEvents = 'none';
      return;
    }

    // Lazily create the ring div and its SVG clip-path element.
    if (!this._borderRing) {
      const ringEl = document.createElement('div');
      ringEl.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:12;pointer-events:none;background:transparent;';
      this.element.appendChild(ringEl);
      this._borderRing = ringEl;
    }

    if (!this._borderRingSvg) {
      const svgNS = 'http://www.w3.org/2000/svg';
      const svgEl = document.createElementNS(svgNS, 'svg');
      svgEl.setAttribute('style', 'position:absolute;width:0;height:0;overflow:visible;pointer-events:none;');
      svgEl.setAttribute('aria-hidden', 'true');
      const defs = document.createElementNS(svgNS, 'defs');
      const clip = document.createElementNS(svgNS, 'clipPath');
      clip.setAttribute('id', `brc-${this.id}`);
      clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
      defs.appendChild(clip);
      svgEl.appendChild(defs);
      this.element.appendChild(svgEl);
      this._borderRingSvg = svgEl;
      this._borderRing.style.clipPath = `url(#brc-${this.id})`;
    }

    // Build the ring path: outer polygon + inner polygon (even-odd creates the hole).
    const toPoints = pts => pts.map(p => `${(p.x * W).toFixed(2)} ${(p.y * H).toFixed(2)}`).join(' L ');
    const pathD = `M ${toPoints(v)} Z M ${toPoints(inset)} Z`;

    const ringClip = this._borderRingSvg.querySelector('clipPath');
    ringClip.innerHTML = '';
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('clip-rule', 'evenodd');
    path.setAttribute('d', pathD);
    ringClip.appendChild(path);

    this._borderRing.style.pointerEvents = 'auto';
  }

  // Convert normalized vertices to absolute workspace pixel positions
  verticesToAbsolute() {
    return this.activeVertices.map(v => ({
      x: this.position.x + v.x * this.size.width,
      y: this.position.y + v.y * this.size.height
    }));
  }

  // Given absolute workspace positions for all vertices, resize/reposition the
  // element so all vertices fit inside it, then recompute normalized coords.
  applyVertexLayout(absVertices) {
    console.log('[LAYOUT] applyVertexLayout — tab', this.id, 'shape:', this.shape, 'vertices:', absVertices.length);
    // Capture old bbox before any update so we can renormalize holes below.
    const oldX = this.position.x, oldY = this.position.y;
    const oldW = this.size.width,  oldH = this.size.height;

    const pad = 4; // match border width so vertices sit at the visual edge
    const xs = absVertices.map(v => v.x);
    const ys = absVertices.map(v => v.y);
    let minX = Math.min(...xs) - pad;
    let minY = Math.min(...ys) - pad;
    let maxX = Math.max(...xs) + pad;
    let maxY = Math.max(...ys) + pad;

    // Clamp to workspace bounds
    const wsW = workspace.offsetWidth;
    const wsH = workspace.offsetHeight;
    minX = Math.max(0, minX);
    minY = Math.max(0, minY);
    maxX = Math.min(wsW, maxX);
    maxY = Math.min(wsH, maxY);

    const newW = Math.max(this.minSize.width, maxX - minX);
    const newH = Math.max(this.minSize.height, maxY - minY);

    this.position.x = minX;
    this.position.y = minY;
    this.size.width = newW;
    this.size.height = newH;
    this.element.style.left = minX + 'px';
    this.element.style.top = minY + 'px';
    this.element.style.width = newW + 'px';
    this.element.style.height = newH + 'px';

    // Recompute normalized vertex positions relative to the new element bounds
    this.activeVertices = absVertices.map(v => ({
      x: (v.x - minX) / newW,
      y: (v.y - minY) / newH
    }));

    // Renormalize any holes to the new bounding box.
    if (this.holes.length > 0) {
      this.holes = this.holes.map(hole => hole.map(p => ({
        x: (oldX + p.x * oldW - minX) / newW,
        y: (oldY + p.y * oldH - minY) / newH,
      })));
    }

    this.updateShapeClipPath();
    this.updateVertexHandles();
    this._sendShapeUpdate();
  }

  _sendShapeUpdate() {
    if (!this.webview) return;
    if (!this._webviewReady) return;
    // For an undistorted CSS circle, activeVertices is null. Generate a 64-gon
    // ellipse approximation in normalized (0-1) coords so the portfolio knows
    // to clip the grid to the circular shape.
    let vertices = this.activeVertices;
    if (!vertices && this.shape === 'circle') {
      const N = 64;
      vertices = Array.from({ length: N }, (_, i) => {
        const a = 2 * Math.PI * i / N;
        return { x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) };
      });
    }
    const payload = JSON.stringify({
      shape: this.shape,
      vertices,
      holes: this.holes.length > 0 ? this.holes : null,
      width: this.size.width,
      height: this.size.height,
    });
    this.webview.executeJavaScript(
      `window.__shapeUpdate && window.__shapeUpdate(${payload})`
    );
  }

  // Create transparent hit-target divs positioned at each vertex of the current shape.
  // These sit above the webview (z-index 20) so Shift+clicks on them reach the
  // host document even though the webview would otherwise swallow the events.
  // (After applyVertexLayout, vertices land at the content-area boundary — exactly
  // where the webview starts — so without handles, mousedown on tabEl never fires.)
  createVertexHandles() {
    const verts = this.activeVertices;
    if (!verts) return;
    this.vertexHandles = verts.map((_, i) => {
      const h = document.createElement('div');
      h.style.cssText = [
        'position:absolute',
        'width:56px',
        'height:56px',
        'border-radius:50%',
        'z-index:20',
        'transform:translate(-50%,-50%)',
        'cursor:default',
      ].join(';');

      h.addEventListener('mousemove', (e) => {
        h.style.cursor = e.shiftKey ? 'crosshair' : 'default';
      });

      h.addEventListener('mousedown', (e) => {
        this.activate();
        if (!e.shiftKey || !this.activeVertices) return;
        e.stopPropagation();
        this.startVertexDrag(e, i);
      });

      this.element.appendChild(h);
      return h;
    });
    this.updateVertexHandles();
  }

  // Reposition handles to match current vertex coordinates.
  updateVertexHandles() {
    const verts = this.activeVertices;
    if (!this.vertexHandles || !verts) return;
    this.vertexHandles.forEach((h, i) => {
      h.style.left = (verts[i].x * this.size.width) + 'px';
      h.style.top  = (verts[i].y * this.size.height) + 'px';
    });
  }

  removeVertexHandles() {
    if (!this.vertexHandles) return;
    this.vertexHandles.forEach(h => h.remove());
    this.vertexHandles = null;
  }

  // ── Edge-preview dot (Ctrl+rounded vertex insertion) ─────────────────────

  // Creates the small white dot that previews where a new vertex will be inserted.
  // Also creates a transparent full-element overlay that activates on Ctrl keydown so that
  // mouse events on non-border areas (e.g. triangle slanted edges) are captured by the host
  // document instead of being swallowed by the <webview>.
  _createEdgePreviewDot() {
    if (this._edgePreviewDot) return;
    const dot = document.createElement('div');
    dot.style.cssText = [
      'position:absolute',
      'width:14px',
      'height:14px',
      'border-radius:50%',
      'background:white',
      'box-shadow:0 0 0 2px rgba(0,0,0,0.55)',
      'z-index:25',
      'transform:translate(-50%,-50%)',
      'pointer-events:none',
      'display:none',
    ].join(';');
    this.element.appendChild(dot);
    this._edgePreviewDot  = dot;
    this._edgePreviewData = null;

    // Transparent overlay sits above webview (z-index 11) but below vertex handles (z-index 20).
    // Inactive (pointer-events:none) normally; enabled while Ctrl is held so that mousemove
    // and mousedown on the interior of the element reach the tabEl listener chain.
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:11;pointer-events:none;';
    this.element.appendChild(overlay);
    this._ctrlOverlay = overlay;

    this._ctrlKeyDownHandler = (ev) => {
      if (ev.key === 'Control' && this._ctrlOverlay) {
        this._ctrlOverlay.style.pointerEvents = 'auto';
      }
    };
    this._ctrlKeyUpHandler = (ev) => {
      if (ev.key === 'Control') {
        if (this._edgePreviewDot) {
          this._edgePreviewDot.style.display = 'none';
          this._edgePreviewData = null;
        }
        if (this._ctrlOverlay) this._ctrlOverlay.style.pointerEvents = 'none';
      }
    };
    document.addEventListener('keydown', this._ctrlKeyDownHandler);
    document.addEventListener('keyup',   this._ctrlKeyUpHandler);
  }

  _removeEdgePreviewDot() {
    if (this._edgePreviewDot) {
      this._edgePreviewDot.remove();
      this._edgePreviewDot  = null;
      this._edgePreviewData = null;
    }
    if (this._ctrlOverlay) {
      this._ctrlOverlay.remove();
      this._ctrlOverlay = null;
    }
    if (this._ctrlKeyDownHandler) {
      document.removeEventListener('keydown', this._ctrlKeyDownHandler);
      this._ctrlKeyDownHandler = null;
    }
    if (this._ctrlKeyUpHandler) {
      document.removeEventListener('keyup', this._ctrlKeyUpHandler);
      this._ctrlKeyUpHandler = null;
    }
  }

  // Projects (mx, my) in element-local px onto the shape boundary.
  // For a pure CSS circle (no circleVertices yet): projects onto the ellipse and returns
  //   { x, y, angle, edgeIndex: null }.
  // For rounded or an already-polygonal circle: projects onto polygon edges and returns
  //   { x, y, edgeIndex, t }, excluding points too near existing vertices.
  _getClosestEdgePoint(mx, my) {
    const W = this.size.width, H = this.size.height;
    const SNAP_PX      = 14;   // max px from shape boundary to show dot
    const VERTEX_GUARD = 0.08; // exclude t within this fraction of either endpoint

    // Pure CSS circle (no polygon vertices yet): project mouse onto ellipse boundary
    if (this.shape === 'circle' && !this.circleVertices) {
      const cx = W / 2, cy = H / 2;
      const rx = W / 2, ry = H / 2;
      const angle = Math.atan2((my - cy) / ry, (mx - cx) / rx);
      const px = cx + rx * Math.cos(angle);
      const py = cy + ry * Math.sin(angle);
      if (Math.hypot(mx - px, my - py) > SNAP_PX) return null;
      return { x: px / W, y: py / H, angle, edgeIndex: null };
    }

    // Polygon-edge projection (triangle, pentagon, hexagon, rounded, or distorted circle with circleVertices)
    const verts = this.shape === 'circle'   ? this.circleVertices
                : this.shape === 'triangle' ? this.triangleVertices
                : this.shape === 'pentagon' ? this.pentagonVertices
                : this.shape === 'hexagon'  ? this.hexagonVertices
                : this.roundedVertices;
    if (!verts) return null;
    let best = null, bestDist = SNAP_PX;
    for (let i = 0; i < verts.length; i++) {
      const j  = (i + 1) % verts.length;
      const ax = verts[i].x * W, ay = verts[i].y * H;
      const bx = verts[j].x * W, by = verts[j].y * H;
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1) continue;
      const t = Math.max(0, Math.min(1, ((mx - ax) * dx + (my - ay) * dy) / lenSq));
      if (t < VERTEX_GUARD || t > 1 - VERTEX_GUARD) continue;
      const px = ax + t * dx, py = ay + t * dy;
      const dist = Math.hypot(mx - px, my - py);
      if (dist < bestDist) {
        bestDist = dist;
        best = { x: px / W, y: py / H, edgeIndex: i, t };
      }
    }
    return best;
  }

  // Called on the first Ctrl+drag on a pure CSS circle.
  // Builds an 8-point octagon approximating the circle, splices the new vertex in
  // at the correct edge, switches to polygon rendering, and starts the vertex drag.
  _insertFirstCircleVertex(e, hit) {
    const N = 32;
    const poly = [];
    for (let i = 0; i < N; i++) {
      const theta = (2 * Math.PI * i) / N - Math.PI / 2; // start at top, clockwise
      poly.push({ x: 0.5 + 0.5 * Math.cos(theta), y: 0.5 + 0.5 * Math.sin(theta) });
    }
    // Map hit.angle (standard atan2: 0=right, π/2=down) to polygon edge index.
    // Polygon starts at top (-π/2), so shift and wrap to [0, 2π) then bucket into N edges.
    const a = ((hit.angle + Math.PI / 2) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    const edgeIndex = Math.floor(a / (2 * Math.PI / N)) % N;
    poly.splice(edgeIndex + 1, 0, { x: hit.x, y: hit.y });
    this.circleVertices = poly;
    // Switch from CSS circle to polygon rendering
    this.element.style.borderRadius = '0';
    this.element.style.borderColor = 'transparent';
    this.element.style.boxShadow = 'none';
    this.element.style.filter = 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.3))';
    this.element.style.transition = 'box-shadow 0.2s, transform 0.2s, filter 0.2s';
    this.updateShapeClipPath();
    this.createVertexHandles();
    this.startVertexDrag(e, edgeIndex + 1);
  }

  startVertexDrag(e, vertexIndex) {
    e.preventDefault();
    e.stopPropagation();
    const instance = this;
    vertexDraggingTab = instance;
    if (instance.webview) instance.webview.style.pointerEvents = 'none';

    // Convert all vertices to absolute workspace coords at drag start
    const absVertices = instance.verticesToAbsolute();

    const onMouseMove = (e) => {
      e.preventDefault();
      if (vertexDraggingTab !== instance) return;
      const workspaceRect = workspace.getBoundingClientRect();
      absVertices[vertexIndex] = {
        x: e.clientX - workspaceRect.left,
        y: e.clientY - workspaceRect.top
      };
      instance.applyVertexLayout(absVertices);
    };

    const onMouseUp = (e) => {
      e.preventDefault();
      e.stopPropagation();
      vertexDraggingTab = null;
      if (instance.webview) instance.webview.style.pointerEvents = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  startDrag(e) {
    e.preventDefault();
    e.stopPropagation();
    const draggedInstance = this;
    draggedTab = draggedInstance;
    draggedInstance.element.classList.add('dragging');

    // Disable webview pointer events so it doesn't swallow mouseup
    if (draggedInstance.webview) {
      draggedInstance.webview.style.pointerEvents = 'none';
    }

    const rect = draggedInstance.element.getBoundingClientRect();
    dragOffset.x = e.clientX - rect.left;
    dragOffset.y = e.clientY - rect.top;

    const onMouseMove = (e) => {
      e.preventDefault();
      if (draggedTab !== draggedInstance) return;
      const workspaceRect = workspace.getBoundingClientRect();
      const x = e.clientX - workspaceRect.left - dragOffset.x;
      const y = e.clientY - workspaceRect.top - dragOffset.y;
      draggedInstance.updatePosition(x, y);
      if (e.shiftKey) {
        highlightMergeCandidate(draggedInstance);
      } else {
        clearMergeHighlight();
      }
    };

    const onMouseUp = (e) => {
      e.preventDefault();
      e.stopPropagation();
      draggedTab = null;
      draggedInstance.element.classList.remove('dragging');
      draggedInstance.element.style.cursor = '';
      // Re-enable webview pointer events
      if (draggedInstance.webview) {
        draggedInstance.webview.style.pointerEvents = '';
      }
      clearMergeHighlight();
      if (e.shiftKey) checkForMerge(draggedInstance);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  startResize(e, direction) {
    e.preventDefault();
    const resizeInstance = this;
    resizingTab = resizeInstance;
    resizeInstance.element.classList.add('resizing');

    // Disable webview pointer events so it doesn't swallow mouseup
    if (resizeInstance.webview) {
      resizeInstance.webview.style.pointerEvents = 'none';
    }

    resizeData.direction = direction;
    resizeData.startX = e.clientX;
    resizeData.startY = e.clientY;
    resizeData.startWidth = resizeInstance.size.width;
    resizeData.startHeight = resizeInstance.size.height;
    resizeData.startLeft = resizeInstance.position.x;
    resizeData.startTop = resizeInstance.position.y;

    const onMouseMove = (e) => {
      e.preventDefault();
      if (resizingTab !== resizeInstance) return;
      const deltaX = e.clientX - resizeData.startX;
      const deltaY = e.clientY - resizeData.startY;
      resizeInstance.handleResize(deltaX, deltaY, resizeData.direction);
    };

    const onMouseUp = (e) => {
      e.preventDefault();
      e.stopPropagation();
      resizingTab = null;
      resizeInstance.element.classList.remove('resizing');
      resizeInstance.element.style.cursor = '';
      // Re-enable webview pointer events
      if (resizeInstance.webview) {
        resizeInstance.webview.style.pointerEvents = '';
      }
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  handleResize(deltaX, deltaY, direction) {
    let newWidth = resizeData.startWidth;
    let newHeight = resizeData.startHeight;
    let newLeft = resizeData.startLeft;
    let newTop = resizeData.startTop;

    // Calculate new dimensions based on direction
    if (direction.includes('e')) {
      newWidth = Math.max(this.minSize.width, resizeData.startWidth + deltaX);
    }
    if (direction.includes('w')) {
      const widthChange = Math.min(deltaX, resizeData.startWidth - this.minSize.width);
      newWidth = resizeData.startWidth - widthChange;
      newLeft = resizeData.startLeft + widthChange;
    }
    if (direction.includes('s')) {
      newHeight = Math.max(this.minSize.height, resizeData.startHeight + deltaY);
    }
    if (direction.includes('n')) {
      const heightChange = Math.min(deltaY, resizeData.startHeight - this.minSize.height);
      newHeight = resizeData.startHeight - heightChange;
      newTop = resizeData.startTop + heightChange;
    }

    // Keep within workspace bounds
    const workspaceWidth = workspace.offsetWidth;
    const workspaceHeight = workspace.offsetHeight;

    if (newLeft < 0) {
      newWidth += newLeft;
      newLeft = 0;
    }
    if (newTop < 0) {
      newHeight += newTop;
      newTop = 0;
    }
    if (newLeft + newWidth > workspaceWidth) {
      newWidth = workspaceWidth - newLeft;
    }
    if (newTop + newHeight > workspaceHeight) {
      newHeight = workspaceHeight - newTop;
    }

    // Apply changes
    this.position.x = newLeft;
    this.position.y = newTop;
    this.size.width = newWidth;
    this.size.height = newHeight;

    this.element.style.left = this.position.x + 'px';
    this.element.style.top = this.position.y + 'px';
    this.element.style.width = this.size.width + 'px';
    this.element.style.height = this.size.height + 'px';
  }

  activate() {
    tabs.forEach(tab => {
      if (tab.tabs && tab.borderSvg) {
        tab.tabs.forEach(t => t.element.classList.remove('active'));
      } else if (tab.element) {
        tab.element.classList.remove('active');
      }
    });

    this.element.classList.add('active');
    activeTab = this;
    urlInput.value = this.url;

    this.element.style.zIndex = String(++_zTop);

    console.log(`Activated tab ${this.id}: ${this.title}`);
  }

  updatePosition(x, y) {
    const workspaceWidth = workspace.offsetWidth;
    const workspaceHeight = workspace.offsetHeight;
    const tabWidth = this.element.offsetWidth;
    const tabHeight = this.element.offsetHeight;

    // Keep within bounds
    this.position.x = Math.max(0, Math.min(x, workspaceWidth - tabWidth));
    this.position.y = Math.max(0, Math.min(y, workspaceHeight - tabHeight));

    this.element.style.left = this.position.x + 'px';
    this.element.style.top = this.position.y + 'px';
  }

  updateUrl(newUrl) {
    this.url = newUrl;
    if (this.webview) {
      this.webview.src = newUrl;
    }
  }

  updateTitle(newTitle) {
    this.title = newTitle;
    const titleEl = this.element.querySelector('.tab-title');
    if (titleEl) {
      titleEl.textContent = newTitle;
    }
  }

  changeShape(newShape) {
    // Leaving a vertex-draggable shape: clear clip-path, injected style, inline overrides, and handles.
    // Clearing borderColor/boxShadow/filter/borderRadius/transition is a no-op for polygon shapes
    // (those are set by CSS class, not inline) but is required for rectangle/rounded which set them inline.
    this._removeEdgePreviewDot();
    if (this.activeVertices) {
      this.element.style.clipPath = '';
      this.element.style.borderColor = '';
      this.element.style.boxShadow = '';
      this.element.style.filter = '';
      this.element.style.borderRadius = '';
      this.element.style.transition = '';
      const styleEl = document.getElementById(`tab-style-${this.id}`);
      if (styleEl) styleEl.remove();
      this.removeVertexHandles();
    }

    this.element.classList.remove(`shape-${this.shape}`);
    this.shape = newShape;
    this.element.classList.add(`shape-${newShape}`);

    // Entering a vertex-draggable shape: init default vertices or restore saved ones, then create handles
    if (newShape === 'triangle') {
      if (!this.triangleVertices) {
        this.triangleVertices = [{ x: 0.5, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
      }
      this.updateShapeClipPath();
      this.createVertexHandles();
      this._createEdgePreviewDot();
    } else if (newShape === 'pentagon') {
      if (!this.pentagonVertices) {
        this.pentagonVertices = [
          { x: 0.5,  y: 0 },
          { x: 1.0,  y: 0.38 },
          { x: 0.82, y: 1.0 },
          { x: 0.18, y: 1.0 },
          { x: 0.0,  y: 0.38 },
        ];
      }
      this.updateShapeClipPath();
      this.createVertexHandles();
      this._createEdgePreviewDot();
    } else if (newShape === 'hexagon') {
      if (!this.hexagonVertices) {
        this.hexagonVertices = [
          { x: 0.25, y: 0 },
          { x: 0.75, y: 0 },
          { x: 1.0,  y: 0.5 },
          { x: 0.75, y: 1.0 },
          { x: 0.25, y: 1.0 },
          { x: 0.0,  y: 0.5 },
        ];
      }
      this.updateShapeClipPath();
      this.createVertexHandles();
      this._createEdgePreviewDot();
    } else if (newShape === 'rectangle') {
      if (!this.rectangleVertices) {
        this.rectangleVertices = [
          { x: 0, y: 0 }, { x: 1, y: 0 },
          { x: 1, y: 1 }, { x: 0, y: 1 },
        ];
      }
      // Rectangle normally uses CSS border+box-shadow. Switch to filter+SVG-mask so
      // clip-path (required for arbitrary-quad distortion) doesn't clip the shadow.
      this.element.style.borderColor = 'transparent';
      this.element.style.boxShadow = 'none';
      this.element.style.filter = 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.3))';
      this.element.style.transition = 'box-shadow 0.2s, transform 0.2s, filter 0.2s';
      this.updateShapeClipPath();
      this.createVertexHandles();
    } else if (newShape === 'rounded') {
      if (!this.roundedVertices) {
        this.roundedVertices = [
          { x: 0, y: 0 }, { x: 1, y: 0 },
          { x: 1, y: 1 }, { x: 0, y: 1 },
        ];
      }
      // Rounded-rect: same treatment as rectangle for border/shadow.
      // Border-radius is managed by updateShapeClipPath() — it keeps 8px while
      // vertices are at their default corners and drops to 0 after distortion.
      this.element.style.borderColor = 'transparent';
      this.element.style.boxShadow = 'none';
      this.element.style.filter = 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.3))';
      this.element.style.transition = 'box-shadow 0.2s, transform 0.2s, filter 0.2s';
      this.updateShapeClipPath();
      this.createVertexHandles();
      this._createEdgePreviewDot();
    } else if (newShape === 'circle') {
      // If the circle was previously distorted into a polygon, restore polygon rendering
      if (this.circleVertices) {
        this.element.style.borderRadius = '0';
        this.element.style.borderColor = 'transparent';
        this.element.style.boxShadow = 'none';
        this.element.style.filter = 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.3))';
        this.element.style.transition = 'box-shadow 0.2s, transform 0.2s, filter 0.2s';
        this.updateShapeClipPath();
        this.createVertexHandles();
      }
      this._createEdgePreviewDot();
    }

    // Resize drag strips to match the new shape's border zone.
    // Circle keeps the original 7px/24px values; all other shapes use 3px/10px.
    {
      const dragZone = (newShape === 'circle') ? 24 : 10;
      const borderW  = (newShape === 'circle') ? 7  : 3;
      const iz = (dragZone - borderW) + 'px';
      if (this.dragStrips) {
        this.dragStrips[0].style.height = iz;
        this.dragStrips[1].style.height = iz;
        this.dragStrips[2].style.width  = iz;
        this.dragStrips[3].style.width  = iz;
      }
    }

    this._sendShapeUpdate();
    console.log(`Changed tab ${this.id} shape to ${newShape}`);
  }

  close() {
    const index = tabs.indexOf(this);
    if (index > -1) {
      tabs.splice(index, 1);
    }

    const styleEl = document.getElementById(`tab-style-${this.id}`);
    if (styleEl) styleEl.remove();

    const clipEl = document.getElementById(`clip-tab-${this.id}`);
    if (clipEl) clipEl.remove();

    this.removeVertexHandles();
    this._removeEdgePreviewDot();

    if (this.element) {
      this.element.remove();
    }

    // If this was the active tab, activate another one
    if (this === activeTab) {
      if (tabs.length > 0) {
        tabs[tabs.length - 1].activate();
      } else {
        activeTab = null;
        urlInput.value = '';
      }
    }

    console.log(`Closed tab ${this.id}`);
  }
}

TabWindow.CURSOR_MAP = {
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize'
};

// ---------------------------------------------------------------------------
// convexHull — Andrew's monotone chain; returns CW order in screen/Y-down coords
// ---------------------------------------------------------------------------
function convexHull(points) {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a.x !== b.x ? a.x - b.x : a.y - b.y);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2) {
      const a = lower[lower.length - 2], b = lower[lower.length - 1];
      if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) <= 0) lower.pop();
      else break;
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2) {
      const a = upper[upper.length - 2], b = upper[upper.length - 1];
      if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) <= 0) upper.pop();
      else break;
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ---------------------------------------------------------------------------
// Triangle union helpers
// ---------------------------------------------------------------------------

// Returns true if p is strictly inside triangle tri (not on boundary).
// Handles both CW and CCW triangle orientations.
function strictlyInTriangle(p, tri) {
  function cross2d(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }
  const eps = 0.5;
  const d0 = cross2d(tri[0], tri[1], p);
  const d1 = cross2d(tri[1], tri[2], p);
  const d2 = cross2d(tri[2], tri[0], p);
  return (d0 > eps && d1 > eps && d2 > eps) ||
         (d0 < -eps && d1 < -eps && d2 < -eps);
}

// Returns the intersection of segments a-b and c-d at an interior point,
// or null (endpoints excluded so vertices already in the set aren't doubled).
function segmentIntersect(a, b, c, d) {
  const dx1 = b.x - a.x, dy1 = b.y - a.y;
  const dx2 = d.x - c.x, dy2 = d.y - c.y;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((c.x - a.x) * dy2 - (c.y - a.y) * dx2) / denom;
  const u = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / denom;
  const eps = 1e-10;
  if (t > eps && t < 1 - eps && u > eps && u < 1 - eps) {
    return { x: a.x + t * dx1, y: a.y + t * dy1 };
  }
  return null;
}

// Returns the true union outline of two triangles as a correctly-ordered {x,y}[] polygon.
// For the standard case (2 edge-edge crossings) it traces the boundary exactly,
// correctly handling non-convex union shapes.  Falls back to convex hull for
// exotic overlap configurations (0 crossings = containment, 4+ crossings).
function triangleUnionPolygon(triA, triB) {
  // Compute all edge-edge intersections, recording which edges and how far along each.
  const rawIsects = [];
  for (let i = 0; i < 3; i++) {
    const a = triA[i], b = triA[(i + 1) % 3];
    for (let j = 0; j < 3; j++) {
      const c = triB[j], d = triB[(j + 1) % 3];
      const dx1 = b.x - a.x, dy1 = b.y - a.y;
      const dx2 = d.x - c.x, dy2 = d.y - c.y;
      const denom = dx1 * dy2 - dy1 * dx2;
      if (Math.abs(denom) < 1e-10) continue;
      const t = ((c.x - a.x) * dy2 - (c.y - a.y) * dx2) / denom;
      const u = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / denom;
      const eps = 1e-10;
      if (t > eps && t < 1 - eps && u > eps && u < 1 - eps) {
        rawIsects.push({ pt: { x: a.x + t * dx1, y: a.y + t * dy1 }, edgeA: i, tA: t, edgeB: j, tB: u });
      }
    }
  }

  // Deduplicate crossings within 0.5px
  const isects = [];
  for (const x of rawIsects) {
    if (!isects.some(y => Math.hypot(y.pt.x - x.pt.x, y.pt.y - x.pt.y) < 0.5)) isects.push(x);
  }

  // No crossings: containment or no overlap
  if (isects.length === 0) {
    if (triA.some(p => strictlyInTriangle(p, triB))) return [...triB]; // A inside B
    return [...triA]; // B inside A, or no overlap
  }

  // Standard case: exactly 2 crossings → boundary tracing (correctly handles non-convex shapes).
  // atan2-from-centroid sorting fails for non-convex unions and is NOT used here.
  if (isects.length === 2) {
    // Build an augmented CW vertex sequence for each triangle: original vertices
    // with intersection points spliced in at the correct positions along each edge.
    function buildSeq(tri, isectList, edgeKey, tKey) {
      const seq = [];
      for (let i = 0; i < tri.length; i++) {
        seq.push({ pt: tri[i], isIsect: false });
        const edgeIsects = isectList
          .filter(x => x[edgeKey] === i)
          .sort((a, b) => a[tKey] - b[tKey]);
        for (const x of edgeIsects) seq.push({ pt: x.pt, isIsect: true });
      }
      return seq;
    }

    const seqA = buildSeq(triA, isects, 'edgeA', 'tA');
    const seqB = buildSeq(triB, isects, 'edgeB', 'tB');

    // Start on A at the first non-crossing vertex that lies outside triB.
    const startA = seqA.findIndex(n => !n.isIsect && !strictlyInTriangle(n.pt, triB));
    if (startA === -1) return [...triB]; // all of A is inside B

    const result = [];
    let onA = true;
    let idxA = startA, idxB = 0;
    const limit = seqA.length + seqB.length + 4;

    for (let step = 0; step < limit; step++) {
      const seq  = onA ? seqA : seqB;
      const idx  = onA ? idxA  : idxB;
      const node = seq[idx];

      if (step > 0 && onA && idx === startA) break; // closed the loop

      result.push(node.pt);

      if (node.isIsect) {
        // Switch to the other polygon at this crossing point.
        const other  = onA ? seqB : seqA;
        const thisPt = node.pt;
        const found  = other.findIndex(n => n.isIsect && Math.hypot(n.pt.x - thisPt.x, n.pt.y - thisPt.y) < 1);
        if (found === -1) break; // shouldn't happen
        onA = !onA;
        if (onA) idxA = (found + 1) % seqA.length;
        else     idxB = (found + 1) % seqB.length;
      } else {
        if (onA) idxA = (idxA + 1) % seqA.length;
        else     idxB = (idxB + 1) % seqB.length;
      }
    }

    const deduped = [];
    for (const p of result) {
      if (!deduped.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 0.5)) deduped.push(p);
    }
    if (deduped.length >= 3) return deduped;
  }

  // Fallback for exotic cases (4+ crossings): convex hull of outer vertices + crossings.
  const pts = [
    ...triA.filter(p => !strictlyInTriangle(p, triB)),
    ...triB.filter(p => !strictlyInTriangle(p, triA)),
    ...isects.map(x => x.pt),
  ];
  const deduped = [];
  for (const p of pts) {
    if (!deduped.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 0.5)) deduped.push(p);
  }
  return deduped.length >= 3 ? convexHull(deduped) : [...triA];
}

// ---------------------------------------------------------------------------
// trianglesActuallyOverlap — true when two triangle-shaped tabs have actual
// geometric overlap, not just overlapping bounding boxes.
// Uses the same strictlyInTriangle / segmentIntersect helpers as triangleUnionPolygon.
// ---------------------------------------------------------------------------
function trianglesActuallyOverlap(tabA, tabB) {
  const toAbs = (tab) => tab.triangleVertices.map(v => ({
    x: tab.position.x + v.x * tab.size.width,
    y: tab.position.y + v.y * tab.size.height,
  }));
  const triA = toAbs(tabA);
  const triB = toAbs(tabB);

  // A vertex of one triangle strictly inside the other → overlap
  for (const p of triA) if (strictlyInTriangle(p, triB)) return true;
  for (const p of triB) if (strictlyInTriangle(p, triA)) return true;

  // Any edge pair crossing → overlap
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      if (segmentIntersect(triA[i], triA[(i + 1) % 3], triB[j], triB[(j + 1) % 3])) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// strictlyInConvexPolygon — point-in-convex-polygon test for N vertices.
// Assumes the polygon is wound consistently (all CW or all CCW).
// Returns true only when p is strictly interior (not on any edge).
// ---------------------------------------------------------------------------
function strictlyInConvexPolygon(p, poly) {
  function cross2d(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }
  const eps = 0.5;
  const n = poly.length;
  const signs = poly.map((v, i) => cross2d(v, poly[(i + 1) % n], p));
  return signs.every(s => s > eps) || signs.every(s => s < -eps);
}

// ---------------------------------------------------------------------------
// pointInPolygon — ray-casting point-in-polygon test.
// Works for any simple polygon (convex or non-convex).
// ---------------------------------------------------------------------------
function pointInPolygon(p, poly) {
  const n = poly.length;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > p.y) !== (yj > p.y)) &&
        (p.x < (xj - xi) * (p.y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ---------------------------------------------------------------------------
// polygonUnionOutline — generalized boundary-tracing union for any two simple
// polygons (convex or non-convex: works for distorted quads, triangles, etc.).
// Same algorithm as triangleUnionPolygon but the edge loops use poly.length
// instead of the hard-coded 3, and uses ray-casting for inside/outside tests.
// ---------------------------------------------------------------------------
function polygonUnionOutline(polyA, polyB) {
  const nA = polyA.length, nB = polyB.length;

  // Compute all edge-edge intersections with parametric positions along each edge.
  const rawIsects = [];
  for (let i = 0; i < nA; i++) {
    const a = polyA[i], b = polyA[(i + 1) % nA];
    for (let j = 0; j < nB; j++) {
      const c = polyB[j], d = polyB[(j + 1) % nB];
      const dx1 = b.x - a.x, dy1 = b.y - a.y;
      const dx2 = d.x - c.x, dy2 = d.y - c.y;
      const denom = dx1 * dy2 - dy1 * dx2;
      if (Math.abs(denom) < 1e-10) continue;
      const t = ((c.x - a.x) * dy2 - (c.y - a.y) * dx2) / denom;
      const u = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / denom;
      const eps = 1e-10;
      if (t > eps && t < 1 - eps && u > eps && u < 1 - eps) {
        rawIsects.push({ pt: { x: a.x + t * dx1, y: a.y + t * dy1 }, edgeA: i, tA: t, edgeB: j, tB: u });
      }
    }
  }

  // Deduplicate crossings within 0.5px.
  const isects = [];
  for (const x of rawIsects) {
    if (!isects.some(y => Math.hypot(y.pt.x - x.pt.x, y.pt.y - x.pt.y) < 0.5)) isects.push(x);
  }

  // No crossings: containment or no overlap.
  if (isects.length === 0) {
    if (polyA.some(p => pointInPolygon(p, polyB))) return [...polyB];
    return [...polyA];
  }

  // Boundary tracing: build augmented CW sequences (vertices + crossing points
  // spliced in at the correct position along each edge), then walk A switching
  // to B at each crossing and back to A at the next, closing the loop.
  function buildSeq(poly, isectList, edgeKey, tKey) {
    const seq = [];
    for (let i = 0; i < poly.length; i++) {
      seq.push({ pt: poly[i], isIsect: false });
      const edgeIsects = isectList
        .filter(x => x[edgeKey] === i)
        .sort((a, b) => a[tKey] - b[tKey]);
      for (const x of edgeIsects) seq.push({ pt: x.pt, isIsect: true });
    }
    return seq;
  }

  const seqA = buildSeq(polyA, isects, 'edgeA', 'tA');
  const seqB = buildSeq(polyB, isects, 'edgeB', 'tB');

  const startA = seqA.findIndex(n => !n.isIsect && !pointInPolygon(n.pt, polyB));
  if (startA === -1) return [...polyB];

  const result = [];
  let onA = true;
  let idxA = startA, idxB = 0;
  const limit = seqA.length + seqB.length + 4;

  for (let step = 0; step < limit; step++) {
    const seq  = onA ? seqA : seqB;
    const idx  = onA ? idxA  : idxB;
    const node = seq[idx];
    if (step > 0 && onA && idx === startA) break;
    result.push(node.pt);
    if (node.isIsect) {
      const other = onA ? seqB : seqA;
      const found = other.findIndex(n => n.isIsect && Math.hypot(n.pt.x - node.pt.x, n.pt.y - node.pt.y) < 1);
      if (found === -1) break;
      onA = !onA;
      if (onA) idxA = (found + 1) % seqA.length;
      else     idxB = (found + 1) % seqB.length;
    } else {
      if (onA) idxA = (idxA + 1) % seqA.length;
      else     idxB = (idxB + 1) % seqB.length;
    }
  }

  const deduped = [];
  for (const p of result) {
    if (!deduped.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 0.5)) deduped.push(p);
  }
  if (deduped.length >= 3) return deduped;

  // Fallback: convex hull of outer vertices + crossings.
  const pts = [
    ...polyA.filter(p => !pointInPolygon(p, polyB)),
    ...polyB.filter(p => !pointInPolygon(p, polyA)),
    ...isects.map(x => x.pt),
  ];
  const dd = [];
  for (const p of pts) {
    if (!dd.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 0.5)) dd.push(p);
  }
  return dd.length >= 3 ? convexHull(dd) : [...polyA];
}

// ---------------------------------------------------------------------------
// pentagonsActuallyOverlap — true when two pentagon-shaped tabs geometrically
// overlap, not just their bounding boxes.
// ---------------------------------------------------------------------------
function pentagonsActuallyOverlap(tabA, tabB) {
  const toAbs = (tab) => tab.pentagonVertices.map(v => ({
    x: tab.position.x + v.x * tab.size.width,
    y: tab.position.y + v.y * tab.size.height,
  }));
  const pentA = toAbs(tabA);
  const pentB = toAbs(tabB);

  for (const p of pentA) if (strictlyInConvexPolygon(p, pentB)) return true;
  for (const p of pentB) if (strictlyInConvexPolygon(p, pentA)) return true;

  const nA = pentA.length, nB = pentB.length;
  for (let i = 0; i < nA; i++) {
    for (let j = 0; j < nB; j++) {
      if (segmentIntersect(pentA[i], pentA[(i + 1) % nA], pentB[j], pentB[(j + 1) % nB])) return true;
    }
  }
  return false;
}

function hexagonsActuallyOverlap(tabA, tabB) {
  const toAbs = (tab) => tab.hexagonVertices.map(v => ({
    x: tab.position.x + v.x * tab.size.width,
    y: tab.position.y + v.y * tab.size.height,
  }));
  const hexA = toAbs(tabA);
  const hexB = toAbs(tabB);

  for (const p of hexA) if (strictlyInConvexPolygon(p, hexB)) return true;
  for (const p of hexB) if (strictlyInConvexPolygon(p, hexA)) return true;

  const nA = hexA.length, nB = hexB.length;
  for (let i = 0; i < nA; i++) {
    for (let j = 0; j < nB; j++) {
      if (segmentIntersect(hexA[i], hexA[(i + 1) % nA], hexB[j], hexB[(j + 1) % nB])) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// circlesActuallyOverlap — exact overlap test using center distance vs sum of radii.
// Treats each circle tab as a true circle with radius = min(w, h) / 2.
// ---------------------------------------------------------------------------
function circlesActuallyOverlap(tabA, tabB) {
  const cx = (t) => t.position.x + t.size.width  / 2;
  const cy = (t) => t.position.y + t.size.height / 2;
  const r  = (t) => Math.min(t.size.width, t.size.height) / 2;
  const dx = cx(tabA) - cx(tabB), dy = cy(tabA) - cy(tabB);
  return Math.sqrt(dx * dx + dy * dy) < r(tabA) + r(tabB);
}

// ---------------------------------------------------------------------------
// rectCircleActuallyOverlap — exact overlap test between a rect-like tab and
// a circle tab.  Finds the closest point on the rect to the circle center and
// checks whether it lies within the circle radius.
// ---------------------------------------------------------------------------
function rectCircleActuallyOverlap(tabA, tabB) {
  const circTab = tabA.shape === 'circle' ? tabA : tabB;
  const rectTab = tabA.shape === 'circle' ? tabB : tabA;

  const cx = circTab.position.x + circTab.size.width  / 2;
  const cy = circTab.position.y + circTab.size.height / 2;
  const r  = Math.min(circTab.size.width, circTab.size.height) / 2;

  const rx1 = rectTab.position.x,             ry1 = rectTab.position.y;
  const rx2 = rx1 + rectTab.size.width,        ry2 = ry1 + rectTab.size.height;
  const nearX = Math.max(rx1, Math.min(cx, rx2));
  const nearY = Math.max(ry1, Math.min(cy, ry2));

  return Math.hypot(cx - nearX, cy - nearY) < r;
}

// ---------------------------------------------------------------------------
// segmentIntersectsEllipse — true when segment p→q crosses the ellipse
// boundary (center cx,cy, semi-axes rx,ry).  Solves the quadratic that results
// from substituting the parametric line into the ellipse equation.
// ---------------------------------------------------------------------------
function segmentIntersectsEllipse(p, q, cx, cy, rx, ry) {
  const dx = q.x - p.x, dy = q.y - p.y;
  const ax = (p.x - cx) / rx, ay = (p.y - cy) / ry;
  const bx = dx / rx,         by = dy / ry;
  const A = bx * bx + by * by;
  const B = 2 * (ax * bx + ay * by);
  const C = ax * ax + ay * ay - 1;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return false;
  const sq = Math.sqrt(disc);
  const t1 = (-B - sq) / (2 * A);
  const t2 = (-B + sq) / (2 * A);
  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
}

// ---------------------------------------------------------------------------
// triangleCircleActuallyOverlap — true when a triangle tab and a circle tab
// geometrically overlap.  Checks: any triangle vertex inside the ellipse,
// the ellipse center inside the triangle, or any edge crossing the ellipse.
// ---------------------------------------------------------------------------
function triangleCircleActuallyOverlap(tabA, tabB) {
  const triTab  = tabA.shape === 'triangle' ? tabA : tabB;
  const circTab = tabA.shape === 'triangle' ? tabB : tabA;

  const tri = triTab.triangleVertices.map(v => ({
    x: triTab.position.x + v.x * triTab.size.width,
    y: triTab.position.y + v.y * triTab.size.height,
  }));
  const cx = circTab.position.x + circTab.size.width  / 2;
  const cy = circTab.position.y + circTab.size.height / 2;
  const rx = circTab.size.width  / 2;
  const ry = circTab.size.height / 2;

  for (const v of tri) {
    if (((v.x - cx) / rx) ** 2 + ((v.y - cy) / ry) ** 2 < 1) return true;
  }
  if (strictlyInTriangle({ x: cx, y: cy }, tri)) return true;
  for (let i = 0; i < 3; i++) {
    if (segmentIntersectsEllipse(tri[i], tri[(i + 1) % 3], cx, cy, rx, ry)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// triangleRectActuallyOverlap — true when a triangle-shaped tab and a
// rect/rounded-shaped tab geometrically overlap.
// Uses vertex-in-polygon tests and edge-edge intersection checks.
// ---------------------------------------------------------------------------
function triangleRectActuallyOverlap(tabA, tabB) {
  const triTab  = tabA.shape === 'triangle' ? tabA : tabB;
  const rectTab = tabA.shape === 'triangle' ? tabB : tabA;

  const tri = triTab.triangleVertices.map(v => ({
    x: triTab.position.x + v.x * triTab.size.width,
    y: triTab.position.y + v.y * triTab.size.height,
  }));
  const rect = rectTab.activeVertices.map(v => ({
    x: rectTab.position.x + v.x * rectTab.size.width,
    y: rectTab.position.y + v.y * rectTab.size.height,
  }));

  for (const p of tri)  if (strictlyInConvexPolygon(p, rect)) return true;
  for (const p of rect) if (strictlyInTriangle(p, tri))        return true;

  const nRect = rect.length;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < nRect; j++) {
      if (segmentIntersect(tri[i], tri[(i + 1) % 3], rect[j], rect[(j + 1) % nRect])) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// convexPolygonTabsOverlap — generic exact overlap test for any two tabs
// whose shapes are defined by activeVertices (triangle, pentagon, hexagon,
// rectangle, rounded).  Uses vertex-in-polygon and edge-edge intersection.
// ---------------------------------------------------------------------------
function convexPolygonTabsOverlap(tabA, tabB) {
  const toAbs = (tab) => tab.activeVertices.map(v => ({
    x: tab.position.x + v.x * tab.size.width,
    y: tab.position.y + v.y * tab.size.height,
  }));
  const polyA = toAbs(tabA);
  const polyB = toAbs(tabB);

  for (const p of polyA) if (strictlyInConvexPolygon(p, polyB)) return true;
  for (const p of polyB) if (strictlyInConvexPolygon(p, polyA)) return true;

  const nA = polyA.length, nB = polyB.length;
  for (let i = 0; i < nA; i++) {
    for (let j = 0; j < nB; j++) {
      if (segmentIntersect(polyA[i], polyA[(i + 1) % nA], polyB[j], polyB[(j + 1) % nB])) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// circleApproxPoly — N-point polygon approximating a circle.
// Returns vertices in CW screen order (y-down), matching the convention used
// throughout the polygon union / seam-clip code.
// ---------------------------------------------------------------------------
function circleApproxPoly(cx, cy, r, n = 64) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n; // CW on screen (y-down)
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// ellipseApproxPoly — N-point polygon approximating an axis-aligned ellipse.
// Same CW screen-order convention as circleApproxPoly.
// ---------------------------------------------------------------------------
function ellipseApproxPoly(cx, cy, rx, ry, n = 64) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// findEllipseEllipseIntersections — numerically finds the intersection points
// of two axis-aligned ellipses by parameterising ellipse A and scanning for
// sign changes of the "is this point on ellipse B?" function, then refining
// each crossing with bisection.  Returns up to 4 points on ellipse A's boundary.
// ---------------------------------------------------------------------------
function findEllipseEllipseIntersections(cxA, cyA, rxA, ryA, cxB, cyB, rxB, ryB) {
  // f(t) = 0 when the point on ellipse A at parameter t also lies on ellipse B
  const f = (t) => {
    const x = cxA + rxA * Math.cos(t);
    const y = cyA + ryA * Math.sin(t);
    return ((x - cxB) / rxB) ** 2 + ((y - cyB) / ryB) ** 2 - 1;
  };

  const N = 256;
  const raw = [];
  for (let i = 0; i < N; i++) {
    const t1 = (2 * Math.PI * i) / N;
    const t2 = (2 * Math.PI * (i + 1)) / N;
    if (f(t1) * f(t2) < 0) {
      let lo = t1, hi = t2;
      for (let j = 0; j < 32; j++) {
        const mid = (lo + hi) / 2;
        if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid;
      }
      const t = (lo + hi) / 2;
      raw.push({ x: cxA + rxA * Math.cos(t), y: cyA + ryA * Math.sin(t) });
    }
  }

  const deduped = [];
  for (const p of raw) {
    if (!deduped.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 1)) deduped.push(p);
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// computeCircleArcClips — arc-based seam clips for two overlapping circle tabs.
//
// Each pane is clipped to its half of the union using an SVG arc path:
//   M P1  →  major arc of the ellipse (outer edge)  →  P2  →  Z (chord seam)
//
// clip-path: polygon() does NOT intersect with border-radius — it replaces all
// clipping entirely, making ellipses look polygonal.  clip-path: path(...) with
// an arc command preserves the smooth outer edge.
//
// Seam points P1/P2 are the true ellipse-ellipse intersection points (computed
// numerically), so the clip arc and the border SVG both use the actual ellipse
// geometry rather than the inscribed-circle approximation.
//
// rA, rB — { x, y, w, h } in workspace coordinates.
// Returns { clipA, clipB } as CSS path(...) strings, or null if degenerate.
// ---------------------------------------------------------------------------
function computeCircleArcClips(rA, rB) {
  const cxA = rA.x + rA.w / 2, cyA = rA.y + rA.h / 2;
  const cxB = rB.x + rB.w / 2, cyB = rB.y + rB.h / 2;
  const rxA = rA.w / 2, ryA = rA.h / 2;
  const rxB = rB.w / 2, ryB = rB.h / 2;

  // True ellipse-ellipse intersection points on ellipse A's boundary
  const isects = findEllipseEllipseIntersections(cxA, cyA, rxA, ryA, cxB, cyB, rxB, ryB);
  if (isects.length < 2) return null;
  const P1 = isects[0], P2 = isects[1];

  // Build a clip-path: path(...) string for one pane.
  // rx, ry match the element's border-radius: 50% ellipse so the arc follows
  // the visual boundary exactly.  large-arc is always 1 (major arc).
  // sweep is resolved using ellipse-parameter space (t = atan2(dy/ry, dx/rx)),
  // where increasing t = CW in screen/y-down coordinates.
  function makeArcPath(cx, cy, rx, ry, elemX, elemY) {
    const p1x = P1.x - elemX, p1y = P1.y - elemY;
    const p2x = P2.x - elemX, p2y = P2.y - elemY;
    const lcx = cx - elemX,   lcy = cy - elemY;

    // Outer arc midpoint direction in ellipse-parameter space
    const chordMidX = (p1x + p2x) / 2, chordMidY = (p1y + p2y) / 2;
    const dcx = lcx - chordMidX,        dcy = lcy - chordMidY;

    // Ellipse parameters for P1, P2, and the outer midpoint direction
    const th1   = Math.atan2((p1y - lcy) / ry, (p1x - lcx) / rx);
    const th2   = Math.atan2((p2y - lcy) / ry, (p2x - lcx) / rx);
    const thOut = Math.atan2(dcy / ry, dcx / rx);

    const cwDist = (from, to) => ((to - from) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    const sweep  = cwDist(th1, thOut) < cwDist(th1, th2) ? 1 : 0;

    return `path('M ${p1x.toFixed(2)} ${p1y.toFixed(2)} A ${rx.toFixed(2)} ${ry.toFixed(2)} 0 1 ${sweep} ${p2x.toFixed(2)} ${p2y.toFixed(2)} Z')`;
  }

  return {
    clipA: makeArcPath(cxA, cyA, rxA, ryA, rA.x, rA.y),
    clipB: makeArcPath(cxB, cyB, rxB, ryB, rB.x, rB.y),
  };
}

// ---------------------------------------------------------------------------
// computeRectUnionPolygon — union outline of two axis-aligned rectangles
//
// Returns an ordered array of {x, y} vertices (clockwise) in the same
// coordinate space as r1 and r2.  r1, r2 use {x, y, w, h}.
// ---------------------------------------------------------------------------
function computeRectUnionPolygon(r1, r2) {
  const ax1 = r1.x, ax2 = r1.x + r1.w, ay1 = r1.y, ay2 = r1.y + r1.h;
  const bx1 = r2.x, bx2 = r2.x + r2.w, by1 = r2.y, by2 = r2.y + r2.h;

  // Collect all 8 corners, discarding any that fall *strictly* inside the other rect.
  const inB = p => p.x > bx1 && p.x < bx2 && p.y > by1 && p.y < by2;
  const inA = p => p.x > ax1 && p.x < ax2 && p.y > ay1 && p.y < ay2;

  const pts = [
    ...[ {x:ax1,y:ay1},{x:ax2,y:ay1},{x:ax2,y:ay2},{x:ax1,y:ay2} ].filter(p => !inB(p)),
    ...[ {x:bx1,y:by1},{x:bx2,y:by1},{x:bx2,y:by2},{x:bx1,y:by2} ].filter(p => !inA(p)),
  ];

  // Edge-edge intersections: a vertical edge of one rect crosses a horizontal edge
  // of the other.  These are the "notch corner" vertices of the L/T/cross shape
  // and are the points that atan2-sorting alone cannot produce from corners only.
  //
  // A's right edge (x=ax2) vs B's top/bottom edges
  if (bx1 < ax2 && ax2 < bx2) {
    if (ay1 < by1 && by1 < ay2) pts.push({x: ax2, y: by1});
    if (ay1 < by2 && by2 < ay2) pts.push({x: ax2, y: by2});
  }
  // A's left edge (x=ax1) vs B's top/bottom edges
  if (bx1 < ax1 && ax1 < bx2) {
    if (ay1 < by1 && by1 < ay2) pts.push({x: ax1, y: by1});
    if (ay1 < by2 && by2 < ay2) pts.push({x: ax1, y: by2});
  }
  // A's bottom edge (y=ay2) vs B's left/right edges
  if (by1 < ay2 && ay2 < by2) {
    if (ax1 < bx1 && bx1 < ax2) pts.push({x: bx1, y: ay2});
    if (ax1 < bx2 && bx2 < ax2) pts.push({x: bx2, y: ay2});
  }
  // A's top edge (y=ay1) vs B's left/right edges
  if (by1 < ay1 && ay1 < by2) {
    if (ax1 < bx1 && bx1 < ax2) pts.push({x: bx1, y: ay1});
    if (ax1 < bx2 && bx2 < ax2) pts.push({x: bx2, y: ay1});
  }

  // Sort clockwise (ascending atan2 = CW in screen/Y-down space)
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  // Deduplicate within 0.5 px
  const deduped = [];
  for (const p of pts) {
    if (!deduped.some(q => Math.abs(q.x - p.x) < 0.5 && Math.abs(q.y - p.y) < 0.5))
      deduped.push(p);
  }

  // Remove collinear interior vertices (iterate until stable)
  function collinear(prev, curr, next) {
    const cross = (curr.x - prev.x) * (next.y - prev.y)
                - (curr.y - prev.y) * (next.x - prev.x);
    const base  = Math.hypot(next.x - prev.x, next.y - prev.y);
    return base > 0 && Math.abs(cross) / base < 0.5;
  }
  let poly = deduped, changed = true;
  while (changed && poly.length > 3) {
    changed = false;
    const next = [];
    for (let i = 0; i < poly.length; i++) {
      const prev = poly[(i - 1 + poly.length) % poly.length];
      const curr = poly[i];
      const nxt  = poly[(i + 1) % poly.length];
      if (!collinear(prev, curr, nxt)) next.push(curr);
      else changed = true;
    }
    poly = next;
  }
  return poly;
}

// ---------------------------------------------------------------------------
// computePaneClipPolygons — diagonal seam clip-paths for the two inner panes
//
// Finds the 2 points where the borders of rA and rB cross each other, then
// builds a clip polygon for each pane: the pane's own rectangle sliced along
// the diagonal that connects those 2 intersection points.  The two polygons
// share the same diagonal edge so they tile with no gap and no overlap.
//
// rA, rB use {x, y, w, h} in container-local coordinates.
// Returns { clipA, clipB } — each an array of {x,y} in container-local coords —
// or null when the geometry is degenerate (containment, 4-corner cross, etc.).
// ---------------------------------------------------------------------------
function computePaneClipPolygons(rA, rB) {
  const ax1=rA.x, ax2=rA.x+rA.w, ay1=rA.y, ay2=rA.y+rA.h;
  const bx1=rB.x, bx2=rB.x+rB.w, by1=rB.y, by2=rB.y+rB.h;

  // Collect all valid edge-edge intersection points (vertical edge of one rect
  // crossing a horizontal edge of the other).
  const isects = [];
  const test = (x, y, cond) => { if (cond) isects.push({x, y}); };
  test(ax2, by1, bx1<ax2 && ax2<bx2 && ay1<by1 && by1<ay2);
  test(ax2, by2, bx1<ax2 && ax2<bx2 && ay1<by2 && by2<ay2);
  test(ax1, by1, bx1<ax1 && ax1<bx2 && ay1<by1 && by1<ay2);
  test(ax1, by2, bx1<ax1 && ax1<bx2 && ay1<by2 && by2<ay2);
  test(bx1, ay1, ax1<bx1 && bx1<ax2 && by1<ay1 && ay1<by2);
  test(bx2, ay1, ax1<bx2 && bx2<ax2 && by1<ay1 && ay1<by2);
  test(bx1, ay2, ax1<bx1 && bx1<ax2 && by1<ay2 && ay2<by2);
  test(bx2, ay2, ax1<bx2 && bx2<ax2 && by1<ay2 && ay2<by2);

  // Standard L/corner overlap has exactly 2 intersection points.
  // Containment → 0, cross/plus → 4.  Only handle the 2-point case.
  if (isects.length !== 2) return null;
  const [P1, P2] = isects;

  const inB = p => p.x > bx1 && p.x < bx2 && p.y > by1 && p.y < by2;
  const inA = p => p.x > ax1 && p.x < ax2 && p.y > ay1 && p.y < ay2;

  function sortCW(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    return [...pts].sort((a, b) =>
      Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
    );
  }

  // Clip polygon = pane's exterior corners (not inside the other rect) + P1 + P2
  const clipA = sortCW([
    ...[{x:ax1,y:ay1},{x:ax2,y:ay1},{x:ax2,y:ay2},{x:ax1,y:ay2}].filter(p => !inB(p)),
    P1, P2,
  ]);
  const clipB = sortCW([
    ...[{x:bx1,y:by1},{x:bx2,y:by1},{x:bx2,y:by2},{x:bx1,y:by2}].filter(p => !inA(p)),
    P1, P2,
  ]);
  return { clipA, clipB };
}

// ---------------------------------------------------------------------------
// computePolygonPaneClips — seam clip-paths for two overlapping convex polygons.
//
// Finds all edge-edge intersection points, then for each polygon builds its
// clip polygon by walking its CW vertex sequence and keeping only vertices
// that lie outside the other polygon, plus the intersection points themselves.
// The two clip polygons share the seam edge so they tile with no gap or overlap.
//
// polyA, polyB — arrays of {x,y} in the same coordinate space.
// Returns { clipA, clipB } or null for degenerate cases (containment, etc.).
// ---------------------------------------------------------------------------
function computePolygonPaneClips(polyA, polyB) {
  const nA = polyA.length, nB = polyB.length;
  const rawIsects = [];
  for (let i = 0; i < nA; i++) {
    const a = polyA[i], b = polyA[(i + 1) % nA];
    for (let j = 0; j < nB; j++) {
      const c = polyB[j], d = polyB[(j + 1) % nB];
      const dx1 = b.x - a.x, dy1 = b.y - a.y;
      const dx2 = d.x - c.x, dy2 = d.y - c.y;
      const denom = dx1 * dy2 - dy1 * dx2;
      if (Math.abs(denom) < 1e-10) continue;
      const t = ((c.x - a.x) * dy2 - (c.y - a.y) * dx2) / denom;
      const u = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / denom;
      const eps = 1e-10;
      if (t > eps && t < 1 - eps && u > eps && u < 1 - eps) {
        rawIsects.push({ pt: { x: a.x + t * dx1, y: a.y + t * dy1 }, edgeA: i, tA: t, edgeB: j, tB: u });
      }
    }
  }
  const isects = [];
  for (const x of rawIsects) {
    if (!isects.some(y => Math.hypot(y.pt.x - x.pt.x, y.pt.y - x.pt.y) < 0.5)) isects.push(x);
  }
  if (isects.length < 2) return null;

  // Build augmented CW sequence: original vertices with crossing points spliced in.
  function buildSeq(poly, isectList, edgeKey, tKey) {
    const seq = [];
    for (let i = 0; i < poly.length; i++) {
      seq.push({ pt: poly[i], isIsect: false });
      const edgeIsects = isectList
        .filter(x => x[edgeKey] === i)
        .sort((a, b) => a[tKey] - b[tKey]);
      for (const x of edgeIsects) seq.push({ pt: x.pt, isIsect: true });
    }
    return seq;
  }

  // Clip polygon = vertices of this polygon that are outside the other, plus all
  // intersection points, in the original CW traversal order.
  function buildClip(seq, otherPoly) {
    return seq
      .filter(n => n.isIsect || !strictlyInConvexPolygon(n.pt, otherPoly))
      .map(n => n.pt);
  }

  const seqA = buildSeq(polyA, isects, 'edgeA', 'tA');
  const seqB = buildSeq(polyB, isects, 'edgeB', 'tB');
  const clipA = buildClip(seqA, polyB);
  const clipB = buildClip(seqB, polyA);
  if (clipA.length < 3 || clipB.length < 3) return null;
  return { clipA, clipB };
}

// ---------------------------------------------------------------------------
// tabToPolygon(tab, ox, oy)
//
// Converts a TabWindow's current shape to an approximate polygon in
// SVG-local coordinates (origin = ox, oy in workspace space).
// Used by PolygonMergedTab.createOverlay() to compute the N-pane union outline.
//
//  - circle (undistorted): 64-gon ellipse approximation
//  - any shape with activeVertices: normalized vertex polygon
//  - undistorted rect/rounded: 4-corner bounding box
//
// All results are CW-wound (positive signed area in y-down screen coords),
// which is required by polygonUnionOutline.
// ---------------------------------------------------------------------------
function tabToPolygon(tab, ox, oy) {
  let poly;

  if (tab.shape === 'circle' && !tab.activeVertices) {
    // Pure CSS circle — approximate as a 64-gon ellipse
    const cx = tab.position.x + tab.size.width  / 2 - ox;
    const cy = tab.position.y + tab.size.height / 2 - oy;
    poly = ellipseApproxPoly(cx, cy, tab.size.width / 2, tab.size.height / 2, 64);
  } else if (tab.activeVertices) {
    // Triangle, pentagon, hexagon, or distorted rect/rounded/circle
    poly = tab.activeVertices.map(v => ({
      x: tab.position.x + v.x * tab.size.width  - ox,
      y: tab.position.y + v.y * tab.size.height - oy,
    }));
  } else {
    // Undistorted rect or rounded — use 4-corner bounding box
    const { x, y } = tab.position, { width: w, height: h } = tab.size;
    poly = [
      { x: x - ox,     y: y - oy     },
      { x: x + w - ox, y: y - oy     },
      { x: x + w - ox, y: y + h - oy },
      { x: x - ox,     y: y + h - oy },
    ];
  }

  // Normalize to CW winding (positive signed area in y-down coords).
  // Triangle default vertices are CCW; this ensures polygonUnionOutline
  // stays on the correct (outer) side at each crossing.
  const area2 = poly.reduce((s, v, i) => {
    const nxt = poly[(i + 1) % poly.length];
    return s + v.x * nxt.y - nxt.x * v.y;
  }, 0);
  return area2 < 0 ? poly.slice().reverse() : poly;
}

// ---------------------------------------------------------------------------
// PolygonMergedTab — purely CSS merge; original <webview> elements never move
//
// The two source TabWindow DOM elements stay exactly where they are in
// #workspace.  Merge is applied by mutating their inline CSS (clip-path, border,
// z-index).  The only new DOM nodes created are the border SVG overlay and the
// unmerge button — both siblings in #workspace with pointer-events:none / auto.
// On unmerge the source TabWindow instances are restored to tabs[] and their
// CSS is reset; on close their elements are removed from the DOM.
// ---------------------------------------------------------------------------
class PolygonMergedTab {
  constructor(tabA, tabB) {
    this.id = ++tabIdCounter;

    // Array of all member TabWindow instances. We never reparent or recreate
    // these — doing so would cause Electron to treat each <webview> as a new
    // instance and trigger a full page reload.
    this.tabs = [tabA, tabB];

    this._mergeType = (tabA.shape === 'circle'   && tabB.shape === 'circle')   ? 'circle'
                   : (tabA.shape === 'triangle' && tabB.shape === 'triangle') ? 'triangle'
                   : (tabA.shape === 'pentagon' && tabB.shape === 'pentagon') ? 'pentagon'
                   : (tabA.shape === 'hexagon'  && tabB.shape === 'hexagon')  ? 'hexagon'
                   : (((tabA.shape === 'triangle' || tabA.shape === 'pentagon' || tabA.shape === 'hexagon') !==
                       (tabB.shape === 'triangle' || tabB.shape === 'pentagon' || tabB.shape === 'hexagon')) &&
                      (tabA.shape === 'circle'   || tabB.shape === 'circle'))  ? 'triangle-circle'
                   : ((tabA.shape === 'circle') !== (tabB.shape === 'circle')) ? 'rect-circle'
                   : ((tabA.shape === 'triangle' && (tabB.shape === 'rectangle' || tabB.shape === 'rounded')) ||
                      (tabB.shape === 'triangle' && (tabA.shape === 'rectangle' || tabA.shape === 'rounded'))) ? 'triangle-rect'
                   : ((tabA.shape === 'rectangle' || tabA.shape === 'rounded') &&
                      (tabB.shape === 'rectangle' || tabB.shape === 'rounded')) ? 'rect'
                   : 'polygon';

    this.url            = tabA.url;
    this._focusedPaneIdx = 0; // index into this.tabs of the last-interacted pane
    this.isMerged       = true;
    this.shape          = 'rectangle';
    this.activeVertices = null;
    this.minSize        = { width: 200, height: 150 };

    // Union bounding box in workspace coordinates
    const rA = { x: tabA.position.x, y: tabA.position.y,
                 w: tabA.size.width,  h: tabA.size.height };
    const rB = { x: tabB.position.x, y: tabB.position.y,
                 w: tabB.size.width,  h: tabB.size.height };
    const ox  = Math.min(rA.x, rB.x),  oy  = Math.min(rA.y, rB.y);
    const ox2 = Math.max(rA.x + rA.w, rB.x + rB.w);
    const oy2 = Math.max(rA.y + rA.h, rB.y + rB.h);
    this.position = { x: ox, y: oy };
    this.size     = { width: ox2 - ox, height: oy2 - oy };

    // Per-pane offsets from union origin and pane rects in union-local coords.
    // Indexed in parallel with this.tabs.
    this.paneOffsets = [
      { x: rA.x - ox, y: rA.y - oy },
      { x: rB.x - ox, y: rB.y - oy },
    ];
    this.origRects = [
      { x: this.paneOffsets[0].x, y: this.paneOffsets[0].y, w: rA.w, h: rA.h },
      { x: this.paneOffsets[1].x, y: this.paneOffsets[1].y, w: rB.w, h: rB.h },
    ];

    // Mark individual tabs as merged so their own drag/resize/vertex handlers
    // are fully suppressed while they belong to this merged window.
    this.tabs.forEach(t => { t.isMerged = true; });

    // Pull source tabs out of tabs[] without touching the DOM
    activeTab = null;
    this.tabs.forEach(t => {
      const i = tabs.indexOf(t);
      if (i > -1) tabs.splice(i, 1);
    });

    this.applyMergeStyle();
    this.createOverlay();
    this._createMergedWebview();
    tabs.push(this);
  }

  get area() { return this.size.width * this.size.height; }

  // Expose tabs[0].element as this.element so TabWindow.activate()'s generic
  // tab.element check deactivates this merged tab when another tab is activated.
  get element() { return this.tabs[0].element; }

  // Backward-compat getters for the two-pane shape-dispatch code in
  // applyMergeStyle / createOverlay (will be removed in Step 3).
  get tabA() { return this.tabs[0]; }
  get tabB() { return this.tabs[1]; }
  get elA()  { return this.tabs[0].element; }
  get elB()  { return this.tabs[1].element; }
  get wvA()  { return this.tabs[0].webview; }
  get wvB()  { return this.tabs[1].webview; }
  get origRectA() { return this.origRects[0]; }
  get origRectB() { return this.origRects[1]; }
  get paneAOff()  { return this.paneOffsets[0]; }
  get paneBOff()  { return this.paneOffsets[1]; }

  // True when every member tab is showing the portfolio page.
  // Used to gate the unified-webview rendering path.
  get _isPortfolioMerge() {
    return this.tabs.every(t => t.url && t.url.startsWith(PORTFOLIO_URL));
  }

  // Returns the union polygon in the form __shapeUpdate expects, plus a CSS
  // clip-path string for the unified webview element.  Pure computation — no
  // side effects.  Called from _createMergedWebview (Step 3) and
  // _rebuildForVertexDrag (Step 5).
  _computeUnionShape() {
    const ox = this.position.x, oy = this.position.y;
    const w  = this.size.width,  h  = this.size.height;

    const polys = this.tabs.map(t => tabToPolygon(t, ox, oy));
    let unionPoly = polys[0];
    for (let i = 1; i < polys.length; i++)
      unionPoly = polygonUnionOutline(unionPoly, polys[i]);

    const vertices = unionPoly.map(pt => ({ x: pt.x / w, y: pt.y / h }));
    const clipPath  = 'polygon(' +
      vertices.map(v => `${(v.x * 100).toFixed(3)}% ${(v.y * 100).toFixed(3)}%`).join(', ') +
    ')';

    return { vertices, width: w, height: h, clipPath };
  }

  // ── Unified webview for portfolio merges ───────────────────────────────────
  _createMergedWebview() {
    if (!this._isPortfolioMerge) return;

    const { x, y } = this.position;
    const { width: w, height: h } = this.size;
    const { clipPath } = this._computeUnionShape();

    const wv = document.createElement('webview');
    wv.setAttribute('src', PORTFOLIO_URL);
    wv.style.cssText = [
      'position:absolute',
      `left:${x}px`, `top:${y}px`,
      `width:${w}px`, `height:${h}px`,
      `clip-path:${clipPath}`,
    ].join(';');

    this._mergedWebview = wv;
    this._mergedWebviewReady = false;

    wv.addEventListener('did-finish-load', () => {
      this._mergedWebviewReady = true;
      this._sendMergedShapeUpdate();
    });

    const onNav = (e) => {
      this.url = e.url;
      if (activeTab === this) urlInput.value = e.url;
    };
    wv.addEventListener('did-navigate',         onNav);
    wv.addEventListener('did-navigate-in-page', onNav);
    this._mergedWebviewNavListener = onNav;

    this.tabs.forEach(t => { t.element.style.visibility = 'hidden'; });
    workspace.appendChild(wv);
  }

  _sendMergedShapeUpdate() {
    if (!this._mergedWebview || !this._mergedWebviewReady) return;
    const { vertices, width, height } = this._computeUnionShape();
    const payload = JSON.stringify({ shape: 'polygon', vertices, holes: null, width, height });
    this._mergedWebview.executeJavaScript(
      `window.__shapeUpdate && window.__shapeUpdate(${payload})`
    );
  }

  // ── Apply merge CSS to the two existing tab elements in-place ─────────────
  applyMergeStyle() {
    // Suppress ::after SVG borders for any pane that has them (triangle, pentagon,
    // hexagon, distorted shapes).  Undistorted rects have no tab-style element so
    // suppressAfter is a safe no-op for them.
    const suppressAfter = (tab) => {
      const styleEl = document.getElementById(`tab-style-${tab.id}`);
      if (!styleEl) return null;
      const saved = styleEl.textContent;
      const sel = `.tab-window.shape-${tab.shape}[data-tab-id="${tab.id}"]`;
      styleEl.textContent = `${sel}::after { display:none; }\n${sel}.active::after { display:none; }`;
      return saved;
    };
    this._savedStyles = this.tabs.map(t => suppressAfter(t));

    this._applySeamClips();

    // Suppress individual borders / shadows — the border SVG overlay takes over.
    // Set pointer-events:none on each pane so the border stroke becomes the
    // only interactive surface for the merged group.
    for (const t of this.tabs) {
      const el = t.element;
      el.style.border        = 'none';
      el.style.boxShadow     = 'none';
      // Circles rely on border-radius: 50% from their CSS class for the outer
      // arc shape; zeroing it here would make them render as rectangles so the
      // seam-clip polygon would clip a rectangle instead of an ellipse.
      if (t.shape !== 'circle') el.style.borderRadius = '0';
      el.style.filter        = 'none';
      el.style.transform     = 'none';
      el.style.transition    = 'none';
      el.style.pointerEvents = 'none';
      // Webviews stay interactive so the user can browse inside each pane.
      t.webview.style.pointerEvents = 'auto';
    }

    // When a webview click bubbles up to a pane element, TabWindow's own mousedown
    // handler calls tab.activate(), which would set activeTab to a tab no longer in
    // tabs[].  Redirect those calls to this merged tab's activate() instead so state
    // stays consistent, and record which pane index was clicked.
    this._origActivates = this.tabs.map((t, i) => {
      const orig = t.activate.bind(t);
      t.activate = () => { this._focusedPaneIdx = i; this.activate(); };
      return orig;
    });

    // When the user clicks directly inside a webview, focus fires on the webview
    // element — use that to track the focused pane and update the URL bar.
    this._onFocus = this.tabs.map((t, i) => {
      const fn = () => {
        this._focusedPaneIdx = i;
        if (activeTab === this) urlInput.value = t.url;
      };
      t.webview.addEventListener('focus', fn);
      return fn;
    });

    // Track URL changes as the user browses within each pane.
    this._onNavigate = this.tabs.map((t, i) => {
      const fn = (e) => {
        t.url = e.url;
        if (activeTab === this && this._focusedPaneIdx === i) urlInput.value = e.url;
      };
      t.webview.addEventListener('did-navigate',         fn);
      t.webview.addEventListener('did-navigate-in-page', fn);
      return fn;
    });
  }

  // ── Compute and apply seam clip-paths for all N panes ─────────────────────
  // Called from applyMergeStyle() (initial setup) and addTab() whenever the
  // group gains a new member.
  //
  // Strategy: for each pane i, seam it against the union polygon of all other
  // panes.  For 2 panes this reduces exactly to the previous per-type behavior.
  // For N panes it generalises automatically — each pane yields the overlap
  // region it shares with the collective "everything else".
  //
  // Special case: 2 pure CSS circles use SVG arc-path clips (computeCircleArcClips)
  // so the circular outer edge (border-radius:50%) is preserved at the seam.
  _applySeamClips() {
    const n  = this.tabs.length;
    const ox = this.position.x, oy = this.position.y;

    // Special case: exactly 2 undistorted circles — arc clips preserve border-radius.
    if (n === 2 &&
        this.tabs[0].shape === 'circle' && !this.tabs[0].activeVertices &&
        this.tabs[1].shape === 'circle' && !this.tabs[1].activeVertices) {
      const seam = computeCircleArcClips(this.origRects[0], this.origRects[1]);
      if (seam) {
        this.tabs[0].element.style.clipPath = seam.clipA;
        this.tabs[1].element.style.clipPath = seam.clipB;
      }
      return;
    }

    // General N-pane case.
    // Convert a clip polygon (union-local coords) to a CSS clip-path percentage
    // string relative to the pane's own element dimensions.
    const toCP = (poly, r) =>
      'polygon(' + poly.map(p =>
        `${((p.x - r.x) / r.w * 100).toFixed(3)}% ${((p.y - r.y) / r.h * 100).toFixed(3)}%`
      ).join(', ') + ')';

    // All panes as polygons in union-local coords.
    const polys = this.tabs.map(t => tabToPolygon(t, ox, oy));

    for (let i = 0; i < n; i++) {
      const tab       = this.tabs[i];
      const r         = this.origRects[i];
      const thisPoly  = polys[i];
      const nA        = thisPoly.length;
      const otherPolys = polys.filter((_, j) => j !== i);

      // Collect intersections between thisPoly and each individual other polygon.
      // The old approach built a union polygon of all others and tested
      // strictlyInConvexPolygon against it — incorrect when that union is
      // non-convex (e.g. L-shape for 3 panes).  Working against each individual
      // convex polygon keeps the test valid.
      const isects = [];
      for (const otherPoly of otherPolys) {
        const nB = otherPoly.length;
        for (let a = 0; a < nA; a++) {
          const p1 = thisPoly[a], p2 = thisPoly[(a + 1) % nA];
          for (let b = 0; b < nB; b++) {
            const q1 = otherPoly[b], q2 = otherPoly[(b + 1) % nB];
            const dx1 = p2.x - p1.x, dy1 = p2.y - p1.y;
            const dx2 = q2.x - q1.x, dy2 = q2.y - q1.y;
            const denom = dx1 * dy2 - dy1 * dx2;
            if (Math.abs(denom) < 1e-10) continue;
            const t = ((q1.x - p1.x) * dy2 - (q1.y - p1.y) * dx2) / denom;
            const u = ((q1.x - p1.x) * dy1 - (q1.y - p1.y) * dx1) / denom;
            if (t > 1e-10 && t < 1 - 1e-10 && u > 1e-10 && u < 1 - 1e-10) {
              const pt = { x: p1.x + t * dx1, y: p1.y + t * dy1 };
              if (!isects.some(x => Math.hypot(x.pt.x - pt.x, x.pt.y - pt.y) < 0.5)) {
                isects.push({ pt, edge: a, t });
              }
            }
          }
        }
      }

      // Build augmented vertex sequence: original vertices with intersection
      // points spliced in along each edge in parametric order.
      const seq = [];
      for (let a = 0; a < nA; a++) {
        seq.push({ pt: thisPoly[a], isIsect: false });
        isects.filter(x => x.edge === a).sort((x, y) => x.t - y.t)
              .forEach(x => seq.push({ pt: x.pt, isIsect: true }));
      }

      // Visible clip = vertices outside every other pane + all seam intersections.
      const clip = seq
        .filter(node => node.isIsect ||
                        !otherPolys.some(op => strictlyInConvexPolygon(node.pt, op)))
        .map(node => node.pt);

      if (clip.length >= 3) tab.element.style.clipPath = toCP(clip, r);
    }
  }

  // ── Restore original CSS when unmerging / closing ─────────────────────────
  restoreMergeStyle() {
    for (const t of this.tabs) {
      // _applySeamClips always writes a clip-path, so always clear it on restore.
      const el = t.element;
      el.style.clipPath      = '';
      el.style.border        = '';
      el.style.boxShadow     = '';
      el.style.borderRadius  = '';
      el.style.filter        = '';
      el.style.transform     = '';
      el.style.transition    = '';
      el.style.visibility    = '';
      el.style.pointerEvents = '';
      t.webview.style.pointerEvents = '';
    }

    // Remove per-pane focus and navigation listeners added during merge.
    (this._onFocus || []).forEach((fn, i) => {
      if (fn) this.tabs[i].webview.removeEventListener('focus', fn);
    });
    (this._onNavigate || []).forEach((fn, i) => {
      if (fn) {
        this.tabs[i].webview.removeEventListener('did-navigate',         fn);
        this.tabs[i].webview.removeEventListener('did-navigate-in-page', fn);
      }
    });

    // Restore any ::after SVG borders that were suppressed during merge.
    // _savedStyles[i] is null for panes that had nothing to suppress (undistorted rects).
    this.tabs.forEach((t, i) => {
      const styleEl = document.getElementById(`tab-style-${t.id}`);
      if (styleEl && this._savedStyles && this._savedStyles[i])
        styleEl.textContent = this._savedStyles[i];
      t.updateShapeClipPath();
    });

    // Restore original activate methods on the source tabs.
    (this._origActivates || []).forEach((orig, i) => {
      if (orig) this.tabs[i].activate = orig;
    });
  }

  // ── Create the overlay-only new DOM nodes (border SVG + unmerge button) ───
  createOverlay() {
    const { x, y } = this.position;
    const { width: w, height: h } = this.size;
    // Border SVG — pointer-events:none on the SVG container so the interior
    // area passes through to the workspace.  Polygon children override this
    // with pointer-events:stroke so only the visible stroke is a hit target.
    const borderSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    borderSvg.style.cssText = `position:absolute; left:${x}px; top:${y}px; width:${w}px; height:${h}px; pointer-events:none; overflow:visible;`;
    borderSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.borderSvg = borderSvg;

    const makePolyEl = (pts) => {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', '#4d4d4d');
      p.setAttribute('stroke-width', '3');
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      p.setAttribute('points', pts.map(pt => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' '));
      p.style.pointerEvents = 'stroke';
      p.style.cursor = 'grab';
      return p;
    };

    // Convert each pane to a polygon in SVG-local coords, then chain union outlines.
    const polys = this.tabs.map(t => tabToPolygon(t, x, y));
    let unionPoly = polys[0];
    for (let i = 1; i < polys.length; i++) {
      unionPoly = polygonUnionOutline(unionPoly, polys[i]);
    }
    this.borderPolyEl = makePolyEl(unionPoly);
    this.borderPolyEls = [this.borderPolyEl];
    borderSvg.appendChild(this.borderPolyEl);

    // Unmerge button — show on hover via JS since pane elements are not adjacent
    // siblings of the button in the workspace DOM
    const btn = document.createElement('button');
    btn.className   = 'merged-unmerge-btn';
    btn.textContent = 'Unmerge';
    btn.style.cssText = `position:absolute; left:${x + w / 2}px; top:${y + 4}px; transform:translateX(-50%); opacity:0; pointer-events:none; transition:opacity 0.15s;`;
    btn.addEventListener('click', (e) => { e.stopPropagation(); this.unmerge(); });
    this.unmergeBtn = btn;

    // Show button on hover over the border stroke
    const showBtn = () => {
      btn.style.opacity       = '1';
      btn.style.pointerEvents = 'auto';
    };
    const hideBtn = () => {
      btn.style.opacity       = '0';
      btn.style.pointerEvents = 'none';
    };
    this.borderPolyEls.forEach(p => {
      p.addEventListener('mouseenter', showBtn);
      p.addEventListener('mouseleave', hideBtn);
    });
    // Also keep button reachable when moving from border stroke to button
    btn.addEventListener('mouseenter', showBtn);
    btn.addEventListener('mouseleave', hideBtn);
    this._showBtn = showBtn;
    this._hideBtn = hideBtn;

    workspace.appendChild(this.borderSvg);
    workspace.appendChild(this.unmergeBtn);

    // Vertex handles for merged-group distortion (Shift+drag on union outline vertices).
    this.mergedVertexTags = this._computeVertexTags(unionPoly, polys);
    this.createMergedVertexHandles();

    this.attachDragListeners();
  }

  // ── Border stroke is the exclusive drag handle for the merged group ─────────
  attachDragListeners() {
    const onMouseDown = (e) => {
      e.stopPropagation();
      e.preventDefault();
      this.activate();
      this.startDrag(e);
    };
    this._dragListener = onMouseDown;
    this.borderPolyEls.forEach(p => p.addEventListener('mousedown', onMouseDown));
  }

  startDrag(e) {
    draggedTab = this;
    this.borderPolyEls.forEach(p => p.style.cursor = 'grabbing');
    // Disable webview hit-testing while dragging so mousemove isn't swallowed
    this.tabs.forEach(t => t.webview.style.pointerEvents = 'none');

    // Use the border SVG position as the drag anchor
    const svgRect = this.borderSvg.getBoundingClientRect();
    dragOffset.x = e.clientX - svgRect.left;
    dragOffset.y = e.clientY - svgRect.top;

    const onMouseMove = (ev) => {
      ev.preventDefault();
      if (draggedTab !== this) return;
      const wsRect = workspace.getBoundingClientRect();
      this.updatePosition(
        ev.clientX - wsRect.left - dragOffset.x,
        ev.clientY - wsRect.top  - dragOffset.y
      );
    };
    const onMouseUp = (ev) => {
      ev.preventDefault();
      draggedTab = null;
      this.borderPolyEls.forEach(p => p.style.cursor = 'grab');
      this.tabs.forEach(t => t.webview.style.pointerEvents = 'auto');
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   onMouseUp);
    };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
  }

  updatePosition(x, y) {
    const wsW = workspace.offsetWidth, wsH = workspace.offsetHeight;
    this.position.x = Math.max(0, Math.min(x, wsW - this.size.width));
    this.position.y = Math.max(0, Math.min(y, wsH - this.size.height));
    const px = this.position.x, py = this.position.y;

    // Move each pane element by its stored offset from the union origin
    this.tabs.forEach((t, i) => {
      const nx = px + this.paneOffsets[i].x;
      const ny = py + this.paneOffsets[i].y;
      t.element.style.left = nx + 'px';
      t.element.style.top  = ny + 'px';
      // Keep TabWindow position state in sync so unmerge restores correct coords
      t.position.x = nx;
      t.position.y = ny;
    });

    // Move overlay elements
    this.borderSvg.style.left  = px + 'px';
    this.borderSvg.style.top   = py + 'px';
    this.unmergeBtn.style.left = (px + this.size.width / 2) + 'px';
    this.unmergeBtn.style.top  = (py + 4) + 'px';
    this._repositionMergedVertexHandles();

    if (this._mergedWebview) {
      this._mergedWebview.style.left = px + 'px';
      this._mergedWebview.style.top  = py + 'px';
    }
  }

  activate() {
    // Deactivate every other tab
    tabs.forEach(tab => {
      if (tab.tabs) { tab.tabs.forEach(t => t.element.classList.remove('active')); }
      else if (tab.element) { tab.element.classList.remove('active'); }
    });
    this.tabs.forEach(t => t.element.classList.add('active'));
    activeTab = this;
    urlInput.value = this._mergedWebview ? this.url : this.tabs[this._focusedPaneIdx].url;

    const paneZ = String(++_zTop);
    this.tabs.forEach(t => { t.element.style.zIndex = paneZ; });
    if (this._mergedWebview) this._mergedWebview.style.zIndex = String(++_zTop);
    this.borderSvg.style.zIndex  = String(++_zTop);
    this.unmergeBtn.style.zIndex = String(++_zTop);

    // Keep button visible while active
    this._showBtn();
  }

  _removeDragListeners() {
    this.borderPolyEls.forEach(p => p.removeEventListener('mousedown', this._dragListener));
  }

  _removeHoverListeners() {
    this.borderPolyEls.forEach(p => {
      p.removeEventListener('mouseenter', this._showBtn);
      p.removeEventListener('mouseleave', this._hideBtn);
    });
    this.unmergeBtn.removeEventListener('mouseenter', this._showBtn);
    this.unmergeBtn.removeEventListener('mouseleave', this._hideBtn);
  }

  close() {
    this._removeDragListeners();
    this._removeHoverListeners();
    for (let i = undoStack.length - 1; i >= 0; i--) {
      if (undoStack[i].mergedTab === this) undoStack.splice(i, 1);
    }
    const index = tabs.indexOf(this);
    if (index > -1) tabs.splice(index, 1);
    // All original pane elements are permanently closed
    this.tabs.forEach(t => t.element.remove());
    this.removeMergedVertexHandles();
    this.borderSvg.remove();
    this.unmergeBtn.remove();
    if (this._mergedWebview) {
      if (this._mergedWebviewNavListener) {
        this._mergedWebview.removeEventListener('did-navigate',         this._mergedWebviewNavListener);
        this._mergedWebview.removeEventListener('did-navigate-in-page', this._mergedWebviewNavListener);
      }
      this._mergedWebview.remove();
      this._mergedWebview = null;
    }
    if (this === activeTab) {
      if (tabs.length > 0) tabs[tabs.length - 1].activate();
      else { activeTab = null; urlInput.value = ''; }
    }
  }

  unmerge() {
    this._removeDragListeners();
    this._removeHoverListeners();
    for (let i = undoStack.length - 1; i >= 0; i--) {
      if (undoStack[i].mergedTab === this) undoStack.splice(i, 1);
    }
    const index = tabs.indexOf(this);
    if (index > -1) tabs.splice(index, 1);

    // Remove only the overlay nodes — original pane elements stay in the DOM
    this.removeMergedVertexHandles();
    this.borderSvg.remove();
    this.unmergeBtn.remove();
    if (this._mergedWebview) {
      if (this._mergedWebviewNavListener) {
        this._mergedWebview.removeEventListener('did-navigate',         this._mergedWebviewNavListener);
        this._mergedWebview.removeEventListener('did-navigate-in-page', this._mergedWebviewNavListener);
      }
      this._mergedWebview.remove();
      this._mergedWebview = null;
    }

    // Restore CSS so each tab looks like an independent window again
    this.restoreMergeStyle();
    this.tabs.forEach(t => {
      t.element.classList.remove('active');
      t.isMerged = false;
      tabs.push(t);
    });
    this.tabs[this.tabs.length - 1].activate();
  }

  // ── Add a new pane to this merged group ────────────────────────────────────
  addTab(newTab) {
    const ox = this.position.x, oy = this.position.y;
    const cx = newTab.position.x, cy = newTab.position.y;
    const cw = newTab.size.width,  ch = newTab.size.height;

    // Expand union bounding box
    const newOx  = Math.min(ox, cx);
    const newOy  = Math.min(oy, cy);
    const newOx2 = Math.max(ox + this.size.width,  cx + cw);
    const newOy2 = Math.max(oy + this.size.height, cy + ch);
    const dx = ox - newOx, dy = oy - newOy;

    // Re-base existing pane offsets/origRects to the new union origin
    this.paneOffsets = this.paneOffsets.map(po => ({ x: po.x + dx, y: po.y + dy }));
    this.origRects   = this.origRects.map(r  => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }));

    // Append new pane
    this.tabs.push(newTab);
    this.paneOffsets.push({ x: cx - newOx, y: cy - newOy });
    this.origRects.push({ x: cx - newOx, y: cy - newOy, w: cw, h: ch });

    // Update union bounds
    this.position = { x: newOx, y: newOy };
    this.size     = { width: newOx2 - newOx, height: newOy2 - newOy };

    // Pull new tab out of global tabs[] and mark it merged
    const gi = tabs.indexOf(newTab);
    if (gi > -1) tabs.splice(gi, 1);
    newTab.isMerged = true;

    // Suppress ::after SVG border on new pane
    const suppressAfter = (tab) => {
      const styleEl = document.getElementById(`tab-style-${tab.id}`);
      if (!styleEl) return null;
      const saved = styleEl.textContent;
      const sel = `.tab-window.shape-${tab.shape}[data-tab-id="${tab.id}"]`;
      styleEl.textContent = `${sel}::after { display:none; }\n${sel}.active::after { display:none; }`;
      return saved;
    };
    this._savedStyles.push(suppressAfter(newTab));

    // Apply merge CSS to new pane element
    const el = newTab.element;
    el.style.border        = 'none';
    el.style.boxShadow     = 'none';
    if (newTab.shape !== 'circle') el.style.borderRadius = '0';
    el.style.filter        = 'none';
    el.style.transform     = 'none';
    el.style.transition    = 'none';
    el.style.pointerEvents = 'none';
    newTab.webview.style.pointerEvents = 'auto';

    // Redirect activate to this merged tab
    const origActivate = newTab.activate.bind(newTab);
    this._origActivates.push(origActivate);
    newTab.activate = () => { this._focusedPaneIdx = this.tabs.indexOf(newTab); this.activate(); };

    // Focus listener — track which pane is focused
    const onFocus = () => {
      this._focusedPaneIdx = this.tabs.indexOf(newTab);
      if (activeTab === this) urlInput.value = newTab.url;
    };
    newTab.webview.addEventListener('focus', onFocus);
    this._onFocus.push(onFocus);

    // Navigate listener — track URL changes while browsing
    const onNavigate = (e) => {
      newTab.url = e.url;
      const tIdx = this.tabs.indexOf(newTab);
      if (activeTab === this && this._focusedPaneIdx === tIdx) urlInput.value = e.url;
    };
    newTab.webview.addEventListener('did-navigate',         onNavigate);
    newTab.webview.addEventListener('did-navigate-in-page', onNavigate);
    this._onNavigate.push(onNavigate);

    // Reapply seam clips for all panes
    this._applySeamClips();

    // Rebuild SVG overlay (border + unmerge button)
    this._removeHoverListeners();
    this._removeDragListeners();
    this.removeMergedVertexHandles();
    this.borderSvg.remove();
    this.unmergeBtn.remove();
    this.createOverlay();

    undoStack.push({ type: 'merge-add', mergedTab: this, tab: newTab });
    this.activate();
  }

  // ── Remove one pane from this merged group (used by undo) ──────────────────
  removeTab(tab) {
    const idx = this.tabs.indexOf(tab);
    if (idx === -1) return;

    // Detach listeners added in addTab / applyMergeStyle
    const onFocus    = this._onFocus[idx];
    const onNavigate = this._onNavigate[idx];
    const origAct    = this._origActivates[idx];
    if (onFocus) tab.webview.removeEventListener('focus', onFocus);
    if (onNavigate) {
      tab.webview.removeEventListener('did-navigate',         onNavigate);
      tab.webview.removeEventListener('did-navigate-in-page', onNavigate);
    }
    if (origAct) tab.activate = origAct;

    // Restore pane CSS
    const el = tab.element;
    el.style.clipPath      = '';
    el.style.border        = '';
    el.style.boxShadow     = '';
    el.style.borderRadius  = '';
    el.style.filter        = '';
    el.style.transform     = '';
    el.style.transition    = '';
    el.style.pointerEvents = '';
    tab.webview.style.pointerEvents = '';
    const styleEl = document.getElementById(`tab-style-${tab.id}`);
    if (styleEl && this._savedStyles[idx]) styleEl.textContent = this._savedStyles[idx];
    tab.updateShapeClipPath();

    // Splice pane out of all parallel arrays
    this.tabs.splice(idx, 1);
    this.paneOffsets.splice(idx, 1);
    this.origRects.splice(idx, 1);
    this._savedStyles.splice(idx, 1);
    this._onFocus.splice(idx, 1);
    this._onNavigate.splice(idx, 1);
    this._origActivates.splice(idx, 1);

    if (this._focusedPaneIdx >= this.tabs.length) this._focusedPaneIdx = this.tabs.length - 1;

    tab.isMerged = false;
    tab.element.classList.remove('active');
    tabs.push(tab);

    // If only one pane remains, dissolve the merged group entirely
    if (this.tabs.length === 1) {
      this.unmerge();
      return;
    }

    // Recompute union bounding box from remaining pane positions
    const newOx  = Math.min(...this.tabs.map(t => t.position.x));
    const newOy  = Math.min(...this.tabs.map(t => t.position.y));
    const newOx2 = Math.max(...this.tabs.map(t => t.position.x + t.size.width));
    const newOy2 = Math.max(...this.tabs.map(t => t.position.y + t.size.height));
    const dx = this.position.x - newOx, dy = this.position.y - newOy;
    this.paneOffsets = this.paneOffsets.map(po => ({ x: po.x + dx, y: po.y + dy }));
    this.origRects   = this.origRects.map(r  => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h }));
    this.position = { x: newOx, y: newOy };
    this.size     = { width: newOx2 - newOx, height: newOy2 - newOy };

    this._applySeamClips();

    this._removeHoverListeners();
    this._removeDragListeners();
    this.removeMergedVertexHandles();
    this.borderSvg.remove();
    this.unmergeBtn.remove();
    this.createOverlay();

    this.activate();
  }

  // ── Merged-group vertex dragging ───────────────────────────────────────────
  //
  // Each vertex of the union outline polygon is tagged back to the pane vertex it
  // came from (or marked non-draggable for seam intersection points and for
  // undistorted circles, which have 64 boundary points with no meaningful corners).
  // Invisible hit-target divs (same 56px circles as individual tabs) are placed in
  // the workspace at each draggable vertex.  Shift+drag moves the source pane's
  // vertex via the same applyVertexLayout logic the individual tab uses, then
  // refreshes the border SVG and seam clips in-place.

  _computeVertexTags(unionPoly, polys) {
    return unionPoly.map(pt => {
      for (let paneIdx = 0; paneIdx < polys.length; paneIdx++) {
        const poly = polys[paneIdx];
        for (let vIdx = 0; vIdx < poly.length; vIdx++) {
          if (Math.hypot(poly[vIdx].x - pt.x, poly[vIdx].y - pt.y) < 1.0) {
            const tab = this.tabs[paneIdx];
            // Undistorted circles approximate as a 64-gon — none of those points
            // are meaningful corners so skip them.
            const draggable = !(tab.shape === 'circle' && !tab.activeVertices);
            return { pt, paneIdx, vIdx, draggable };
          }
        }
      }
      // Seam intersection — lies on two pane edges, not a single vertex.
      return { pt, paneIdx: -1, vIdx: -1, draggable: false };
    });
  }

  createMergedVertexHandles() {
    if (!this.mergedVertexTags) return;
    const ox = this.position.x, oy = this.position.y;
    this.mergedVertexHandles = this.mergedVertexTags
      .filter(t => t.draggable)
      .map((tag, hi) => {
        const h = document.createElement('div');
        h.style.cssText = [
          'position:absolute',
          `left:${(ox + tag.pt.x).toFixed(1)}px`,
          `top:${(oy + tag.pt.y).toFixed(1)}px`,
          'width:56px', 'height:56px',
          'border-radius:50%',
          'z-index:300',
          'transform:translate(-50%,-50%)',
          'cursor:default',
        ].join(';');
        h.addEventListener('mousemove', e => {
          h.style.cursor = e.shiftKey ? 'crosshair' : 'default';
        });
        h.addEventListener('mousedown', e => {
          if (!e.shiftKey) return;
          e.stopPropagation();
          e.preventDefault();
          this.startMergedVertexDrag(e, hi);
        });
        workspace.appendChild(h);
        return h;
      });
  }

  removeMergedVertexHandles() {
    if (!this.mergedVertexHandles) return;
    this.mergedVertexHandles.forEach(h => h.remove());
    this.mergedVertexHandles = null;
  }

  _repositionMergedVertexHandles() {
    if (!this.mergedVertexHandles || !this.mergedVertexTags) return;
    const ox = this.position.x, oy = this.position.y;
    this.mergedVertexTags.filter(t => t.draggable).forEach((tag, hi) => {
      const h = this.mergedVertexHandles[hi];
      if (h) {
        h.style.left = (ox + tag.pt.x).toFixed(1) + 'px';
        h.style.top  = (oy + tag.pt.y).toFixed(1) + 'px';
      }
    });
  }

  // Move a single pane vertex to a new absolute workspace position, resizing the
  // pane's bounding box to fit (mirrors applyVertexLayout without CSS side effects).
  _applyMergedPaneVertexMove(paneIdx, vIdx, wsX, wsY) {
    const tab = this.tabs[paneIdx];
    // Undistorted rect/rounded: initialize corner vertices on first drag.
    if (!tab.activeVertices) {
      if (tab.shape === 'rectangle' || tab.shape === 'rounded') {
        tab.activeVertices = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
      } else return;
    }

    // All vertices in absolute workspace coords; move the dragged one.
    const absVerts = tab.activeVertices.map(v => ({
      x: tab.position.x + v.x * tab.size.width,
      y: tab.position.y + v.y * tab.size.height,
    }));
    absVerts[vIdx] = {
      x: Math.max(0, Math.min(workspace.offsetWidth,  wsX)),
      y: Math.max(0, Math.min(workspace.offsetHeight, wsY)),
    };

    // Recompute bounding box with padding (same as applyVertexLayout).
    const pad  = 4;
    const wsW  = workspace.offsetWidth, wsH = workspace.offsetHeight;
    const minX = Math.max(0,   Math.min(...absVerts.map(v => v.x)) - pad);
    const minY = Math.max(0,   Math.min(...absVerts.map(v => v.y)) - pad);
    const maxX = Math.min(wsW, Math.max(...absVerts.map(v => v.x)) + pad);
    const maxY = Math.min(wsH, Math.max(...absVerts.map(v => v.y)) + pad);
    const newW = Math.max(tab.minSize.width,  maxX - minX);
    const newH = Math.max(tab.minSize.height, maxY - minY);

    tab.position.x = minX;  tab.position.y = minY;
    tab.size.width  = newW; tab.size.height = newH;
    tab.element.style.left   = minX + 'px';
    tab.element.style.top    = minY + 'px';
    tab.element.style.width  = newW + 'px';
    tab.element.style.height = newH + 'px';
    tab.activeVertices = absVerts.map(v => ({
      x: (v.x - minX) / newW,
      y: (v.y - minY) / newH,
    }));
  }

  // Cheaply refresh the border SVG, vertex handles, and seam clips after a
  // pane vertex has moved, without destroying and recreating overlay DOM nodes.
  _rebuildForVertexDrag() {
    // Recompute union bounding box from current pane positions.
    const newOx  = Math.min(...this.tabs.map(t => t.position.x));
    const newOy  = Math.min(...this.tabs.map(t => t.position.y));
    const newOx2 = Math.max(...this.tabs.map(t => t.position.x + t.size.width));
    const newOy2 = Math.max(...this.tabs.map(t => t.position.y + t.size.height));
    this.position = { x: newOx, y: newOy };
    this.size     = { width: newOx2 - newOx, height: newOy2 - newOy };
    this.paneOffsets = this.tabs.map(t => ({ x: t.position.x - newOx, y: t.position.y - newOy }));
    this.origRects   = this.tabs.map((t, i) => ({
      x: this.paneOffsets[i].x, y: this.paneOffsets[i].y,
      w: t.size.width,          h: t.size.height,
    }));

    const w = this.size.width, h = this.size.height;

    // Update border SVG viewport and recompute union outline.
    this.borderSvg.style.left   = newOx + 'px';
    this.borderSvg.style.top    = newOy + 'px';
    this.borderSvg.style.width  = w + 'px';
    this.borderSvg.style.height = h + 'px';
    this.borderSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const polys = this.tabs.map(t => tabToPolygon(t, newOx, newOy));
    let unionPoly = polys[0];
    for (let i = 1; i < polys.length; i++) unionPoly = polygonUnionOutline(unionPoly, polys[i]);
    this.borderPolyEl.setAttribute('points',
      unionPoly.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '));

    // Update or recreate vertex handles (count can change as vertices enter/exit panes).
    const newTags = this._computeVertexTags(unionPoly, polys);
    const newCount = newTags.filter(t => t.draggable).length;
    const oldCount = this.mergedVertexHandles ? this.mergedVertexHandles.length : -1;
    if (oldCount === newCount) {
      this.mergedVertexTags = newTags;
      this._repositionMergedVertexHandles();
    } else {
      this.removeMergedVertexHandles();
      this.mergedVertexTags = newTags;
      this.createMergedVertexHandles();
    }

    this.unmergeBtn.style.left = (newOx + w / 2) + 'px';
    this.unmergeBtn.style.top  = (newOy + 4) + 'px';

    this._applySeamClips();

    if (this._mergedWebview) {
      const { clipPath } = this._computeUnionShape();
      this._mergedWebview.style.left     = newOx + 'px';
      this._mergedWebview.style.top      = newOy + 'px';
      this._mergedWebview.style.width    = w + 'px';
      this._mergedWebview.style.height   = h + 'px';
      this._mergedWebview.style.clipPath = clipPath;
      this._sendMergedShapeUpdate();
    }
  }

  startMergedVertexDrag(e, handleIdx) {
    e.preventDefault();
    e.stopPropagation();
    const tag = this.mergedVertexTags.filter(t => t.draggable)[handleIdx];
    if (!tag) return;

    vertexDraggingTab = this;
    this.tabs.forEach(t => { t.webview.style.pointerEvents = 'none'; });

    const onMouseMove = (ev) => {
      ev.preventDefault();
      if (vertexDraggingTab !== this) return;
      const wsRect = workspace.getBoundingClientRect();
      this._applyMergedPaneVertexMove(
        tag.paneIdx, tag.vIdx,
        ev.clientX - wsRect.left,
        ev.clientY - wsRect.top
      );
      this._rebuildForVertexDrag();
    };

    const onMouseUp = (ev) => {
      ev.preventDefault();
      vertexDraggingTab = null;
      this.tabs.forEach(t => { t.webview.style.pointerEvents = 'auto'; });
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);
  }

  changeShape()  { console.log('Cannot change shape of a polygon merged tab'); }
  updateTitle()  { /* no-op */ }
  updateUrl(url) {
    this.url = url;
    if (this._mergedWebview) {
      this._mergedWebview.src = url;
    } else {
      const t = this.tabs[this._focusedPaneIdx];
      t.url = url;
      if (t.webview) t.webview.src = url;
    }
  }
}

// ===========================================================================
// Pure geometry module — union polygon & dividing line
// ===========================================================================

/**
 * computeUnionPolygon(rectA, rectB)
 *
 * Given two axis-aligned rectangles that overlap, returns the outline of their
 * union as an ordered polygon, the configuration type, and a validity flag.
 *
 * @param {{x,y,w,h}} rectA
 * @param {{x,y,w,h}} rectB
 * @returns {{ polygon: {x,y}[], config: string, valid: boolean }}
 *   config one of: 'corner-NW','corner-NE','corner-SW','corner-SE',
 *                  'edge-N','edge-S','edge-E','edge-W','contained','none'
 */
function computeUnionPolygon(rectA, rectB) {
  const ax1 = rectA.x,        ax2 = rectA.x + rectA.w;
  const ay1 = rectA.y,        ay2 = rectA.y + rectA.h;
  const bx1 = rectB.x,        bx2 = rectB.x + rectB.w;
  const by1 = rectB.y,        by2 = rectB.y + rectB.h;

  // No overlap at all
  if (ax2 <= bx1 || bx2 <= ax1 || ay2 <= by1 || by2 <= ay1) {
    return { polygon: [], config: 'none', valid: false };
  }

  // Containment — B inside A
  if (bx1 >= ax1 && bx2 <= ax2 && by1 >= ay1 && by2 <= ay2) {
    return {
      polygon: [{x:ax1,y:ay1},{x:ax2,y:ay1},{x:ax2,y:ay2},{x:ax1,y:ay2}],
      config: 'contained', valid: true
    };
  }
  // Containment — A inside B
  if (ax1 >= bx1 && ax2 <= bx2 && ay1 >= by1 && ay2 <= by2) {
    return {
      polygon: [{x:bx1,y:by1},{x:bx2,y:by1},{x:bx2,y:by2},{x:bx1,y:by2}],
      config: 'contained', valid: true
    };
  }

  // Collect 8 candidate corners (4 per rect), discarding any corner that falls
  // *strictly* inside the other rectangle.
  const insideB = p => p.x > bx1 && p.x < bx2 && p.y > by1 && p.y < by2;
  const insideA = p => p.x > ax1 && p.x < ax2 && p.y > ay1 && p.y < ay2;

  const cornersA = [{x:ax1,y:ay1},{x:ax2,y:ay1},{x:ax2,y:ay2},{x:ax1,y:ay2}];
  const cornersB = [{x:bx1,y:by1},{x:bx2,y:by1},{x:bx2,y:by2},{x:bx1,y:by2}];

  const pts = [
    ...cornersA.filter(p => !insideB(p)),
    ...cornersB.filter(p => !insideA(p)),
  ];

  // Sort clockwise by atan2 from centroid (ascending = CW in screen coords)
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  // Deduplicate points within 1px
  const deduped = [];
  for (const p of pts) {
    if (!deduped.some(q => Math.abs(q.x - p.x) < 1 && Math.abs(q.y - p.y) < 1)) {
      deduped.push(p);
    }
  }

  // Remove collinear interior vertices (perpendicular distance < 0.5px).
  // One pass can expose new collinear triples, so iterate until stable.
  function removeCollinear(poly) {
    if (poly.length < 3) return poly;
    const result = [];
    for (let i = 0; i < poly.length; i++) {
      const prev = poly[(i - 1 + poly.length) % poly.length];
      const curr = poly[i];
      const next = poly[(i + 1) % poly.length];
      // |cross product| = twice the triangle area; divided by base = perpendicular dist
      const cross = (curr.x - prev.x) * (next.y - prev.y)
                  - (curr.y - prev.y) * (next.x - prev.x);
      const base  = Math.hypot(next.x - prev.x, next.y - prev.y);
      if (base > 0 && Math.abs(cross) / base >= 0.5) result.push(curr);
    }
    return result;
  }

  let poly = deduped;
  let prevLen;
  do {
    prevLen = poly.length;
    poly = removeCollinear(poly);
  } while (poly.length < prevLen);

  // Determine config from how B's bounding box relates to A's
  const bL   = bx1 < ax1, bR   = bx2 > ax2;
  const bT   = by1 < ay1, bBot = by2 > ay2;
  let config;
  if      (bL && bT)   config = 'corner-NW';
  else if (bR && bT)   config = 'corner-NE';
  else if (bL && bBot) config = 'corner-SW';
  else if (bR && bBot) config = 'corner-SE';
  else if (bT)         config = 'edge-N';
  else if (bBot)       config = 'edge-S';
  else if (bL)         config = 'edge-W';
  else if (bR)         config = 'edge-E';
  else                 config = 'contained';

  return { polygon: poly, config, valid: poly.length >= 4 };
}

/**
 * computeDividingLine(rectA, rectB, unionResult)
 *
 * Given two overlapping rectangles and their precomputed union polygon,
 * returns the two clipped sub-polygons (one per rect's region) and the
 * endpoints of the dividing line segment within the intersection zone.
 *
 * Divider axis is chosen by the longer intersection dimension:
 *   intersection wider than tall  → horizontal divider (splits top / bottom)
 *   intersection taller than wide → vertical divider   (splits left / right)
 *
 * @param {{x,y,w,h}} rectA
 * @param {{x,y,w,h}} rectB
 * @param {{ polygon:{x,y}[], valid:boolean }} unionResult  — from computeUnionPolygon
 * @returns {{ clipA:{x,y}[], clipB:{x,y}[], dividerStart:{x,y}, dividerEnd:{x,y} } | null}
 */
function computeDividingLine(rectA, rectB, unionResult) {
  if (!unionResult || !unionResult.valid) return null;

  const ax1 = rectA.x, ax2 = rectA.x + rectA.w;
  const ay1 = rectA.y, ay2 = rectA.y + rectA.h;
  const bx1 = rectB.x, bx2 = rectB.x + rectB.w;
  const by1 = rectB.y, by2 = rectB.y + rectB.h;

  // Intersection zone
  const ix1 = Math.max(ax1, bx1), ix2 = Math.min(ax2, bx2);
  const iy1 = Math.max(ay1, by1), iy2 = Math.min(ay2, by2);
  const iw  = ix2 - ix1,          ih  = iy2 - iy1;

  // Choose axis: vertical divider when intersection is taller than wide
  const useVertical  = ih > iw;
  const divCoord     = useVertical ? (ix1 + ix2) / 2 : (iy1 + iy2) / 2;
  const dividerStart = useVertical ? { x: divCoord, y: iy1 } : { x: ix1, y: divCoord };
  const dividerEnd   = useVertical ? { x: divCoord, y: iy2 } : { x: ix2, y: divCoord };

  const poly  = unionResult.polygon;

  // Which side is rectA's centre on?
  const cax = (ax1 + ax2) / 2, cay = (ay1 + ay2) / 2;
  const sideA = useVertical
    ? (cax <= divCoord ? 'left'  : 'right')
    : (cay <= divCoord ? 'top'   : 'bottom');

  function getSide(p) {
    if (useVertical) return p.x <= divCoord ? 'left'  : 'right';
    return               p.y <= divCoord ? 'top'   : 'bottom';
  }

  // Find where an edge crosses the divider line; returns null if it doesn't
  function edgeIntersect(p1, p2) {
    if (useVertical) {
      const d1 = p1.x - divCoord, d2 = p2.x - divCoord;
      if (d1 * d2 >= 0) return null;
      const t = d1 / (d1 - d2);
      return { x: divCoord, y: p1.y + t * (p2.y - p1.y) };
    } else {
      const d1 = p1.y - divCoord, d2 = p2.y - divCoord;
      if (d1 * d2 >= 0) return null;
      const t = d1 / (d1 - d2);
      return { x: p1.x + t * (p2.x - p1.x), y: divCoord };
    }
  }

  // Walk the union polygon clockwise, routing each vertex to clipA or clipB
  // and inserting the crossing point into both halves when an edge crosses.
  const clipA = [], clipB = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const curr = poly[i];
    const next = poly[(i + 1) % n];

    if (getSide(curr) === sideA) clipA.push(curr); else clipB.push(curr);

    const xp = edgeIntersect(curr, next);
    if (xp) { clipA.push(xp); clipB.push(xp); }
  }

  return { clipA, clipB, dividerStart, dividerEnd };
}

// ---------------------------------------------------------------------------
// computeRectDifference — boolean difference of two axis-aligned rectangles.
//
// Returns the vertices of rA minus (rA ∩ rB) as an ordered {x,y}[] polygon,
// or null when the result is unchanged or cannot be represented as a simple
// polygon (B fully inside A would punch a hole; B splits A in two).
// rA, rB: { x, y, w, h } in the same coordinate space.
// ---------------------------------------------------------------------------
function computeRectDifference(rA, rB) {
  const ax1 = rA.x, ax2 = rA.x + rA.w, ay1 = rA.y, ay2 = rA.y + rA.h;
  const bx1 = rB.x, bx2 = rB.x + rB.w, by1 = rB.y, by2 = rB.y + rB.h;

  const ix1 = Math.max(ax1, bx1), ix2 = Math.min(ax2, bx2);
  const iy1 = Math.max(ay1, by1), iy2 = Math.min(ay2, by2);
  if (ix2 <= ix1 || iy2 <= iy1) return null; // no overlap

  const eps = 0.5;
  const atLeft   = ix1 <= ax1 + eps;
  const atRight  = ix2 >= ax2 - eps;
  const atTop    = iy1 <= ay1 + eps;
  const atBottom = iy2 >= ay2 - eps;

  // B contains A entirely — nothing left
  if (atLeft && atRight && atTop && atBottom) return null;
  // B fully inside A — would create a hole, not a simple polygon
  if (!atLeft && !atRight && !atTop && !atBottom) return null;
  // B slices A into two disconnected pieces — not representable
  if (atLeft && atRight && !atTop && !atBottom) return null;
  if (atTop && atBottom && !atLeft && !atRight) return null;

  // ── Corner overlaps → 6-vertex L-shape ───────────────────────────────────
  if (atRight && atBottom && !atLeft && !atTop)
    return [{x:ax1,y:ay1},{x:ax2,y:ay1},{x:ax2,y:iy1},{x:ix1,y:iy1},{x:ix1,y:ay2},{x:ax1,y:ay2}];
  if (atLeft && atBottom && !atRight && !atTop)
    return [{x:ax1,y:ay1},{x:ax2,y:ay1},{x:ax2,y:ay2},{x:ix2,y:ay2},{x:ix2,y:iy1},{x:ax1,y:iy1}];
  if (atRight && atTop && !atLeft && !atBottom)
    return [{x:ax1,y:ay1},{x:ix1,y:ay1},{x:ix1,y:iy2},{x:ax2,y:iy2},{x:ax2,y:ay2},{x:ax1,y:ay2}];
  if (atLeft && atTop && !atRight && !atBottom)
    return [{x:ix2,y:ay1},{x:ax2,y:ay1},{x:ax2,y:ay2},{x:ax1,y:ay2},{x:ax1,y:iy2},{x:ix2,y:iy2}];

  // ── Full edge removed → 4-vertex smaller rectangle ───────────────────────
  if (atRight && atTop && atBottom)   return [{x:ax1,y:ay1},{x:ix1,y:ay1},{x:ix1,y:ay2},{x:ax1,y:ay2}];
  if (atLeft  && atTop && atBottom)   return [{x:ix2,y:ay1},{x:ax2,y:ay1},{x:ax2,y:ay2},{x:ix2,y:ay2}];
  if (atTop   && atLeft && atRight)   return [{x:ax1,y:iy2},{x:ax2,y:iy2},{x:ax2,y:ay2},{x:ax1,y:ay2}];
  if (atBottom && atLeft && atRight)  return [{x:ax1,y:ay1},{x:ax2,y:ay1},{x:ax2,y:iy1},{x:ax1,y:iy1}];

  // ── Edge notch → 8-vertex C/U-shape ──────────────────────────────────────
  if (atRight && !atLeft && !atTop && !atBottom)
    return [{x:ax1,y:ay1},{x:ax2,y:ay1},{x:ax2,y:iy1},{x:ix1,y:iy1},{x:ix1,y:iy2},{x:ax2,y:iy2},{x:ax2,y:ay2},{x:ax1,y:ay2}];
  if (atLeft && !atRight && !atTop && !atBottom)
    return [{x:ax1,y:ay1},{x:ax2,y:ay1},{x:ax2,y:ay2},{x:ax1,y:ay2},{x:ax1,y:iy2},{x:ix2,y:iy2},{x:ix2,y:iy1},{x:ax1,y:iy1}];
  if (atTop && !atBottom && !atLeft && !atRight)
    return [{x:ax1,y:ay1},{x:ix1,y:ay1},{x:ix1,y:iy2},{x:ix2,y:iy2},{x:ix2,y:ay1},{x:ax2,y:ay1},{x:ax2,y:ay2},{x:ax1,y:ay2}];
  if (atBottom && !atTop && !atLeft && !atRight)
    return [{x:ax1,y:ay1},{x:ax2,y:ay1},{x:ax2,y:ay2},{x:ix2,y:ay2},{x:ix2,y:iy1},{x:ix1,y:iy1},{x:ix1,y:ay2},{x:ax1,y:ay2}];

  return null;
}

// ---------------------------------------------------------------------------
// computePolygonDifference — boolean difference of two convex polygons.
//
// Returns the vertices of polyA minus (polyA ∩ polyB) as an ordered {x,y}[]
// polygon in the same coordinate space, or null when the result can't be
// represented as a simple polygon (B contains A, A contains B with a hole,
// or no overlap).
//
// Algorithm: same boundary-tracing technique as polygonUnionOutline, but at
// each A→B crossing we traverse B BACKWARDS (the reverse of the union walk).
// This selects B's inside-A arc (the bite edge) instead of B's outside-A arc.
// Both directions are tried; the valid result is identified as the polygon
// whose area is strictly less than polyA's area (A\B can only be smaller).
// ---------------------------------------------------------------------------
function computePolygonDifference(polyA, polyB) {
  const nA = polyA.length, nB = polyB.length;

  // Compute all edge-edge crossings (identical to polygonUnionOutline).
  const rawIsects = [];
  for (let i = 0; i < nA; i++) {
    const a = polyA[i], b = polyA[(i + 1) % nA];
    for (let j = 0; j < nB; j++) {
      const c = polyB[j], d = polyB[(j + 1) % nB];
      const dx1 = b.x - a.x, dy1 = b.y - a.y;
      const dx2 = d.x - c.x, dy2 = d.y - c.y;
      const denom = dx1 * dy2 - dy1 * dx2;
      if (Math.abs(denom) < 1e-10) continue;
      const t = ((c.x - a.x) * dy2 - (c.y - a.y) * dx2) / denom;
      const u = ((c.x - a.x) * dy1 - (c.y - a.y) * dx1) / denom;
      if (t > 1e-10 && t < 1 - 1e-10 && u > 1e-10 && u < 1 - 1e-10)
        rawIsects.push({ pt: { x: a.x + t * dx1, y: a.y + t * dy1 }, edgeA: i, tA: t, edgeB: j, tB: u });
    }
  }
  const isects = [];
  for (const x of rawIsects) {
    if (!isects.some(y => Math.hypot(y.pt.x - x.pt.x, y.pt.y - x.pt.y) < 0.5)) isects.push(x);
  }

  if (isects.length === 0 || isects.length % 2 !== 0) return null;

  function buildSeq(poly, isectList, edgeKey, tKey) {
    const seq = [];
    for (let i = 0; i < poly.length; i++) {
      seq.push({ pt: poly[i], isIsect: false });
      const ei = isectList.filter(x => x[edgeKey] === i).sort((a, b) => a[tKey] - b[tKey]);
      for (const x of ei) seq.push({ pt: x.pt, isIsect: true });
    }
    return seq;
  }
  const seqA = buildSeq(polyA, isects, 'edgeA', 'tA');
  const seqB = buildSeq(polyB, isects, 'edgeB', 'tB');

  // Start on A at a vertex outside B (same as union).
  const startA = seqA.findIndex(n => !n.isIsect && !strictlyInConvexPolygon(n.pt, polyB));
  if (startA === -1) return null; // A entirely inside B

  function polySignedArea(poly) {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      a += poly[i].x * poly[j].y - poly[j].x * poly[i].y;
    }
    return a / 2;
  }
  const absAreaA = Math.abs(polySignedArea(polyA));

  // Walk helper: traverse A (always forward) and B with a given step direction.
  // At each A→B crossing, B is stepped in dirB (+1 forward = union, -1 backward = difference).
  function walk(dirB) {
    const result = [];
    let onA = true, idxA = startA, idxB = 0;
    const limit = seqA.length + seqB.length + 4;
    for (let step = 0; step < limit; step++) {
      const seq = onA ? seqA : seqB;
      const idx = onA ? idxA : idxB;
      const node = seq[idx];
      if (step > 0 && onA && idx === startA) break;
      result.push(node.pt);
      if (node.isIsect) {
        if (onA) {
          const fi = seqB.findIndex(n => n.isIsect && Math.hypot(n.pt.x - node.pt.x, n.pt.y - node.pt.y) < 1);
          if (fi === -1) return null;
          idxB = ((fi + dirB) % seqB.length + seqB.length) % seqB.length;
          onA = false;
        } else {
          const fi = seqA.findIndex(n => n.isIsect && Math.hypot(n.pt.x - node.pt.x, n.pt.y - node.pt.y) < 1);
          if (fi === -1) return null;
          idxA = (fi + 1) % seqA.length;
          onA = true;
        }
      } else {
        if (onA) idxA = (idxA + 1) % seqA.length;
        else     idxB = ((idxB + dirB) % seqB.length + seqB.length) % seqB.length;
      }
    }
    const deduped = [];
    for (const p of result) {
      if (!deduped.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 0.5)) deduped.push(p);
    }
    return deduped.length >= 3 ? deduped : null;
  }

  // dirB = -1 traverses B backward → picks the inside-A (bite) arc → difference.
  // dirB = +1 traverses B forward  → picks the outside-A arc → union.
  // Identify the difference result as the polygon with area < polyA's area.
  for (const dirB of [-1, +1]) {
    const result = walk(dirB);
    if (result && Math.abs(polySignedArea(result)) < absAreaA * 1.01) return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// computeCircleDifferenceVertices — boolean difference of two ellipses.
//
// Returns the boundary polygon of (tabA minus tabA∩tabB) as an ordered
// {x,y}[] array in absolute workspace coordinates, ready for applyVertexLayout.
// The polygon consists of:
//   • The major arc of A (the part outside B), sampled P1→P2.
//   • The inside arc of B (the bite edge, inside A), sampled P2→P1.
// Returns null when the circles don't properly intersect.
// ---------------------------------------------------------------------------
function computeCircleDifferenceVertices(tabA, tabB) {
  const cxA = tabA.position.x + tabA.size.width  / 2;
  const cyA = tabA.position.y + tabA.size.height / 2;
  const rxA = tabA.size.width  / 2;
  const ryA = tabA.size.height / 2;

  const cxB = tabB.position.x + tabB.size.width  / 2;
  const cyB = tabB.position.y + tabB.size.height / 2;
  const rxB = tabB.size.width  / 2;
  const ryB = tabB.size.height / 2;

  const isects = findEllipseEllipseIntersections(cxA, cyA, rxA, ryA, cxB, cyB, rxB, ryB);
  if (isects.length < 2) return null;
  const P1 = isects[0], P2 = isects[1];

  const tA1 = Math.atan2((P1.y - cyA) / ryA, (P1.x - cxA) / rxA);
  const tA2 = Math.atan2((P2.y - cyA) / ryA, (P2.x - cxA) / rxA);
  const tB1 = Math.atan2((P1.y - cyB) / ryB, (P1.x - cxB) / rxB);
  const tB2 = Math.atan2((P2.y - cyB) / ryB, (P2.x - cxB) / rxB);

  const isInsideB = p => ((p.x - cxB) / rxB) ** 2 + ((p.y - cyB) / ryB) ** 2 < 1;
  const isInsideA = p => ((p.x - cxA) / rxA) ** 2 + ((p.y - cyA) / ryA) ** 2 < 1;

  // Returns the midpoint of the arc from t1→t2 going in direction dir (+1 CW, -1 CCW)
  function arcMid(cx, cy, rx, ry, t1, t2, dir) {
    let start = t1, end = t2;
    if (dir > 0) { while (end <= start) end += 2 * Math.PI; }
    else         { while (end >= start) end -= 2 * Math.PI; }
    const tm = (start + end) / 2;
    return { x: cx + rx * Math.cos(tm), y: cy + ry * Math.sin(tm) };
  }

  // Sample N+1 points along an arc from t1→t2 in direction dir (inclusive of endpoints)
  function sampleArc(cx, cy, rx, ry, t1, t2, dir, N) {
    let start = t1, end = t2;
    if (dir > 0) { while (end <= start) end += 2 * Math.PI; }
    else         { while (end >= start) end -= 2 * Math.PI; }
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const t = start + (end - start) * i / N;
      pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
    }
    return pts;
  }

  // Major arc of A: P1→P2 going outside B
  const midACW = arcMid(cxA, cyA, rxA, ryA, tA1, tA2, +1);
  const dirA = isInsideB(midACW) ? -1 : +1;
  const majorArcPts = sampleArc(cxA, cyA, rxA, ryA, tA1, tA2, dirA, 64);

  // Inside arc of B: P2→P1 going through the bite (inside A)
  const midBCW = arcMid(cxB, cyB, rxB, ryB, tB2, tB1, +1);
  const dirB = isInsideA(midBCW) ? +1 : -1;
  const insideArcPts = sampleArc(cxB, cyB, rxB, ryB, tB2, tB1, dirB, 64);

  // Combine: majorArcPts (P1→P2 on A) + insideArcPts sans duplicate endpoints (P2→P1 on B)
  return [...majorArcPts, ...insideArcPts.slice(1, -1)];
}

/**
 * runGeometryTests()
 *
 * Self-contained test suite. Results appear in DevTools console under the
 * "Geometry Tests" group. Called once at startup.
 */
function runGeometryTests() {
  console.group('Geometry Tests');

  let passed = 0, failed = 0;

  function assert(label, condition, got) {
    if (condition) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.warn(`  ✗ ${label}`, got !== undefined ? `→ got ${JSON.stringify(got)}` : '');
      failed++;
    }
  }

  // ── T1: No overlap ─────────────────────────────────────────────────────────
  {
    const A = { x:0,   y:0, w:100, h:100 };
    const B = { x:200, y:0, w:100, h:100 };
    const r = computeUnionPolygon(A, B);
    assert('T1 – no overlap: valid=false',    !r.valid,              r.valid);
    assert('T1 – no overlap: config="none"',   r.config === 'none',  r.config);
  }

  // ── T2: B contained in A ───────────────────────────────────────────────────
  {
    const A = { x:0,  y:0,  w:300, h:300 };
    const B = { x:50, y:50, w:100, h:100 };
    const r = computeUnionPolygon(A, B);
    assert('T2 – contained: valid=true',          r.valid,                  r.valid);
    assert('T2 – contained: config="contained"',  r.config === 'contained', r.config);
    assert('T2 – contained: 4 polygon vertices',  r.polygon.length === 4,   r.polygon.length);
  }

  // ── T3: Corner-NE overlap (6-vertex L-shaped union) ────────────────────────
  {
    // A: x 0–200, y 100–300   B: x 100–300, y 0–200
    const A = { x:0,   y:100, w:200, h:200 };
    const B = { x:100, y:0,   w:200, h:200 };
    const r = computeUnionPolygon(A, B);
    assert('T3 – corner-NE: valid=true',            r.valid,                   r.valid);
    assert('T3 – corner-NE: config="corner-NE"',    r.config === 'corner-NE', r.config);
    assert('T3 – corner-NE: 6 polygon vertices',    r.polygon.length === 6,   r.polygon.length);
  }

  // ── T4: Corner-SW overlap (6-vertex L-shaped union) ────────────────────────
  {
    // A: x 100–300, y 0–200   B: x 0–200, y 100–300
    const A = { x:100, y:0,   w:200, h:200 };
    const B = { x:0,   y:100, w:200, h:200 };
    const r = computeUnionPolygon(A, B);
    assert('T4 – corner-SW: valid=true',            r.valid,                   r.valid);
    assert('T4 – corner-SW: config="corner-SW"',    r.config === 'corner-SW', r.config);
    assert('T4 – corner-SW: 6 polygon vertices',    r.polygon.length === 6,   r.polygon.length);
  }

  // ── T5: Edge-E overlap (B extends right only; 6-vertex union) ─────────────
  {
    // A: x 0–200, y 0–300   B: x 100–300, y 50–250  (B extends right only)
    const A = { x:0,   y:0,  w:200, h:300 };
    const B = { x:100, y:50, w:200, h:200 };
    const r = computeUnionPolygon(A, B);
    assert('T5 – edge-E: valid=true',            r.valid,               r.valid);
    assert('T5 – edge-E: config="edge-E"',       r.config === 'edge-E', r.config);
    assert('T5 – edge-E: 6 polygon vertices',    r.polygon.length === 6, r.polygon.length);
  }

  // ── T6: Dividing line — vertical split ────────────────────────────────────
  {
    // A: x 0–200, y 0–200   B: x 100–300, y 0–200
    // Intersection: iw=100, ih=200 → ih>iw → vertical divider at x=150
    const A = { x:0,   y:0, w:200, h:200 };
    const B = { x:100, y:0, w:200, h:200 };
    const r = computeUnionPolygon(A, B);
    const d = computeDividingLine(A, B, r);
    assert('T6 – divider: result non-null',           d !== null,               d);
    assert('T6 – vertical divider at x=150',          d && d.dividerStart.x === 150, d && d.dividerStart.x);
    assert('T6 – clipA has ≥3 vertices',              d && d.clipA.length >= 3, d && d.clipA.length);
    assert('T6 – clipB has ≥3 vertices',              d && d.clipB.length >= 3, d && d.clipB.length);
  }

  // ── T7: Dividing line — horizontal split ──────────────────────────────────
  {
    // A: x 0–200, y 0–200   B: x 0–200, y 100–300
    // Intersection: iw=200, ih=100 → iw>ih → horizontal divider at y=150
    const A = { x:0, y:0,   w:200, h:200 };
    const B = { x:0, y:100, w:200, h:200 };
    const r = computeUnionPolygon(A, B);
    const d = computeDividingLine(A, B, r);
    assert('T7 – horizontal divider at y=150',        d && d.dividerStart.y === 150, d && d.dividerStart.y);
    assert('T7 – clipA has ≥3 vertices',              d && d.clipA.length >= 3, d && d.clipA.length);
    assert('T7 – clipB has ≥3 vertices',              d && d.clipB.length >= 3, d && d.clipB.length);
  }

  console.log(`\n  ${passed} passed, ${failed} failed`);
  console.groupEnd();
}

// Run geometry self-tests at startup (results in DevTools → Console)
runGeometryTests();

// ---------------------------------------------------------------------------
// Merge helpers
// ---------------------------------------------------------------------------
let mergeHighlightedTab = null;

function computeOverlapRatio(tabA, tabB) {
  const ix1 = Math.max(tabA.position.x, tabB.position.x);
  const iy1 = Math.max(tabA.position.y, tabB.position.y);
  const ix2 = Math.min(tabA.position.x + tabA.size.width,  tabB.position.x + tabB.size.width);
  const iy2 = Math.min(tabA.position.y + tabA.size.height, tabB.position.y + tabB.size.height);
  if (ix2 <= ix1 || iy2 <= iy1) return 0;
  const intersection = (ix2 - ix1) * (iy2 - iy1);
  const minArea = Math.min(tabA.area, tabB.area);
  return minArea > 0 ? intersection / minArea : 0;
}

// rect/rounded tabs merge with each other; same-shape polygons merge together.
function shapesCompatibleForMerge(tabA, tabB) {
  const rectLike = s => s === 'rectangle' || s === 'rounded';
  // Any two vertex-draggable polygon shapes can merge with each other
  const polyLike = s => s === 'triangle' || s === 'pentagon' || s === 'hexagon' || rectLike(s);
  if (polyLike(tabA.shape) && polyLike(tabB.shape)) return true;
  const circleFriendly = s => rectLike(s) || s === 'triangle' || s === 'circle' || s === 'pentagon' || s === 'hexagon';
  if (tabA.shape === 'circle' && circleFriendly(tabB.shape)) return true;
  if (tabB.shape === 'circle' && circleFriendly(tabA.shape)) return true;
  return false;
}

function polygonOverlap(tabA, tabB) {
  if (tabA.shape === 'circle'   && tabB.shape === 'circle')   return circlesActuallyOverlap(tabA, tabB);
  if (tabA.shape === 'triangle' && tabB.shape === 'triangle') return trianglesActuallyOverlap(tabA, tabB);
  if (tabA.shape === 'pentagon' && tabB.shape === 'pentagon') return pentagonsActuallyOverlap(tabA, tabB);
  if (tabA.shape === 'hexagon'  && tabB.shape === 'hexagon')  return hexagonsActuallyOverlap(tabA, tabB);
  if ((tabA.shape === 'triangle' && tabB.shape === 'circle') ||
      (tabA.shape === 'circle' && tabB.shape === 'triangle')) return triangleCircleActuallyOverlap(tabA, tabB);
  const rectLike = s => s === 'rectangle' || s === 'rounded';
  if ((rectLike(tabA.shape) && tabB.shape === 'circle') ||
      (tabA.shape === 'circle' && rectLike(tabB.shape))) return rectCircleActuallyOverlap(tabA, tabB);
  if ((tabA.shape === 'triangle' && rectLike(tabB.shape)) ||
      (tabB.shape === 'triangle' && rectLike(tabA.shape))) return triangleRectActuallyOverlap(tabA, tabB);
  // Generic exact overlap for any remaining pair of vertex-draggable polygon shapes
  if (tabA.activeVertices && tabB.activeVertices) return convexPolygonTabsOverlap(tabA, tabB);
  return computeOverlapRatio(tabA, tabB) >= 0.03;
}

function findMergeCandidate(dragging) {
  if (dragging.isMerged) return null;
  for (const other of tabs) {
    if (other === dragging) continue;
    if (other instanceof PolygonMergedTab) {
      // A free tab can join an existing merged group if it's shape-compatible
      // with any existing pane and overlaps at least one of them.
      if (shapesCompatibleForMerge(dragging, other.tabs[0]) &&
          other.tabs.some(pane => polygonOverlap(dragging, pane))) return other;
    } else {
      if (other.isMerged) continue;
      if (!shapesCompatibleForMerge(dragging, other)) continue;
      if (polygonOverlap(dragging, other)) return other;
    }
  }
  return null;
}

function checkForMerge(tab) {
  if (tab.isMerged) return;
  for (const other of tabs) {
    if (other === tab) continue;
    if (other instanceof PolygonMergedTab) {
      if (shapesCompatibleForMerge(tab, other.tabs[0]) &&
          other.tabs.some(pane => polygonOverlap(tab, pane))) {
        other.addTab(tab);
        return;
      }
    } else {
      if (other.isMerged) continue;
      if (!shapesCompatibleForMerge(tab, other)) continue;
      if (polygonOverlap(tab, other)) {
        mergeTabs(tab, other);
        return;
      }
    }
  }
}

function _addMergeHighlight(candidate) {
  if (candidate instanceof PolygonMergedTab) {
    candidate.borderPolyEls.forEach(p => p.setAttribute('stroke', '#0078d4'));
    candidate.borderSvg.style.filter = 'drop-shadow(0 0 12px rgba(0, 120, 212, 0.7))';
  } else {
    candidate.element.classList.add('merge-candidate');
    // Directly set inline filter so the blue glow works regardless of whether
    // the shape already has an inline filter (rectangle/rounded set one in changeShape,
    // which a stylesheet !important rule may not reliably override in Electron).
    candidate._savedMergeFilter = candidate.element.style.filter;
    candidate.element.style.filter = 'drop-shadow(0 0 12px rgba(0, 120, 212, 0.7))';
    // Also turn the ::after border blue via the injected style tag (if present).
    const styleEl = document.getElementById(`tab-style-${candidate.id}`);
    if (styleEl) {
      const sel = `.tab-window.shape-${candidate.shape}[data-tab-id="${candidate.id}"]`;
      styleEl.textContent += `\n${sel}.merge-candidate::after { background: #0078d4; }`;
    }
  }
}

function _removeMergeHighlight(candidate) {
  if (candidate instanceof PolygonMergedTab) {
    candidate.borderPolyEls.forEach(p => p.setAttribute('stroke', '#4d4d4d'));
    candidate.borderSvg.style.filter = '';
  } else {
    candidate.element.classList.remove('merge-candidate');
    // Restore the filter that was in place before highlighting.
    candidate.element.style.filter = candidate._savedMergeFilter ?? '';
    candidate._savedMergeFilter = undefined;
    // Rebuild the injected style tag without the merge-candidate rule.
    candidate.updateShapeClipPath();
  }
}

function highlightMergeCandidate(dragging) {
  const candidate = findMergeCandidate(dragging);
  if (candidate !== mergeHighlightedTab) {
    if (mergeHighlightedTab) _removeMergeHighlight(mergeHighlightedTab);
    mergeHighlightedTab = candidate;
    if (candidate) _addMergeHighlight(candidate);
  }
}

function clearMergeHighlight() {
  if (mergeHighlightedTab) {
    _removeMergeHighlight(mergeHighlightedTab);
    mergeHighlightedTab = null;
  }
}

function mergeTabs(tabA, tabB) {
  const merged = new PolygonMergedTab(tabA, tabB);
  merged.activate();
  undoStack.push({ type: 'merge', mergedTab: merged });
}

// ---------------------------------------------------------------------------
// Carve undo helpers — snapshot/restore a tab's full visual state before carving.
// ---------------------------------------------------------------------------
function snapshotTabForCarve(tab) {
  const styleEl = document.getElementById(`tab-style-${tab.id}`);
  return {
    tab,
    position: { x: tab.position.x, y: tab.position.y },
    size:     { width: tab.size.width, height: tab.size.height },
    vertices: tab.activeVertices ? tab.activeVertices.map(v => ({ x: v.x, y: v.y })) : null,
    holes:    tab.holes.map(h => h.map(p => ({ x: p.x, y: p.y }))),
    style: {
      left:         tab.element.style.left,
      top:          tab.element.style.top,
      width:        tab.element.style.width,
      height:       tab.element.style.height,
      clipPath:     tab.element.style.clipPath,
      borderWidth:  tab.element.style.borderWidth,
      borderRadius: tab.element.style.borderRadius,
      borderColor:  tab.element.style.borderColor,
      boxShadow:    tab.element.style.boxShadow,
      filter:       tab.element.style.filter,
      transition:   tab.element.style.transition,
    },
    styleTagContent: styleEl ? styleEl.textContent : null,
  };
}

function restoreCarveSnapshot(snap) {
  const { tab, position, size, vertices, holes, style, styleTagContent } = snap;
  tab.removeVertexHandles();

  tab.position.x  = position.x;
  tab.position.y  = position.y;
  tab.size.width  = size.width;
  tab.size.height = size.height;
  tab.activeVertices = vertices ? vertices.map(v => ({ x: v.x, y: v.y })) : null;
  tab.holes          = holes   ? holes.map(h => h.map(p => ({ x: p.x, y: p.y }))) : [];

  // Remove any stale SVG <clipPath> so _updateClipPathWithHoles creates a fresh one.
  const clipEl = document.getElementById(`clip-tab-${tab.id}`);
  if (clipEl) clipEl.remove();

  tab.element.style.left         = style.left;
  tab.element.style.top          = style.top;
  tab.element.style.width        = style.width;
  tab.element.style.height       = style.height;
  tab.element.style.clipPath     = style.clipPath;
  tab.element.style.borderWidth  = style.borderWidth;
  tab.element.style.borderRadius = style.borderRadius;
  tab.element.style.borderColor  = style.borderColor;
  tab.element.style.boxShadow    = style.boxShadow;
  tab.element.style.filter       = style.filter;
  tab.element.style.transition   = style.transition;

  let styleEl = document.getElementById(`tab-style-${tab.id}`);
  if (styleTagContent !== null) {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = `tab-style-${tab.id}`;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = styleTagContent;
  } else if (styleEl) {
    styleEl.remove();
  }

  tab.createVertexHandles();
  // If the snapshot had holes, rebuild the SVG clip element (createVertexHandles
  // doesn't do this, and the restored style.clipPath is a stale url reference).
  if (tab.holes.length > 0) tab.updateShapeClipPath();
}

// ---------------------------------------------------------------------------
// applyBooleanDifference — carves deletedTab's rectangle out of survivingTab.
// Only operates on rect/rounded shapes. Uses computeRectDifference to get the
// new polygon, then applies it via applyVertexLayout so the element resizes
// correctly (e.g. for full-edge cuts) and normalised vertices are updated.
// ---------------------------------------------------------------------------
function applyBooleanDifference(survivingTab, deletedTab) {
  const rectLike = s => s === 'rectangle' || s === 'rounded';
  console.log('[CARVE] applyBooleanDifference — surviving:', survivingTab.id, survivingTab.shape,
    'pos:', JSON.stringify(survivingTab.position), 'size:', JSON.stringify(survivingTab.size));
  console.log('[CARVE] applyBooleanDifference — deleted:', deletedTab.id, deletedTab.shape,
    'pos:', JSON.stringify(deletedTab.position), 'size:', JSON.stringify(deletedTab.size));

  // ── Containment: cutter fully inside surviving → punch a hole ──────────────
  // Supported targets: rect/rounded, circle, triangle, pentagon, hexagon.
  // Supported cutters: rect/rounded, circle, triangle, pentagon, hexagon.
  if (rectLike(survivingTab.shape)) {
    const sA = { x: survivingTab.position.x, y: survivingTab.position.y,
                 w: survivingTab.size.width,  h: survivingTab.size.height };

    if (rectLike(deletedTab.shape) &&
        survivingTab._isRectangular(survivingTab.activeVertices) &&
        deletedTab._isRectangular(deletedTab.activeVertices)) {
      const sB = { x: deletedTab.position.x, y: deletedTab.position.y,
                   w: deletedTab.size.width,  h: deletedTab.size.height };
      if (sB.x >= sA.x && sB.y >= sA.y &&
          sB.x + sB.w <= sA.x + sA.w && sB.y + sB.h <= sA.y + sA.h) {
        survivingTab.holes.push([
          { x: (sB.x          - sA.x) / sA.w, y: (sB.y          - sA.y) / sA.h },
          { x: (sB.x + sB.w   - sA.x) / sA.w, y: (sB.y          - sA.y) / sA.h },
          { x: (sB.x + sB.w   - sA.x) / sA.w, y: (sB.y + sB.h   - sA.y) / sA.h },
          { x: (sB.x          - sA.x) / sA.w, y: (sB.y + sB.h   - sA.y) / sA.h },
        ]);
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'circle') {
      const cx = deletedTab.position.x + deletedTab.size.width  / 2;
      const cy = deletedTab.position.y + deletedTab.size.height / 2;
      const rx = deletedTab.size.width  / 2;
      const ry = deletedTab.size.height / 2;
      if (cx - rx >= sA.x && cy - ry >= sA.y &&
          cx + rx <= sA.x + sA.w && cy + ry <= sA.y + sA.h) {
        const cxn = (cx - sA.x) / sA.w, cyn = (cy - sA.y) / sA.h;
        const rxn = rx / sA.w,           ryn = ry / sA.h;
        const N = 32;
        survivingTab.holes.push(
          Array.from({ length: N }, (_, i) => {
            const a = 2 * Math.PI * i / N;
            return { x: cxn + rxn * Math.cos(a), y: cyn + ryn * Math.sin(a) };
          })
        );
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'triangle' && deletedTab.triangleVertices) {
      const triAbs = deletedTab.triangleVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (triAbs.every(p => p.x >= sA.x && p.y >= sA.y && p.x <= sA.x + sA.w && p.y <= sA.y + sA.h)) {
        survivingTab.holes.push(triAbs.map(p => ({
          x: (p.x - sA.x) / sA.w, y: (p.y - sA.y) / sA.h,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'pentagon' && deletedTab.pentagonVertices) {
      const pentAbs = deletedTab.pentagonVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (pentAbs.every(p => p.x >= sA.x && p.y >= sA.y && p.x <= sA.x + sA.w && p.y <= sA.y + sA.h)) {
        survivingTab.holes.push(pentAbs.map(p => ({
          x: (p.x - sA.x) / sA.w, y: (p.y - sA.y) / sA.h,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'hexagon' && deletedTab.hexagonVertices) {
      const hexAbs = deletedTab.hexagonVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (hexAbs.every(p => p.x >= sA.x && p.y >= sA.y && p.x <= sA.x + sA.w && p.y <= sA.y + sA.h)) {
        survivingTab.holes.push(hexAbs.map(p => ({
          x: (p.x - sA.x) / sA.w, y: (p.y - sA.y) / sA.h,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }
  }

  if (survivingTab.shape === 'circle' && !survivingTab.activeVertices) {
    const scx = survivingTab.position.x + survivingTab.size.width  / 2;
    const scy = survivingTab.position.y + survivingTab.size.height / 2;
    const srx = survivingTab.size.width  / 2;
    const sry = survivingTab.size.height / 2;
    const sX  = survivingTab.position.x, sY = survivingTab.position.y;
    const sW  = survivingTab.size.width,  sH = survivingTab.size.height;

    const inEllipse = (px, py) => {
      const dx = (px - scx) / srx, dy = (py - scy) / sry;
      return dx * dx + dy * dy <= 1;
    };

    if (rectLike(deletedTab.shape)) {
      const bX = deletedTab.position.x, bY = deletedTab.position.y;
      const bW = deletedTab.size.width,  bH = deletedTab.size.height;
      const corners = [
        { x: bX,      y: bY      },
        { x: bX + bW, y: bY      },
        { x: bX + bW, y: bY + bH },
        { x: bX,      y: bY + bH },
      ];
      if (corners.every(p => inEllipse(p.x, p.y))) {
        survivingTab.holes.push([
          { x: (bX      - sX) / sW, y: (bY      - sY) / sH },
          { x: (bX + bW - sX) / sW, y: (bY      - sY) / sH },
          { x: (bX + bW - sX) / sW, y: (bY + bH - sY) / sH },
          { x: (bX      - sX) / sW, y: (bY + bH - sY) / sH },
        ]);
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'circle') {
      const bcx = deletedTab.position.x + deletedTab.size.width  / 2;
      const bcy = deletedTab.position.y + deletedTab.size.height / 2;
      const brx = deletedTab.size.width  / 2;
      const bry = deletedTab.size.height / 2;
      const N = 32;
      const allInside = Array.from({ length: N }, (_, i) => {
        const a = 2 * Math.PI * i / N;
        return inEllipse(bcx + brx * Math.cos(a), bcy + bry * Math.sin(a));
      }).every(Boolean);
      if (allInside) {
        const cxn = (bcx - sX) / sW, cyn = (bcy - sY) / sH;
        const rxn = brx / sW,        ryn = bry / sH;
        survivingTab.holes.push(
          Array.from({ length: N }, (_, i) => {
            const a = 2 * Math.PI * i / N;
            return { x: cxn + rxn * Math.cos(a), y: cyn + ryn * Math.sin(a) };
          })
        );
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'triangle' && deletedTab.triangleVertices) {
      const triAbs = deletedTab.triangleVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (triAbs.every(p => inEllipse(p.x, p.y))) {
        survivingTab.holes.push(triAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'pentagon' && deletedTab.pentagonVertices) {
      const pentAbs = deletedTab.pentagonVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (pentAbs.every(p => inEllipse(p.x, p.y))) {
        survivingTab.holes.push(pentAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'hexagon' && deletedTab.hexagonVertices) {
      const hexAbs = deletedTab.hexagonVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (hexAbs.every(p => inEllipse(p.x, p.y))) {
        survivingTab.holes.push(hexAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }
  }

  if (survivingTab.shape === 'triangle' && survivingTab.triangleVertices) {
    const sX = survivingTab.position.x, sY = survivingTab.position.y;
    const sW = survivingTab.size.width,  sH = survivingTab.size.height;
    const triAbs = survivingTab.triangleVertices.map(v => ({
      x: sX + v.x * sW, y: sY + v.y * sH,
    }));

    const ptInTri = (px, py) => {
      const cross = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
      const d1 = cross(px, py, triAbs[0].x, triAbs[0].y, triAbs[1].x, triAbs[1].y);
      const d2 = cross(px, py, triAbs[1].x, triAbs[1].y, triAbs[2].x, triAbs[2].y);
      const d3 = cross(px, py, triAbs[2].x, triAbs[2].y, triAbs[0].x, triAbs[0].y);
      const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
      const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
      return !(hasNeg && hasPos);
    };

    if (rectLike(deletedTab.shape)) {
      const bX = deletedTab.position.x, bY = deletedTab.position.y;
      const bW = deletedTab.size.width,  bH = deletedTab.size.height;
      const corners = [
        { x: bX,      y: bY      },
        { x: bX + bW, y: bY      },
        { x: bX + bW, y: bY + bH },
        { x: bX,      y: bY + bH },
      ];
      if (corners.every(p => ptInTri(p.x, p.y))) {
        survivingTab.holes.push(corners.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'circle') {
      const bcx = deletedTab.position.x + deletedTab.size.width  / 2;
      const bcy = deletedTab.position.y + deletedTab.size.height / 2;
      const brx = deletedTab.size.width  / 2;
      const bry = deletedTab.size.height / 2;
      const N = 32;
      const allInside = Array.from({ length: N }, (_, i) => {
        const a = 2 * Math.PI * i / N;
        return ptInTri(bcx + brx * Math.cos(a), bcy + bry * Math.sin(a));
      }).every(Boolean);
      if (allInside) {
        const cxn = (bcx - sX) / sW, cyn = (bcy - sY) / sH;
        const rxn = brx / sW,        ryn = bry / sH;
        survivingTab.holes.push(
          Array.from({ length: N }, (_, i) => {
            const a = 2 * Math.PI * i / N;
            return { x: cxn + rxn * Math.cos(a), y: cyn + ryn * Math.sin(a) };
          })
        );
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'triangle' && deletedTab.triangleVertices) {
      const cutterAbs = deletedTab.triangleVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (cutterAbs.every(p => ptInTri(p.x, p.y))) {
        survivingTab.holes.push(cutterAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'pentagon' && deletedTab.pentagonVertices) {
      const cutterAbs = deletedTab.pentagonVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (cutterAbs.every(p => ptInTri(p.x, p.y))) {
        survivingTab.holes.push(cutterAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'hexagon' && deletedTab.hexagonVertices) {
      const cutterAbs = deletedTab.hexagonVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (cutterAbs.every(p => ptInTri(p.x, p.y))) {
        survivingTab.holes.push(cutterAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }
  }

  if (survivingTab.shape === 'pentagon' && survivingTab.pentagonVertices) {
    const sX = survivingTab.position.x, sY = survivingTab.position.y;
    const sW = survivingTab.size.width,  sH = survivingTab.size.height;
    const pentAbs = survivingTab.pentagonVertices.map(v => ({
      x: sX + v.x * sW, y: sY + v.y * sH,
    }));

    const ptInPent = (px, py) => {
      let sign = 0;
      for (let i = 0; i < pentAbs.length; i++) {
        const a = pentAbs[i], b = pentAbs[(i + 1) % pentAbs.length];
        const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
        if (cross !== 0) {
          const s = cross > 0 ? 1 : -1;
          if (sign === 0) sign = s;
          else if (s !== sign) return false;
        }
      }
      return true;
    };

    if (rectLike(deletedTab.shape)) {
      const bX = deletedTab.position.x, bY = deletedTab.position.y;
      const bW = deletedTab.size.width,  bH = deletedTab.size.height;
      const corners = [
        { x: bX,      y: bY      },
        { x: bX + bW, y: bY      },
        { x: bX + bW, y: bY + bH },
        { x: bX,      y: bY + bH },
      ];
      if (corners.every(p => ptInPent(p.x, p.y))) {
        survivingTab.holes.push(corners.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'circle') {
      const bcx = deletedTab.position.x + deletedTab.size.width  / 2;
      const bcy = deletedTab.position.y + deletedTab.size.height / 2;
      const brx = deletedTab.size.width  / 2;
      const bry = deletedTab.size.height / 2;
      const N = 32;
      const allInside = Array.from({ length: N }, (_, i) => {
        const a = 2 * Math.PI * i / N;
        return ptInPent(bcx + brx * Math.cos(a), bcy + bry * Math.sin(a));
      }).every(Boolean);
      if (allInside) {
        const cxn = (bcx - sX) / sW, cyn = (bcy - sY) / sH;
        const rxn = brx / sW,        ryn = bry / sH;
        survivingTab.holes.push(
          Array.from({ length: N }, (_, i) => {
            const a = 2 * Math.PI * i / N;
            return { x: cxn + rxn * Math.cos(a), y: cyn + ryn * Math.sin(a) };
          })
        );
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'triangle' && deletedTab.triangleVertices) {
      const cutterAbs = deletedTab.triangleVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (cutterAbs.every(p => ptInPent(p.x, p.y))) {
        survivingTab.holes.push(cutterAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'pentagon' && deletedTab.pentagonVertices) {
      const cutterAbs = deletedTab.pentagonVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (cutterAbs.every(p => ptInPent(p.x, p.y))) {
        survivingTab.holes.push(cutterAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'hexagon' && deletedTab.hexagonVertices) {
      const cutterAbs = deletedTab.hexagonVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (cutterAbs.every(p => ptInPent(p.x, p.y))) {
        survivingTab.holes.push(cutterAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }
  }

  if (survivingTab.shape === 'hexagon' && survivingTab.hexagonVertices) {
    const sX = survivingTab.position.x, sY = survivingTab.position.y;
    const sW = survivingTab.size.width,  sH = survivingTab.size.height;
    const hexAbs = survivingTab.hexagonVertices.map(v => ({
      x: sX + v.x * sW, y: sY + v.y * sH,
    }));

    const ptInHex = (px, py) => {
      let sign = 0;
      for (let i = 0; i < hexAbs.length; i++) {
        const a = hexAbs[i], b = hexAbs[(i + 1) % hexAbs.length];
        const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
        if (cross !== 0) {
          const s = cross > 0 ? 1 : -1;
          if (sign === 0) sign = s;
          else if (s !== sign) return false;
        }
      }
      return true;
    };

    if (rectLike(deletedTab.shape)) {
      const bX = deletedTab.position.x, bY = deletedTab.position.y;
      const bW = deletedTab.size.width,  bH = deletedTab.size.height;
      const corners = [
        { x: bX,      y: bY      },
        { x: bX + bW, y: bY      },
        { x: bX + bW, y: bY + bH },
        { x: bX,      y: bY + bH },
      ];
      if (corners.every(p => ptInHex(p.x, p.y))) {
        survivingTab.holes.push(corners.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'circle') {
      const bcx = deletedTab.position.x + deletedTab.size.width  / 2;
      const bcy = deletedTab.position.y + deletedTab.size.height / 2;
      const brx = deletedTab.size.width  / 2;
      const bry = deletedTab.size.height / 2;
      const N = 32;
      const allInside = Array.from({ length: N }, (_, i) => {
        const a = 2 * Math.PI * i / N;
        return ptInHex(bcx + brx * Math.cos(a), bcy + bry * Math.sin(a));
      }).every(Boolean);
      if (allInside) {
        const cxn = (bcx - sX) / sW, cyn = (bcy - sY) / sH;
        const rxn = brx / sW,        ryn = bry / sH;
        survivingTab.holes.push(
          Array.from({ length: N }, (_, i) => {
            const a = 2 * Math.PI * i / N;
            return { x: cxn + rxn * Math.cos(a), y: cyn + ryn * Math.sin(a) };
          })
        );
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'triangle' && deletedTab.triangleVertices) {
      const cutterAbs = deletedTab.triangleVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (cutterAbs.every(p => ptInHex(p.x, p.y))) {
        survivingTab.holes.push(cutterAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'pentagon' && deletedTab.pentagonVertices) {
      const cutterAbs = deletedTab.pentagonVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (cutterAbs.every(p => ptInHex(p.x, p.y))) {
        survivingTab.holes.push(cutterAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }

    if (deletedTab.shape === 'hexagon' && deletedTab.hexagonVertices) {
      const cutterAbs = deletedTab.hexagonVertices.map(v => ({
        x: deletedTab.position.x + v.x * deletedTab.size.width,
        y: deletedTab.position.y + v.y * deletedTab.size.height,
      }));
      if (cutterAbs.every(p => ptInHex(p.x, p.y))) {
        survivingTab.holes.push(cutterAbs.map(p => ({
          x: (p.x - sX) / sW, y: (p.y - sY) / sH,
        })));
        survivingTab.updateShapeClipPath();
        return;
      }
    }
  }

  if (rectLike(survivingTab.shape) && rectLike(deletedTab.shape)) {
    const survivingDistorted = !survivingTab._isRectangular(survivingTab.activeVertices);
    const deletedDistorted   = !deletedTab._isRectangular(deletedTab.activeVertices);

    let diffPoly;
    if (survivingDistorted || deletedDistorted) {
      // At least one shape has been freely distorted — use actual vertex geometry.
      const toAbs = tab => tab.activeVertices.map(v => ({
        x: tab.position.x + v.x * tab.size.width,
        y: tab.position.y + v.y * tab.size.height,
      }));
      diffPoly = computePolygonDifference(toAbs(survivingTab), toAbs(deletedTab));
    } else {
      // Both shapes are axis-aligned rectangles — use the fast rect path.
      const rA = { x: survivingTab.position.x, y: survivingTab.position.y,
                   w: survivingTab.size.width,  h: survivingTab.size.height };
      const rB = { x: deletedTab.position.x,   y: deletedTab.position.y,
                   w: deletedTab.size.width,    h: deletedTab.size.height };
      diffPoly = computeRectDifference(rA, rB);
      console.log('[CARVE] rect+rect — rA:', JSON.stringify(rA), 'rB:', JSON.stringify(rB));
      console.log('[CARVE] rect+rect — diffPoly:', diffPoly ? JSON.stringify(diffPoly) : 'null (no change)');
    }
    if (!diffPoly) return;

    // Vertex count changes (4 → 6 or 8), so rebuild handles from scratch.
    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly); // normalises coords, resizes element
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'triangle' && deletedTab.shape === 'triangle') {
    const toAbs = tab => tab.triangleVertices.map(v => ({
      x: tab.position.x + v.x * tab.size.width,
      y: tab.position.y + v.y * tab.size.height,
    }));
    const diffPoly = computePolygonDifference(toAbs(survivingTab), toAbs(deletedTab));
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'pentagon' && deletedTab.shape === 'pentagon') {
    const toAbs = tab => tab.pentagonVertices.map(v => ({
      x: tab.position.x + v.x * tab.size.width,
      y: tab.position.y + v.y * tab.size.height,
    }));
    const diffPoly = computePolygonDifference(toAbs(survivingTab), toAbs(deletedTab));
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'hexagon' && deletedTab.shape === 'hexagon') {
    const toAbs = tab => tab.hexagonVertices.map(v => ({
      x: tab.position.x + v.x * tab.size.width,
      y: tab.position.y + v.y * tab.size.height,
    }));
    const diffPoly = computePolygonDifference(toAbs(survivingTab), toAbs(deletedTab));
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'pentagon' && deletedTab.shape === 'triangle') {
    const pentPoly = survivingTab.pentagonVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const triPoly = deletedTab.triangleVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(pentPoly, triPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'hexagon' && deletedTab.shape === 'triangle') {
    const hexPoly = survivingTab.hexagonVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const triPoly = deletedTab.triangleVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(hexPoly, triPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'pentagon' && rectLike(deletedTab.shape)) {
    const pentPoly = survivingTab.pentagonVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const rectToAbs = tab => {
      const verts = tab.activeVertices;
      if (verts) return verts.map(v => ({ x: tab.position.x + v.x * tab.size.width,
                                          y: tab.position.y + v.y * tab.size.height }));
      const { x, y } = tab.position, { width: w, height: h } = tab.size;
      return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    };
    const diffPoly = computePolygonDifference(pentPoly, rectToAbs(deletedTab));
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'hexagon' && rectLike(deletedTab.shape)) {
    const hexPoly = survivingTab.hexagonVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const rectToAbs = tab => {
      const verts = tab.activeVertices;
      if (verts) return verts.map(v => ({ x: tab.position.x + v.x * tab.size.width,
                                          y: tab.position.y + v.y * tab.size.height }));
      const { x, y } = tab.position, { width: w, height: h } = tab.size;
      return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    };
    const diffPoly = computePolygonDifference(hexPoly, rectToAbs(deletedTab));
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'triangle' && deletedTab.shape === 'pentagon') {
    const triPoly = survivingTab.triangleVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const pentPoly = deletedTab.pentagonVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(triPoly, pentPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'hexagon' && deletedTab.shape === 'pentagon') {
    const hexPoly = survivingTab.hexagonVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const pentPoly = deletedTab.pentagonVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(hexPoly, pentPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (rectLike(survivingTab.shape) && deletedTab.shape === 'pentagon') {
    const rectToAbs = tab => {
      const verts = tab.activeVertices;
      if (verts) return verts.map(v => ({ x: tab.position.x + v.x * tab.size.width,
                                          y: tab.position.y + v.y * tab.size.height }));
      const { x, y } = tab.position, { width: w, height: h } = tab.size;
      return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    };
    const pentPoly = deletedTab.pentagonVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(rectToAbs(survivingTab), pentPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'triangle' && deletedTab.shape === 'hexagon') {
    const triPoly = survivingTab.triangleVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const hexPoly = deletedTab.hexagonVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(triPoly, hexPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'pentagon' && deletedTab.shape === 'hexagon') {
    const pentPoly = survivingTab.pentagonVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const hexPoly = deletedTab.hexagonVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(pentPoly, hexPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (rectLike(survivingTab.shape) && deletedTab.shape === 'hexagon') {
    const rectToAbs = tab => {
      const verts = tab.activeVertices;
      if (verts) return verts.map(v => ({ x: tab.position.x + v.x * tab.size.width,
                                          y: tab.position.y + v.y * tab.size.height }));
      const { x, y } = tab.position, { width: w, height: h } = tab.size;
      return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    };
    const hexPoly = deletedTab.hexagonVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(rectToAbs(survivingTab), hexPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'triangle' && rectLike(deletedTab.shape)) {
    const triPoly = survivingTab.triangleVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const rectToAbs = tab => {
      const verts = tab.activeVertices;
      if (verts) return verts.map(v => ({ x: tab.position.x + v.x * tab.size.width,
                                          y: tab.position.y + v.y * tab.size.height }));
      const { x, y } = tab.position, { width: w, height: h } = tab.size;
      return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    };
    const diffPoly = computePolygonDifference(triPoly, rectToAbs(deletedTab));
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (rectLike(survivingTab.shape) && deletedTab.shape === 'triangle') {
    const rectToAbs = tab => {
      const verts = tab.activeVertices;
      if (verts) return verts.map(v => ({ x: tab.position.x + v.x * tab.size.width,
                                          y: tab.position.y + v.y * tab.size.height }));
      const { x, y } = tab.position, { width: w, height: h } = tab.size;
      return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    };
    const triPoly = deletedTab.triangleVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(rectToAbs(survivingTab), triPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (rectLike(survivingTab.shape) && deletedTab.shape === 'circle') {
    // Rect/rounded surviving, circle deleted.
    // Build a polygon for the rect (use existing vertices if distorted, else bounding box).
    const rectToAbs = tab => {
      const verts = tab.activeVertices;
      if (verts) return verts.map(v => ({ x: tab.position.x + v.x * tab.size.width,
                                          y: tab.position.y + v.y * tab.size.height }));
      const { x, y } = tab.position, { width: w, height: h } = tab.size;
      return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    };
    const circPoly = ellipseApproxPoly(
      deletedTab.position.x + deletedTab.size.width  / 2,
      deletedTab.position.y + deletedTab.size.height / 2,
      deletedTab.size.width / 2, deletedTab.size.height / 2, 64
    );
    const diffPoly = computePolygonDifference(rectToAbs(survivingTab), circPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'circle' && rectLike(deletedTab.shape)) {
    // Circle surviving, rect/rounded deleted.
    const circPoly = ellipseApproxPoly(
      survivingTab.position.x + survivingTab.size.width  / 2,
      survivingTab.position.y + survivingTab.size.height / 2,
      survivingTab.size.width / 2, survivingTab.size.height / 2, 64
    );
    const rectToAbs = tab => {
      const verts = tab.activeVertices;
      if (verts) return verts.map(v => ({ x: tab.position.x + v.x * tab.size.width,
                                          y: tab.position.y + v.y * tab.size.height }));
      const { x, y } = tab.position, { width: w, height: h } = tab.size;
      return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    };
    const diffPoly = computePolygonDifference(circPoly, rectToAbs(deletedTab));
    if (!diffPoly) return;

    // Switch surviving circle from CSS to polygon mode.
    survivingTab.element.style.borderWidth   = '3px';
    survivingTab.element.style.borderRadius  = '0';
    survivingTab.element.style.borderColor   = 'transparent';
    survivingTab.element.style.boxShadow     = 'none';
    survivingTab.element.style.filter        = 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.3))';
    survivingTab.element.style.transition    = 'box-shadow 0.2s, transform 0.2s, filter 0.2s';

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'pentagon' && deletedTab.shape === 'circle') {
    const pentPoly = survivingTab.pentagonVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const circPoly = ellipseApproxPoly(
      deletedTab.position.x + deletedTab.size.width  / 2,
      deletedTab.position.y + deletedTab.size.height / 2,
      deletedTab.size.width / 2, deletedTab.size.height / 2, 64
    );
    const diffPoly = computePolygonDifference(pentPoly, circPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'hexagon' && deletedTab.shape === 'circle') {
    const hexPoly = survivingTab.hexagonVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const circPoly = ellipseApproxPoly(
      deletedTab.position.x + deletedTab.size.width  / 2,
      deletedTab.position.y + deletedTab.size.height / 2,
      deletedTab.size.width / 2, deletedTab.size.height / 2, 64
    );
    const diffPoly = computePolygonDifference(hexPoly, circPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'circle' && deletedTab.shape === 'pentagon') {
    const circPoly = ellipseApproxPoly(
      survivingTab.position.x + survivingTab.size.width  / 2,
      survivingTab.position.y + survivingTab.size.height / 2,
      survivingTab.size.width / 2, survivingTab.size.height / 2, 64
    );
    const pentPoly = deletedTab.pentagonVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(circPoly, pentPoly);
    if (!diffPoly) return;

    survivingTab.element.style.borderWidth   = '3px';
    survivingTab.element.style.borderRadius  = '0';
    survivingTab.element.style.borderColor   = 'transparent';
    survivingTab.element.style.boxShadow     = 'none';
    survivingTab.element.style.filter        = 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.3))';
    survivingTab.element.style.transition    = 'box-shadow 0.2s, transform 0.2s, filter 0.2s';

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'circle' && deletedTab.shape === 'hexagon') {
    const circPoly = ellipseApproxPoly(
      survivingTab.position.x + survivingTab.size.width  / 2,
      survivingTab.position.y + survivingTab.size.height / 2,
      survivingTab.size.width / 2, survivingTab.size.height / 2, 64
    );
    const hexPoly = deletedTab.hexagonVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(circPoly, hexPoly);
    if (!diffPoly) return;

    survivingTab.element.style.borderWidth   = '3px';
    survivingTab.element.style.borderRadius  = '0';
    survivingTab.element.style.borderColor   = 'transparent';
    survivingTab.element.style.boxShadow     = 'none';
    survivingTab.element.style.filter        = 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.3))';
    survivingTab.element.style.transition    = 'box-shadow 0.2s, transform 0.2s, filter 0.2s';

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'triangle' && deletedTab.shape === 'circle') {
    const triPoly = survivingTab.triangleVertices.map(v => ({
      x: survivingTab.position.x + v.x * survivingTab.size.width,
      y: survivingTab.position.y + v.y * survivingTab.size.height,
    }));
    const circPoly = ellipseApproxPoly(
      deletedTab.position.x + deletedTab.size.width  / 2,
      deletedTab.position.y + deletedTab.size.height / 2,
      deletedTab.size.width / 2, deletedTab.size.height / 2, 64
    );
    const diffPoly = computePolygonDifference(triPoly, circPoly);
    if (!diffPoly) return;

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly);
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'circle' && deletedTab.shape === 'triangle') {
    const circPoly = ellipseApproxPoly(
      survivingTab.position.x + survivingTab.size.width  / 2,
      survivingTab.position.y + survivingTab.size.height / 2,
      survivingTab.size.width / 2, survivingTab.size.height / 2, 64
    );
    const triPoly = deletedTab.triangleVertices.map(v => ({
      x: deletedTab.position.x + v.x * deletedTab.size.width,
      y: deletedTab.position.y + v.y * deletedTab.size.height,
    }));
    const diffPoly = computePolygonDifference(circPoly, triPoly);
    if (!diffPoly) return;

    // Switch surviving circle from CSS to polygon mode (same as circle-circle diff).
    survivingTab.element.style.borderWidth   = '3px';
    survivingTab.element.style.borderRadius  = '0';
    survivingTab.element.style.borderColor   = 'transparent';
    survivingTab.element.style.boxShadow     = 'none';
    survivingTab.element.style.filter        = 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.3))';
    survivingTab.element.style.transition    = 'box-shadow 0.2s, transform 0.2s, filter 0.2s';

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(diffPoly); // sets circleVertices via activeVertices setter
    survivingTab.createVertexHandles();

  } else if (survivingTab.shape === 'circle' && deletedTab.shape === 'circle') {
    const verts = computeCircleDifferenceVertices(survivingTab, deletedTab);
    if (!verts) return;

    // Switch surviving circle from CSS rendering to polygon mode.
    // border-width must be 3px (= ::after inset magnitude) so the ::after element
    // is sized W×H relative to the border-box — the same assumption made by
    // updateShapeClipPath when it places SVG polygon coords at vx*100/vy*100.
    // The circle CSS class sets border-width:7px; leaving it causes the ::after to
    // be only (W-8)×(H-8), misaligning the SVG mask from the clip-path and making
    // the border look uneven and leaving a 4px dark gap at the bite edge.
    survivingTab.element.style.borderWidth   = '3px';
    survivingTab.element.style.borderRadius  = '0';
    survivingTab.element.style.borderColor   = 'transparent';
    survivingTab.element.style.boxShadow     = 'none';
    survivingTab.element.style.filter        = 'drop-shadow(0 8px 16px rgba(0, 0, 0, 0.3))';
    survivingTab.element.style.transition    = 'box-shadow 0.2s, transform 0.2s, filter 0.2s';

    survivingTab.removeVertexHandles();
    survivingTab.applyVertexLayout(verts); // sets circleVertices, calls updateShapeClipPath
    survivingTab.createVertexHandles();
  }
}

// Delete key closes active tab; if overlapping tabs behind it, carves its shape from them
document.addEventListener('keydown', (e) => {
  if (e.key === 'Delete' && activeTab) {
    e.preventDefault();
    const rectLike = s => s === 'rectangle' || s === 'rounded';
    const differenceEligible = s => rectLike(s) || s === 'circle' || s === 'triangle' || s === 'pentagon' || s === 'hexagon';
    const carveSnapshots = [];
    console.log('[DELETE] fired. activeTab:', activeTab.id, 'shape:', activeTab.shape);
    console.log('[DELETE] all tabs:', tabs.map(t => ({ id: t.id, shape: t.shape, z: t.element?.style.zIndex, isMerged: t.isMerged })));
    if (differenceEligible(activeTab.shape)) {
      const activeZ = getEntryMaxStackZ(activeTab);
      console.log('[DELETE] activeZ:', activeZ);
      for (const other of tabs) {
        if (other === activeTab || other.isMerged) continue;
        const circleOrTriangle = s => s === 'circle' || s === 'triangle';
        if (rectLike(activeTab.shape) && !rectLike(other.shape) && other.shape !== 'circle' && other.shape !== 'triangle' && other.shape !== 'pentagon' && other.shape !== 'hexagon') continue;
        if (activeTab.shape === 'circle'   && !rectLike(other.shape) && !circleOrTriangle(other.shape) && other.shape !== 'pentagon' && other.shape !== 'hexagon') continue;
        const otherZ = getEntryMaxStackZ(other);
        console.log('[DELETE] candidate tab:', other.id, 'otherZ:', otherZ, '— skipping?', otherZ >= activeZ);
        if (otherZ >= activeZ) continue;
        console.log('[DELETE] → calling applyBooleanDifference on tab', other.id);
        carveSnapshots.push(snapshotTabForCarve(other));
        applyBooleanDifference(other, activeTab);
      }
    } else {
      console.log('[DELETE] activeTab shape not differenceEligible:', activeTab.shape);
    }
    if (carveSnapshots.length > 0) {
      undoStack.push({ type: 'carve', snapshots: carveSnapshots });
    }
    activeTab.close();
  }
});

// Ctrl+Z — undo last merge or carve
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    const idx = undoStack.findLastIndex(e => e.type === 'merge' || e.type === 'merge-add' || e.type === 'carve');
    if (idx === -1) return;
    const entry = undoStack.splice(idx, 1)[0];
    if (entry.type === 'merge') {
      entry.mergedTab.unmerge();
    } else if (entry.type === 'merge-add') {
      entry.mergedTab.removeTab(entry.tab);
    } else {
      for (const snap of entry.snapshots) restoreCarveSnapshot(snap);
    }
  }
});

// Ctrl+U — unmerge the active merged tab
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'u') {
    if (activeTab && activeTab.isMerged) {
      e.preventDefault();
      activeTab.unmerge();
    }
  }
});

// Keyboard shortcuts for shape changes
document.addEventListener('keydown', (e) => {
  // Only if Ctrl (or Cmd on Mac) is pressed
  if (e.ctrlKey || e.metaKey) {
    if (!activeTab) return;

    let newShape = null;
    
    switch(e.key) {
      case '1':
        newShape = 'circle';
        break;
      case '2':
        newShape = 'rounded';
        break;
      case '3':
        newShape = 'triangle';
        break;
      case '4':
        newShape = 'rectangle';
        break;
      case '5':
        newShape = 'pentagon';
        break;
      case '6':
        newShape = 'hexagon';
        break;
    }

    if (newShape) {
      e.preventDefault();
      activeTab.changeShape(newShape);
    }
  }
});

// Toolbar buttons
newTabBtn.addEventListener('click', () => {
  console.log('New tab button clicked');
  try {
    const tab = new TabWindow('https://kenjimoss.github.io/portfolio/');
    tab.activate();
    console.log('Tab created successfully');
  } catch (error) {
    console.error('Error creating tab:', error);
  }
});

goBtn.addEventListener('click', () => {
  let url = urlInput.value.trim();
  
  if (!url) return;
  
  // Add protocol if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    // Check if it looks like a URL or a search query
    if (url.includes('.') && !url.includes(' ')) {
      url = 'https://' + url;
    } else {
      // Treat as Google search
      url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
    }
  }
  
  if (activeTab) {
    activeTab.updateUrl(url);
  } else {
    const tab = new TabWindow(url);
    tab.activate();
  }
});

urlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    goBtn.click();
  }
});

// Initialize - wait for DOM to be ready
console.log('Renderer script loaded');
console.log('Workspace element:', workspace);
console.log('Template element:', tabTemplate);

// Create initial tab after a short delay to ensure everything is loaded
setTimeout(() => {
  console.log('Creating initial tab...');
  try {
    const initialTab = new TabWindow('https://kenjimoss.github.io/portfolio/');
    initialTab.activate();
    console.log('Initial tab created successfully');
    console.log('Keyboard shortcuts:');
    console.log('  Ctrl+1 = Circle');
    console.log('  Ctrl+2 = Rounded Rectangle');
    console.log('  Ctrl+3 = Triangle');
    console.log('  Ctrl+4 = Rectangle');
    console.log('  Ctrl+5 = Pentagon');
    console.log('  Ctrl+6 = Hexagon');
  } catch (error) {
    console.error('Error creating initial tab:', error);
  }
}, 100);

console.log('Tab Window Browser initialized!');
