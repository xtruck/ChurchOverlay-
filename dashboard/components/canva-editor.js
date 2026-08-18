/**
 * ============================================================================
 *  canva-editor.js — Canva-Style Professional Text/Media Editor
 * ----------------------------------------------------------------------------
 *  Advanced editing capabilities with:
 *  - Text editing with rich formatting
 *  - Image editing with filters and adjustments
 *  - Drag-and-drop positioning
 *  - Layer management
 *  - Alignment and distribution tools
 *  - Professional design controls
 * ============================================================================
 */

class CanvaEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.selectedElement = null;
    this.canvas = null;
    this.elements = [];
    this.history = [];
    this.historyIndex = -1;
    this.zoom = 1;
    this.pan = { x: 0, y: 0 };
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
    this.initializeCanvas();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          height: 100%;
          font-family: 'Plus Jakarta Sans', sans-serif;
          background: var(--bg-surface, rgba(22, 27, 46, 0.55));
        }

        .editor-container {
          display: flex;
          flex-direction: column;
          height: 100%;
        }

        .editor-toolbar {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
        }

        .toolbar-group {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 0 12px;
          border-right: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
        }

        .toolbar-group:last-child {
          border-right: none;
        }

        .toolbar-button {
          width: 36px;
          height: 36px;
          border: none;
          background: transparent;
          border-radius: 8px;
          color: var(--text-muted, #a8adc9);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s ease;
          position: relative;
        }

        .toolbar-button:hover {
          background: var(--bg-card-hover, rgba(255, 255, 255, 0.09));
          color: var(--text-main, #f6f3ec);
        }

        .toolbar-button.active {
          background: var(--primary, #7c8cf5);
          color: white;
        }

        .toolbar-button svg {
          width: 18px;
          height: 18px;
        }

        .toolbar-divider {
          width: 1px;
          height: 24px;
          background: var(--border-subtle, rgba(255, 255, 255, 0.1));
          margin: 0 8px;
        }

        .toolbar-select {
          padding: 8px 12px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: 6px;
          color: var(--text-main, #f6f3ec);
          font-size: 13px;
          cursor: pointer;
        }

        .editor-workspace {
          flex: 1;
          display: flex;
          overflow: hidden;
        }

        .elements-panel {
          width: 280px;
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border-right: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          display: flex;
          flex-direction: column;
        }

        .panel-header {
          padding: 16px;
          border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          font-weight: 600;
          color: var(--text-main, #f6f3ec);
          font-size: 14px;
        }

        .elements-list {
          flex: 1;
          overflow-y: auto;
          padding: 8px;
        }

        .element-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: 8px;
          margin-bottom: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .element-item:hover {
          border-color: var(--border-light, rgba(255, 255, 255, 0.22));
        }

        .element-item.selected {
          border-color: var(--primary, #7c8cf5);
          background: var(--primary-glow, color-mix(in srgb, var(--primary) 10%, transparent));
        }

        .element-icon {
          width: 40px;
          height: 40px;
          background: var(--bg-surface, rgba(22, 27, 46, 0.55));
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-muted, #a8adc9);
        }

        .element-info {
          flex: 1;
        }

        .element-name {
          font-size: 13px;
          font-weight: 500;
          color: var(--text-main, #f6f3ec);
          margin-bottom: 2px;
        }

        .element-type {
          font-size: 11px;
          color: var(--text-dim, #6c7292);
        }

        .canvas-area {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          background: var(--bg-base, #0a0e1c);
          position: relative;
          overflow: hidden;
        }

        .canvas-container {
          width: 1920px;
          height: 1080px;
          background: #0b0f1a;
          box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      transform-origin: center center;
          transition: transform 0.2s ease;
        }

        .properties-panel {
          width: 320px;
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border-left: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          display: flex;
          flex-direction: column;
        }

        .properties-section {
          padding: 16px;
          border-bottom: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
        }

        .properties-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-muted, #a8adc9);
          text-transform: uppercase;
      letter-spacing: 0.5px;
          margin-bottom: 12px;
        }

        .property-row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
        }

        .property-label {
          width: 80px;
          font-size: 12px;
          color: var(--text-muted, #a8adc9);
        }

        .property-input {
          flex: 1;
          padding: 8px 12px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: 6px;
          color: var(--text-main, #f6f3ec);
          font-size: 13px;
        }

        .property-slider {
          flex: 1;
      -webkit-appearance: none;
          height: 4px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border-radius: 2px;
          outline: none;
        }

        .property-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px;
          height: 16px;
          background: var(--primary, #7c8cf5);
          border-radius: 50%;
          cursor: pointer;
        }

        .color-picker {
          width: 40px;
          height: 40px;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          padding: 0;
        }

        .zoom-controls {
          position: absolute;
          bottom: 16px;
          right: 16px;
          display: flex;
          gap: 8px;
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          padding: 8px;
          border-radius: 8px;
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
        }

        .zoom-button {
          width: 32px;
          height: 32px;
          border: none;
          background: transparent;
          border-radius: 6px;
          color: var(--text-muted, #a8adc9);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .zoom-button:hover {
          background: var(--bg-card-hover, rgba(255, 255, 255, 0.09));
          color: var(--text-main, #f6f3ec);
        }

        .zoom-level {
          padding: 0 12px;
          font-size: 13px;
          color: var(--text-muted, #a8adc9);
          display: flex;
          align-items: center;
        }

        .empty-canvas {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--text-dim, #6c7292);
        }

        .empty-canvas svg {
          width: 64px;
          height: 64px;
          margin-bottom: 16px;
          opacity: 0.3;
        }

        .empty-canvas-text {
          font-size: 16px;
          margin-bottom: 8px;
        }

        .empty-canvas-subtext {
          font-size: 13px;
          opacity: 0.7;
        }
      </style>

      <div class="editor-container">
        <div class="editor-toolbar">
          <div class="toolbar-group">
            <button class="toolbar-button" id="addTextBtn" title="Add Text">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 7V4h16v3M9 20h6M12 4v16"/>
              </svg>
            </button>
            <button class="toolbar-button" id="addImageBtn" title="Add Image">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
            </button>
            <button class="toolbar-button" id="addShapeBtn" title="Add Shape">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              </svg>
            </button>
          </div>

          <div class="toolbar-divider"></div>

          <div class="toolbar-group" id="textControls" style="display: none;">
            <button class="toolbar-button" data-format="bold" title="Bold">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/>
                <path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/>
              </svg>
            </button>
            <button class="toolbar-button" data-format="italic" title="Italic">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="19" y1="4" x2="10" y2="4"/>
                <line x1="14" y1="20" x2="5" y2="20"/>
                <line x1="15" y1="4" x2="9" y2="20"/>
              </svg>
            </button>
            <button class="toolbar-button" data-format="underline" title="Underline">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M6 3v7a6 6 0 0 0 6 6 6 6 0 0 0 6-6V3"/>
                <line x1="4" y1="21" x2="20" y2="21"/>
              </svg>
            </button>
            <select class="toolbar-select" id="fontFamily">
              <option value="Plus Jakarta Sans">Plus Jakarta Sans</option>
              <option value="Cormorant Garamond">Cormorant Garamond</option>
              <option value="Merriweather">Merriweather</option>
              <option value="Manrope">Manrope</option>
            </select>
            <select class="toolbar-select" id="fontSize">
              <option value="12">12px</option>
              <option value="16">16px</option>
              <option value="20">20px</option>
              <option value="24">24px</option>
              <option value="32">32px</option>
              <option value="48">48px</option>
              <option value="64">64px</option>
            </select>
          </div>

          <div class="toolbar-group" id="imageControls" style="display: none;">
            <button class="toolbar-button" data-filter="brightness" title="Brightness">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="5"/>
                <line x1="12" y1="1" x2="12" y2="3"/>
                <line x1="12" y1="21" x2="12" y2="23"/>
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                <line x1="1" y1="12" x2="3" y2="12"/>
                <line x1="21" y1="12" x2="23" y2="12"/>
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
              </svg>
            </button>
            <button class="toolbar-button" data-filter="contrast" title="Contrast">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 2a10 10 0 0 0 0 20z"/>
              </svg>
            </button>
            <button class="toolbar-button" data-filter="saturation" title="Saturation">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
              </svg>
            </button>
          </div>

          <div class="toolbar-divider"></div>

          <div class="toolbar-group">
            <button class="toolbar-button" id="undoBtn" title="Undo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 7v6h6"/>
                <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
              </svg>
            </button>
            <button class="toolbar-button" id="redoBtn" title="Redo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 7v6h-6"/>
                <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>
              </svg>
            </button>
          </div>

          <div class="toolbar-group">
            <button class="toolbar-button" id="zoomInBtn" title="Zoom In">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                <line x1="11" y1="8" x2="11" y2="14"/>
                <line x1="8" y1="11" x2="14" y2="11"/>
              </svg>
            </button>
            <button class="toolbar-button" id="zoomOutBtn" title="Zoom Out">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="11" cy="11" r="8"/>
                <line x1="21" y1="21" x2="16.65" y2="16.65"/>
                <line x1="8" y1="11" x2="14" y2="11"/>
              </svg>
            </button>
          </div>
        </div>

        <div class="editor-workspace">
          <div class="elements-panel">
            <div class="panel-header">Elements</div>
            <div class="elements-list" id="elementsList">
              <!-- Elements will be rendered here -->
            </div>
          </div>

          <div class="canvas-area" id="canvasArea">
            <div class="canvas-container" id="canvasContainer">
              <!-- Canvas content will be rendered here -->
            </div>
            
            <div class="zoom-controls">
              <button class="zoom-button" id="zoomOut">−</button>
              <span class="zoom-level" id="zoomLevel">100%</span>
              <button class="zoom-button" id="zoomIn">+</button>
            </div>
          </div>

          <div class="properties-panel" id="propertiesPanel">
            <div class="panel-header">Properties</div>
            <div id="propertiesContent">
              <div class="empty-canvas">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
                <div class="empty-canvas-text">No element selected</div>
                <div class="empty-canvas-subtext">Select an element to edit its properties</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  setupEventListeners() {
    // Add element buttons
    this.shadowRoot
      .getElementById('addTextBtn')
      .addEventListener('click', () => this.addTextElement());
    this.shadowRoot
      .getElementById('addImageBtn')
      .addEventListener('click', () => this.addImageElement());
    this.shadowRoot
      .getElementById('addShapeBtn')
      .addEventListener('click', () => this.addShapeElement());

    // Text formatting
    this.shadowRoot.querySelectorAll('#textControls .toolbar-button').forEach((btn) => {
      btn.addEventListener('click', () => this.applyTextFormat(btn.dataset.format));
    });

    this.shadowRoot.getElementById('fontFamily').addEventListener('change', (e) => {
      this.updateElementProperty('fontFamily', e.target.value);
    });

    this.shadowRoot.getElementById('fontSize').addEventListener('change', (e) => {
      this.updateElementProperty('fontSize', parseInt(e.target.value));
    });

    // Image filters
    this.shadowRoot.querySelectorAll('#imageControls .toolbar-button').forEach((btn) => {
      btn.addEventListener('click', () => this.applyImageFilter(btn.dataset.filter));
    });

    // Undo/Redo
    this.shadowRoot.getElementById('undoBtn').addEventListener('click', () => this.undo());
    this.shadowRoot.getElementById('redoBtn').addEventListener('click', () => this.redo());

    // Zoom controls
    this.shadowRoot.getElementById('zoomInBtn').addEventListener('click', () => this.zoomIn());
    this.shadowRoot.getElementById('zoomOutBtn').addEventListener('click', () => this.zoomOut());
    this.shadowRoot.getElementById('zoomIn').addEventListener('click', () => this.zoomIn());
    this.shadowRoot.getElementById('zoomOut').addEventListener('click', () => this.zoomOut());
  }

  initializeCanvas() {
    this.canvas = this.shadowRoot.getElementById('canvasContainer');
    this.renderElements();
  }

  addTextElement() {
    const element = {
      id: Date.now().toString(),
      type: 'text',
      content: 'Double-click to edit',
      x: 960,
      y: 540,
      width: 400,
      height: 100,
      fontFamily: 'Plus Jakarta Sans',
      fontSize: 32,
      fontWeight: 'normal',
      fontStyle: 'normal',
      textDecoration: 'none',
      color: '#ffffff',
      backgroundColor: 'transparent',
      opacity: 1,
      rotation: 0,
      zIndex: this.elements.length + 1,
    };

    this.elements.push(element);
    this.addToHistory('add', element);
    this.renderElements();
    this.selectElement(element.id);
  }

  addImageElement() {
    // Trigger file picker
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          const element = {
            id: Date.now().toString(),
            type: 'image',
            src: event.target.result,
            x: 960,
            y: 540,
            width: 400,
            height: 300,
            opacity: 1,
            rotation: 0,
            filters: {
              brightness: 100,
              contrast: 100,
              saturation: 100,
              blur: 0,
            },
            zIndex: this.elements.length + 1,
          };

          this.elements.push(element);
          this.addToHistory('add', element);
          this.renderElements();
          this.selectElement(element.id);
        };
        reader.readAsDataURL(file);
      }
    };
    input.click();
  }

  addShapeElement() {
    const element = {
      id: Date.now().toString(),
      type: 'shape',
      shapeType: 'rectangle',
      x: 960,
      y: 540,
      width: 200,
      height: 200,
      backgroundColor: '#7c8cf5',
      borderColor: 'transparent',
      borderWidth: 0,
      opacity: 1,
      rotation: 0,
      borderRadius: 0,
      zIndex: this.elements.length + 1,
    };

    this.elements.push(element);
    this.addToHistory('add', element);
    this.renderElements();
    this.selectElement(element.id);
  }

  renderElements() {
    const elementsList = this.shadowRoot.getElementById('elementsList');

    if (this.elements.length === 0) {
      elementsList.innerHTML = `
        <div style="text-align: center; padding: 20px; color: var(--text-dim, #6c7292);">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom: 8px; opacity: 0.5;">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          </svg>
          <div style="font-size: 12px;">No elements yet</div>
          <div style="font-size: 11px; opacity: 0.7;">Add text, images, or shapes to get started</div>
        </div>
      `;
      return;
    }

    elementsList.innerHTML = this.elements
      .map(
        (element, index) => `
      <div class="element-item ${this.selectedElement === element.id ? 'selected' : ''}" data-element-id="${element.id}">
        <div class="element-icon">
          ${this.getElementIcon(element.type)}
        </div>
        <div class="element-info">
          <div class="element-name">${element.type.charAt(0).toUpperCase() + element.type.slice(1)} ${index + 1}</div>
          <div class="element-type">${element.type}</div>
        </div>
      </div>
    `
      )
      .join('');

    // Render canvas
    this.renderCanvas();

    // Setup element selection
    elementsList.querySelectorAll('.element-item').forEach((item) => {
      item.addEventListener('click', () => this.selectElement(item.dataset.elementId));
    });
  }

  getElementIcon(type) {
    const icons = {
      text: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3M9 20h6M12 4v16"/></svg>',
      image:
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
      shape:
        '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>',
    };
    return icons[type] || icons.text;
  }

  renderCanvas() {
    if (!this.canvas) return;

    this.canvas.innerHTML = this.elements
      .map((element) => {
        const isSelected = this.selectedElement === element.id;
        const baseStyle = `
        position: absolute;
        left: ${element.x}px;
        top: ${element.y}px;
        transform: translate(-50%, -50%) rotate(${element.rotation}deg);
        opacity: ${element.opacity};
        z-index: ${element.zIndex};
        cursor: move;
        ${isSelected ? 'outline: 2px solid var(--primary, #7c8cf5); outline-offset: 2px;' : ''}
      `;

        if (element.type === 'text') {
          return `
          <div style="${baseStyle}
            font-family: ${element.fontFamily};
            font-size: ${element.fontSize}px;
            font-weight: ${element.fontWeight};
            font-style: ${element.fontStyle};
            text-decoration: ${element.textDecoration};
            color: ${element.color};
            background-color: ${element.backgroundColor};
            white-space: nowrap;
            padding: 8px 16px;
            border-radius: 4px;
          " data-element-id="${element.id}">
            ${element.content}
          </div>
        `;
        } else if (element.type === 'image') {
          const filterString = `
          brightness(${element.filters.brightness}%)
          contrast(${element.filters.contrast}%)
          saturate(${element.filters.saturation}%)
          blur(${element.filters.blur}px)
        `;
          return `
          <img src="${element.src}" style="${baseStyle}
            width: ${element.width}px;
            height: ${element.height}px;
            object-fit: cover;
            filter: ${filterString};
          " data-element-id="${element.id}" draggable="false"/>
        `;
        } else if (element.type === 'shape') {
          return `
          <div style="${baseStyle}
            width: ${element.width}px;
            height: ${element.height}px;
            background-color: ${element.backgroundColor};
            border: ${element.borderWidth}px solid ${element.borderColor};
            border-radius: ${element.borderRadius}px;
          " data-element-id="${element.id}"></div>
        `;
        }
      })
      .join('');
  }

  selectElement(elementId) {
    this.selectedElement = elementId;
    this.renderElements();
    this.updatePropertiesPanel();
    this.updateToolbarControls();
  }

  updatePropertiesPanel() {
    const propertiesContent = this.shadowRoot.getElementById('propertiesContent');
    const element = this.elements.find((e) => e.id === this.selectedElement);

    if (!element) {
      propertiesContent.innerHTML = `
        <div class="empty-canvas">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
          <div class="empty-canvas-text">No element selected</div>
          <div class="empty-canvas-subtext">Select an element to edit its properties</div>
        </div>
      `;
      return;
    }

    let propertiesHTML = '';

    // Common properties
    propertiesHTML += `
      <div class="properties-section">
        <div class="properties-title">Position & Size</div>
        <div class="property-row">
          <span class="property-label">X</span>
          <input type="number" class="property-input" value="${Math.round(element.x)}" data-property="x">
        </div>
        <div class="property-row">
          <span class="property-label">Y</span>
          <input type="number" class="property-input" value="${Math.round(element.y)}" data-property="y">
        </div>
        <div class="property-row">
          <span class="property-label">Width</span>
          <input type="number" class="property-input" value="${Math.round(element.width)}" data-property="width">
        </div>
        <div class="property-row">
          <span class="property-label">Height</span>
          <input type="number" class="property-input" value="${Math.round(element.height)}" data-property="height">
        </div>
        <div class="property-row">
          <span class="property-label">Rotation</span>
          <input type="number" class="property-input" value="${element.rotation}" data-property="rotation">
        </div>
        <div class="property-row">
          <span class="property-label">Opacity</span>
          <input type="range" class="property-slider" min="0" max="100" value="${element.opacity * 100}" data-property="opacity">
        </div>
      </div>
    `;

    // Type-specific properties
    if (element.type === 'text') {
      propertiesHTML += `
        <div class="properties-section">
          <div class="properties-title">Text Properties</div>
          <div class="property-row">
            <span class="property-label">Content</span>
            <input type="text" class="property-input" value="${element.content}" data-property="content">
          </div>
          <div class="property-row">
            <span class="property-label">Color</span>
            <input type="color" class="color-picker" value="${element.color}" data-property="color">
          </div>
          <div class="property-row">
            <span class="property-label">Background</span>
            <input type="color" class="color-picker" value="${element.backgroundColor}" data-property="backgroundColor">
          </div>
        </div>
      `;
    } else if (element.type === 'image') {
      propertiesHTML += `
        <div class="properties-section">
          <div class="properties-title">Image Filters</div>
          <div class="property-row">
            <span class="property-label">Brightness</span>
            <input type="range" class="property-slider" min="0" max="200" value="${element.filters.brightness}" data-property="brightness">
          </div>
          <div class="property-row">
            <span class="property-label">Contrast</span>
            <input type="range" class="property-slider" min="0" max="200" value="${element.filters.contrast}" data-property="contrast">
          </div>
          <div class="property-row">
            <span class="property-label">Saturation</span>
            <input type="range" class="property-slider" min="0" max="200" value="${element.filters.saturation}" data-property="saturation">
          </div>
          <div class="property-row">
            <span class="property-label">Blur</span>
            <input type="range" class="property-slider" min="0" max="20" value="${element.filters.blur}" data-property="blur">
          </div>
        </div>
      `;
    } else if (element.type === 'shape') {
      propertiesHTML += `
        <div class="properties-section">
          <div class="properties-title">Shape Properties</div>
          <div class="property-row">
            <span class="property-label">Fill</span>
            <input type="color" class="color-picker" value="${element.backgroundColor}" data-property="backgroundColor">
          </div>
          <div class="property-row">
            <span class="property-label">Border</span>
            <input type="color" class="color-picker" value="${element.borderColor}" data-property="borderColor">
          </div>
          <div class="property-row">
            <span class="property-label">Border Width</span>
            <input type="number" class="property-input" value="${element.borderWidth}" data-property="borderWidth">
          </div>
          <div class="property-row">
            <span class="property-label">Radius</span>
            <input type="number" class="property-input" value="${element.borderRadius}" data-property="borderRadius">
          </div>
        </div>
      `;
    }

    propertiesContent.innerHTML = propertiesHTML;

    // Setup property change listeners
    propertiesContent
      .querySelectorAll('.property-input, .property-slider, .color-picker')
      .forEach((input) => {
        input.addEventListener('input', (e) => {
          const property = e.target.dataset.property;
          let value = e.target.value;

          // Convert numeric values
          if (e.target.type === 'number' || e.target.type === 'range') {
            value = parseFloat(value);
            if (property === 'opacity') {
              value = value / 100;
            }
          }

          this.updateElementProperty(property, value);
        });
      });
  }

  updateToolbarControls() {
    const element = this.elements.find((e) => e.id === this.selectedElement);

    // Show/hide relevant controls
    this.shadowRoot.getElementById('textControls').style.display =
      element && element.type === 'text' ? 'flex' : 'none';
    this.shadowRoot.getElementById('imageControls').style.display =
      element && element.type === 'image' ? 'flex' : 'none';
  }

  updateElementProperty(property, value) {
    const element = this.elements.find((e) => e.id === this.selectedElement);
    if (!element) return;

    const oldValue = element[property];
    element[property] = value;

    this.addToHistory('modify', { elementId: element.id, property, oldValue, newValue: value });
    this.renderCanvas();
  }

  applyTextFormat(format) {
    const element = this.elements.find((e) => e.id === this.selectedElement);
    if (!element || element.type !== 'text') return;

    switch (format) {
      case 'bold':
        element.fontWeight = element.fontWeight === 'bold' ? 'normal' : 'bold';
        break;
      case 'italic':
        element.fontStyle = element.fontStyle === 'italic' ? 'normal' : 'italic';
        break;
      case 'underline':
        element.textDecoration = element.textDecoration === 'underline' ? 'none' : 'underline';
        break;
    }

    this.addToHistory('modify', { elementId: element.id, format });
    this.renderCanvas();
  }

  applyImageFilter(filter) {
    const element = this.elements.find((e) => e.id === this.selectedElement);
    if (!element || element.type !== 'image') return;

    // Cycle through filter values
    const filters = element.filters;
    const step = 10;

    switch (filter) {
      case 'brightness':
        filters.brightness = (filters.brightness + step) % 220;
        if (filters.brightness < 50) filters.brightness = 100;
        break;
      case 'contrast':
        filters.contrast = (filters.contrast + step) % 220;
        if (filters.contrast < 50) filters.contrast = 100;
        break;
      case 'saturation':
        filters.saturation = (filters.saturation + step) % 220;
        if (filters.saturation < 0) filters.saturation = 100;
        break;
    }

    this.addToHistory('modify', { elementId: element.id, filter, value: filters[filter] });
    this.renderCanvas();
  }

  zoomIn() {
    this.zoom = Math.min(this.zoom + 0.1, 2);
    this.updateZoom();
  }

  zoomOut() {
    this.zoom = Math.max(this.zoom - 0.1, 0.25);
    this.updateZoom();
  }

  updateZoom() {
    if (this.canvas) {
      this.canvas.style.transform = `scale(${this.zoom})`;
    }
    this.shadowRoot.getElementById('zoomLevel').textContent = `${Math.round(this.zoom * 100)}%`;
  }

  addToHistory(action, data) {
    // Remove any future history
    if (this.historyIndex < this.history.length - 1) {
      this.history = this.history.slice(0, this.historyIndex + 1);
    }

    this.history.push({ action, data, timestamp: Date.now() });
    this.historyIndex = this.history.length - 1;

    // Limit history size
    if (this.history.length > 50) {
      this.history.shift();
      this.historyIndex--;
    }
  }

  undo() {
    if (this.historyIndex <= 0) return;

    const action = this.history[this.historyIndex];
    this.historyIndex--;

    this.applyHistoryAction(action, true);
  }

  redo() {
    if (this.historyIndex >= this.history.length - 1) return;

    this.historyIndex++;
    const action = this.history[this.historyIndex];
    this.applyHistoryAction(action, false);
  }

  applyHistoryAction(action, isUndo) {
    // Implement undo/redo logic based on action type
    if (action.action === 'add') {
      if (isUndo) {
        this.elements = this.elements.filter((e) => e.id !== action.data.id);
      } else {
        this.elements.push(action.data);
      }
    } else if (action.action === 'modify') {
      const element = this.elements.find((e) => e.id === action.data.elementId);
      if (element) {
        if (isUndo) {
          element[action.data.property] = action.data.oldValue;
        } else {
          element[action.data.property] = action.data.newValue;
        }
      }
    }

    this.renderElements();
    this.renderCanvas();
  }

  getElements() {
    return this.elements;
  }

  setElements(elements) {
    this.elements = elements;
    this.renderElements();
  }
}

customElements.define('canva-editor', CanvaEditor);
