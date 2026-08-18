/**
 * ============================================================================
 *  professional-scene-gallery.js — OBS-Style Professional Scene Gallery
 * ----------------------------------------------------------------------------
 *  Professional multi-scene interface with:
 *  - Scene collections management
 *  - Drag-and-drop scene ordering
 *  - Scene preview with live updates
 *  - Transition controls
 *  - Layer visibility controls
 *  - Quick actions and shortcuts
 * ============================================================================
 */

class ProfessionalSceneGallery extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.sceneManager = null;
    this.activeCollection = null;
    this.scenes = [];
    this.draggedScene = null;
    this.selectedScenes = new Set();
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
    this.loadInitialData();
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

        .gallery-container {
          display: flex;
          flex-direction: column;
          height: 100%;
          padding: 16px;
          gap: 16px;
        }

        .gallery-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 16px;
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border-radius: var(--radius-md, 14px);
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
        }

        .gallery-title {
          font-size: 18px;
          font-weight: 600;
          color: var(--text-main, #f6f3ec);
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .gallery-title svg {
          width: 20px;
          height: 20px;
          color: var(--primary, #7c8cf5);
        }

        .gallery-controls {
          display: flex;
          gap: 8px;
        }

        .control-button {
          padding: 8px 16px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: var(--radius-sm, 8px);
          color: var(--text-muted, #a8adc9);
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          transition: all 0.15s ease;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .control-button:hover {
          background: var(--bg-card-hover, rgba(255, 255, 255, 0.09));
          color: var(--text-main, #f6f3ec);
          border-color: var(--border-light, rgba(255, 255, 255, 0.22));
        }

        .control-button.primary {
          background: var(--primary, #7c8cf5);
          color: white;
          border-color: var(--primary, #7c8cf5);
        }

        .control-button.primary:hover {
          background: var(--primary-hover, color-mix(in srgb, var(--primary) 85%, black));
        }

        .collections-bar {
          display: flex;
          gap: 8px;
          padding: 8px;
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border-radius: var(--radius-sm, 8px);
          overflow-x: auto;
        }

        .collection-tab {
          padding: 8px 16px;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-sm, 8px);
          color: var(--text-muted, #a8adc9);
          cursor: pointer;
          font-size: 13px;
          font-weight: 500;
          white-space: nowrap;
          transition: all 0.15s ease;
        }

        .collection-tab:hover {
          background: var(--bg-card-hover, rgba(255, 255, 255, 0.09));
          color: var(--text-main, #f6f3ec);
        }

        .collection-tab.active {
          background: var(--primary, #7c8cf5);
          color: white;
          border-color: var(--primary, #7c8cf5);
        }

        .scenes-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
          gap: 12px;
          flex: 1;
          overflow-y: auto;
          padding: 8px;
        }

        .scene-card {
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: var(--radius-md, 14px);
          overflow: hidden;
          cursor: pointer;
          transition: all 0.2s ease;
          position: relative;
        }

        .scene-card:hover {
          border-color: var(--border-light, rgba(255, 255, 255, 0.22));
          transform: translateY(-2px);
          box-shadow: var(--shadow-md, 0 16px 40px rgba(0, 0, 0, 0.5));
        }

        .scene-card.active {
          border-color: var(--primary, #7c8cf5);
          box-shadow: 0 0 0 2px var(--primary-glow, color-mix(in srgb, var(--primary) 38%, transparent));
        }

        .scene-card.selected {
          border-color: var(--primary, #7c8cf5);
          background: var(--primary-glow, color-mix(in srgb, var(--primary) 10%, transparent));
        }

        .scene-preview {
          aspect-ratio: 16/9;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
          position: relative;
        }

        .scene-preview canvas,
        .scene-preview img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .scene-info {
          padding: 12px;
        }

        .scene-name {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-main, #f6f3ec);
          margin-bottom: 4px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .scene-meta {
          font-size: 11px;
          color: var(--text-dim, #6c7292);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .scene-actions {
          position: absolute;
          top: 8px;
          right: 8px;
          display: flex;
          gap: 4px;
          opacity: 0;
          transition: opacity 0.15s ease;
        }

        .scene-card:hover .scene-actions {
          opacity: 1;
        }

        .scene-action {
          width: 28px;
          height: 28px;
          background: rgba(0, 0, 0, 0.7);
          border: none;
          border-radius: 6px;
          color: white;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s ease;
        }

        .scene-action:hover {
          background: var(--primary, #7c8cf5);
        }

        .layer-controls {
          display: flex;
          gap: 8px;
          padding: 12px 16px;
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border-radius: var(--radius-sm, 8px);
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
        }

        .layer-toggle {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: var(--text-muted, #a8adc9);
          cursor: pointer;
          padding: 4px 8px;
          border-radius: 6px;
          transition: all 0.15s ease;
        }

        .layer-toggle:hover {
          background: var(--bg-card-hover, rgba(255, 255, 255, 0.09));
        }

        .layer-toggle.active {
          color: var(--primary, #7c8cf5);
        }

        .layer-toggle input {
          display: none;
        }

        .layer-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--text-dim, #6c7292);
          transition: all 0.15s ease;
        }

        .layer-toggle.active .layer-indicator {
          background: var(--primary, #7c8cf5);
          box-shadow: 0 0 8px var(--primary-glow, color-mix(in srgb, var(--primary) 38%, transparent));
        }

        .transition-controls {
          display: flex;
          gap: 12px;
          padding: 12px 16px;
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border-radius: var(--radius-sm, 8px);
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          align-items: center;
        }

        .transition-label {
          font-size: 12px;
          color: var(--text-muted, #a8adc9);
          font-weight: 500;
        }

        .transition-select {
          padding: 6px 12px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: 6px;
          color: var(--text-main, #f6f3ec);
          font-size: 12px;
          cursor: pointer;
        }

        .duration-input {
          width: 60px;
          padding: 6px 8px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: 6px;
          color: var(--text-main, #f6f3ec);
          font-size: 12px;
          text-align: center;
        }

        .empty-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100%;
          color: var(--text-dim, #6c7292);
          text-align: center;
          padding: 40px;
        }

        .empty-state svg {
          width: 48px;
          height: 48px;
          margin-bottom: 16px;
          opacity: 0.5;
        }

        .empty-state-text {
          font-size: 14px;
          margin-bottom: 8px;
        }

        .empty-state-subtext {
          font-size: 12px;
          opacity: 0.7;
        }
      </style>

      <div class="gallery-container">
        <div class="gallery-header">
          <div class="gallery-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
              <line x1="8" y1="21" x2="16" y2="21"/>
              <line x1="12" y1="17" x2="12" y2="21"/>
            </svg>
            Scene Gallery
          </div>
          <div class="gallery-controls">
            <button class="control-button" id="undoBtn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>
              </svg>
              Undo
            </button>
            <button class="control-button" id="redoBtn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>
              </svg>
              Redo
            </button>
            <button class="control-button primary" id="addSceneBtn">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Add Scene
            </button>
          </div>
        </div>

        <div class="collections-bar" id="collectionsBar">
          <!-- Collection tabs will be rendered here -->
        </div>

        <div class="layer-controls">
          <label class="layer-toggle active">
            <input type="checkbox" checked>
            <span class="layer-indicator"></span>
            Background
          </label>
          <label class="layer-toggle active">
            <input type="checkbox" checked>
            <span class="layer-indicator"></span>
            Content
          </label>
          <label class="layer-toggle active">
            <input type="checkbox" checked>
            <span class="layer-indicator"></span>
            Overlay
          </label>
          <label class="layer-toggle">
            <input type="checkbox">
            <span class="layer-indicator"></span>
            Watermark
          </label>
        </div>

        <div class="transition-controls">
          <span class="transition-label">Transition:</span>
          <select class="transition-select" id="transitionSelect">
            <option value="fade">Fade</option>
            <option value="slide">Slide</option>
            <option value="zoom">Zoom</option>
            <option value="cut">Cut</option>
          </select>
          <span class="transition-label">Duration:</span>
          <input type="number" class="duration-input" value="500" min="0" max="5000" step="100">
          <span class="transition-label">ms</span>
        </div>

        <div class="scenes-grid" id="scenesGrid">
          <!-- Scene cards will be rendered here -->
        </div>
      </div>
    `;
  }

  setupEventListeners() {
    // Collection tabs
    this.shadowRoot.getElementById('collectionsBar').addEventListener('click', (e) => {
      if (e.target.classList.contains('collection-tab')) {
        this.switchCollection(e.target.dataset.collectionId);
      }
    });

    // Control buttons
    this.shadowRoot.getElementById('addSceneBtn').addEventListener('click', () => this.addNewScene());
    this.shadowRoot.getElementById('undoBtn').addEventListener('click', () => this.undo());
    this.shadowRoot.getElementById('redoBtn').addEventListener('click', () => this.redo());

    // Layer toggles
    this.shadowRoot.querySelectorAll('.layer-toggle').forEach(toggle => {
      toggle.addEventListener('change', (e) => {
        const layerName = e.target.closest('.layer-toggle').textContent.trim();
        this.toggleLayer(layerName, e.target.checked);
      });
    });

    // Transition controls
    this.shadowRoot.getElementById('transitionSelect').addEventListener('change', (e) => {
      this.setDefaultTransition(e.target.value);
    });

    // Scene grid events
    const scenesGrid = this.shadowRoot.getElementById('scenesGrid');
    scenesGrid.addEventListener('click', (e) => this.handleSceneClick(e));
    scenesGrid.addEventListener('dblclick', (e) => this.handleSceneDoubleClick(e));
  }

  async loadInitialData() {
    // In real implementation, load from scene manager
    this.renderCollections();
    this.renderScenes();
  }

  renderCollections() {
    const collectionsBar = this.shadowRoot.getElementById('collectionsBar');
    
    // Mock collections for now
    const collections = [
      { id: 'main', name: 'Main Service', active: true },
      { id: 'conference', name: 'Conference', active: false },
      { id: 'custom', name: 'Custom', active: false }
    ];
    
    collectionsBar.innerHTML = collections.map(col => `
      <button class="collection-tab ${col.active ? 'active' : ''}" data-collection-id="${col.id}">
        ${col.name}
      </button>
    `).join('');
  }

  renderScenes() {
    const scenesGrid = this.shadowRoot.getElementById('scenesGrid');
    
    if (this.scenes.length === 0) {
      scenesGrid.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
            <line x1="8" y1="21" x2="16" y2="21"/>
            <line x1="12" y1="17" x2="12" y2="21"/>
          </svg>
          <div class="empty-state-text">No scenes yet</div>
          <div class="empty-state-subtext">Create your first scene to get started</div>
        </div>
      `;
      return;
    }
    
    scenesGrid.innerHTML = this.scenes.map(scene => `
      <div class="scene-card ${scene.active ? 'active' : ''} ${this.selectedScenes.has(scene.id) ? 'selected' : ''}" 
           data-scene-id="${scene.id}" draggable="true">
        <div class="scene-preview">
          <canvas id="preview-${scene.id}"></canvas>
          <div class="scene-actions">
            <button class="scene-action" data-action="duplicate" title="Duplicate">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
            <button class="scene-action" data-action="edit" title="Edit">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button class="scene-action" data-action="delete" title="Delete">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="scene-info">
          <div class="scene-name">${scene.name}</div>
          <div class="scene-meta">
            <span>${scene.type || 'basic'}</span>
            <span>${scene.elements?.length || 0} elements</span>
          </div>
        </div>
      </div>
    `).join('');
    
    // Render scene previews
    this.scenes.forEach(scene => {
      this.renderScenePreview(scene);
    });
  }

  renderScenePreview(scene) {
    const canvas = this.shadowRoot.getElementById(`preview-${scene.id}`);
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    canvas.width = 320;
    canvas.height = 180;
    
    // Render scene preview (simplified)
    ctx.fillStyle = '#0b0f1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw scene name
    ctx.fillStyle = '#ffffff';
    ctx.font = '14px Plus Jakarta Sans';
    ctx.textAlign = 'center';
    ctx.fillText(scene.name, canvas.width / 2, canvas.height / 2);
  }

  handleSceneClick(e) {
    const sceneCard = e.target.closest('.scene-card');
    if (!sceneCard) return;
    
    const sceneId = sceneCard.dataset.sceneId;
    const action = e.target.closest('.scene-action')?.dataset.action;
    
    if (action) {
      e.stopPropagation();
      this.handleSceneAction(sceneId, action);
    } else {
      this.selectScene(sceneId, e.shiftKey);
    }
  }

  handleSceneDoubleClick(e) {
    const sceneCard = e.target.closest('.scene-card');
    if (!sceneCard) return;
    
    const sceneId = sceneCard.dataset.sceneId;
    this.activateScene(sceneId);
  }

  handleSceneAction(sceneId, action) {
    switch (action) {
      case 'duplicate':
        this.duplicateScene(sceneId);
        break;
      case 'edit':
        this.editScene(sceneId);
        break;
      case 'delete':
        this.deleteScene(sceneId);
        break;
    }
  }

  selectScene(sceneId, addToSelection = false) {
    if (addToSelection) {
      if (this.selectedScenes.has(sceneId)) {
        this.selectedScenes.delete(sceneId);
      } else {
        this.selectedScenes.add(sceneId);
      }
    } else {
      this.selectedScenes.clear();
      this.selectedScenes.add(sceneId);
    }
    
    this.renderScenes();
  }

  activateScene(sceneId) {
    // In real implementation, call scene manager to switch scene
    console.log('Activating scene:', sceneId);
    
    // Update active state
    this.scenes = this.scenes.map(scene => ({
      ...scene,
      active: scene.id === sceneId
    }));
    
    this.renderScenes();
    
    // Emit event for app to handle
    window.dispatchEvent(new CustomEvent('scene-activated', {
      detail: { sceneId }
    }));
  }

  switchCollection(collectionId) {
    this.activeCollection = collectionId;
    
    // Update UI
    this.shadowRoot.querySelectorAll('.collection-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.collectionId === collectionId);
    });
    
    // Load scenes for collection
    this.loadScenesForCollection(collectionId);
  }

  loadScenesForCollection(collectionId) {
    // In real implementation, load from scene manager
    // Mock data for now
    this.scenes = [
      { id: '1', name: 'Black Screen', type: 'basic', active: true, elements: [] },
      { id: '2', name: 'Welcome', type: 'basic', active: false, elements: [{ type: 'text' }] },
      { id: '3', name: 'Worship', type: 'basic', active: false, elements: [{ type: 'image' }] }
    ];
    
    this.renderScenes();
  }

  addNewScene() {
    // Emit event to open scene composer
    window.dispatchEvent(new CustomEvent('open-scene-composer', {
      detail: { collectionId: this.activeCollection }
    }));
  }

  duplicateScene(sceneId) {
    window.dispatchEvent(new CustomEvent('duplicate-scene', {
      detail: { sceneId }
    }));
  }

  editScene(sceneId) {
    window.dispatchEvent(new CustomEvent('edit-scene', {
      detail: { sceneId }
    }));
  }

  deleteScene(sceneId) {
    if (confirm('Are you sure you want to delete this scene?')) {
      window.dispatchEvent(new CustomEvent('delete-scene', {
        detail: { sceneId }
      }));
    }
  }

  toggleLayer(layerName, visible) {
    window.dispatchEvent(new CustomEvent('layer-visibility-changed', {
      detail: { layerName, visible }
    }));
  }

  setDefaultTransition(transition) {
    window.dispatchEvent(new CustomEvent('default-transition-changed', {
      detail: { transition }
    }));
  }

  undo() {
    window.dispatchEvent(new CustomEvent('undo-action'));
  }

  redo() {
    window.dispatchEvent(new CustomEvent('redo-action'));
  }
}

customElements.define('professional-scene-gallery', ProfessionalSceneGallery);