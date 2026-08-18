/**
 * ============================================================================
 *  propresenter-ui.js — ProPresenter-Inspired UI Components
 * ----------------------------------------------------------------------------
 *  UI components for ProPresenter 7 features:
 *  - Announcement layer control panel
 *  - Stage display configuration
 *  - Multi-Bible translation selector
 *  - Audio routing mixer
 *  - Calendar/scheduling interface
 *  - Key/Fill channel controls
 * ============================================================================
 */

class AnnouncementLayerControl extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          font-family: 'Plus Jakarta Sans', sans-serif;
        }

        .announcement-control {
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: var(--radius-md, 14px);
          padding: 16px;
        }

        .control-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }

        .control-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-main, #f6f3ec);
        }

        .toggle-switch {
          position: relative;
          width: 44px;
          height: 24px;
        }

        .toggle-switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }

        .toggle-slider {
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: var(--bg-input, rgba(8, 11, 22, 0.55));
          transition: 0.3s;
          border-radius: 24px;
        }

        .toggle-slider:before {
          position: absolute;
          content: "";
          height: 18px;
          width: 18px;
          left: 3px;
          bottom: 3px;
          background-color: var(--text-dim, #6c7292);
          transition: 0.3s;
          border-radius: 50%;
        }

        input:checked + .toggle-slider {
          background-color: var(--primary, #7c8cf5);
        }

        input:checked + .toggle-slider:before {
          transform: translateX(20px);
          background-color: white;
        }

        .content-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .content-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border-radius: 8px;
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
        }

        .content-preview {
          width: 60px;
          height: 40px;
          background: var(--bg-surface, rgba(22, 27, 46, 0.55));
          border-radius: 6px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 10px;
          color: var(--text-dim, #6c7292);
        }

        .content-info {
          flex: 1;
        }

        .content-name {
          font-size: 13px;
          font-weight: 500;
          color: var(--text-main, #f6f3ec);
        }

        .content-duration {
          font-size: 11px;
          color: var(--text-dim, #6c7292);
        }

        .add-button {
          width: 100%;
          padding: 12px;
          background: var(--primary, #7c8cf5);
          border: none;
          border-radius: 8px;
          color: white;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
          margin-top: 12px;
        }

        .add-button:hover {
          background: var(--primary-hover, color-mix(in srgb, var(--primary) 85%, black));
        }
      </style>

      <div class="announcement-control">
        <div class="control-header">
          <span class="control-title">Announcement Layer</span>
          <label class="toggle-switch">
            <input type="checkbox" id="announcementToggle">
            <span class="toggle-slider"></span>
          </label>
        </div>

        <div class="content-list" id="contentList">
          <div class="content-item">
            <div class="content-preview">IMG</div>
            <div class="content-info">
              <div class="content-name">Welcome Slide</div>
              <div class="content-duration">5s</div>
            </div>
          </div>
          <div class="content-item">
            <div class="content-preview">TXT</div>
            <div class="content-info">
              <div class="content-name">Upcoming Events</div>
              <div class="content-duration">8s</div>
            </div>
          </div>
        </div>

        <button class="add-button" id="addAnnouncement">+ Add Announcement</button>
      </div>
    `;
  }

  setupEventListeners() {
    this.shadowRoot.getElementById('announcementToggle').addEventListener('change', (e) => {
      window.dispatchEvent(
        new CustomEvent('announcement-layer-toggled', {
          detail: { enabled: e.target.checked },
        })
      );
    });

    this.shadowRoot.getElementById('addAnnouncement').addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('add-announcement-requested'));
    });
  }
}

class StageDisplayConfig extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          font-family: 'Plus Jakarta Sans', sans-serif;
        }

        .stage-config {
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: var(--radius-md, 14px);
          padding: 16px;
        }

        .config-header {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-main, #f6f3ec);
          margin-bottom: 16px;
        }

        .layout-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 12px;
          margin-bottom: 16px;
        }

        .layout-option {
          padding: 16px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border: 2px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .layout-option:hover {
          border-color: var(--border-light, rgba(255, 255, 255, 0.22));
        }

        .layout-option.selected {
          border-color: var(--primary, #7c8cf5);
          background: var(--primary-glow, color-mix(in srgb, var(--primary) 10%, transparent));
        }

        .layout-name {
          font-size: 13px;
          font-weight: 500;
          color: var(--text-main, #f6f3ec);
          margin-bottom: 4px;
        }

        .layout-description {
          font-size: 11px;
          color: var(--text-dim, #6c7292);
        }

        .resolution-select {
          width: 100%;
          padding: 10px 12px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: 8px;
          color: var(--text-main, #f6f3ec);
          font-size: 13px;
          cursor: pointer;
        }
      </style>

      <div class="stage-config">
        <div class="config-header">Stage Display Layout</div>

        <div class="layout-grid">
          <div class="layout-option selected">
            <div class="layout-name">Standard</div>
            <div class="layout-description">Current slide + notes</div>
          </div>
          <div class="layout-option">
            <div class="layout-name">Split</div>
            <div class="layout-description">Current + next slide</div>
          </div>
          <div class="layout-option">
            <div class="layout-name">Full</div>
            <div class="layout-description">Full screen content</div>
          </div>
          <div class="layout-option">
            <div class="layout-name">Custom</div>
            <div class="layout-description">Custom configuration</div>
          </div>
        </div>

        <select class="resolution-select">
          <option value="1920x1080">1920x1080 (1080p)</option>
          <option value="1280x720">1280x720 (720p)</option>
          <option value="3840x2160">3840x2160 (4K)</option>
        </select>
      </div>
    `;
  }
}

class MultiBibleSelector extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          font-family: 'Plus Jakarta Sans', sans-serif;
        }

        .bible-selector {
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: var(--radius-md, 14px);
          padding: 16px;
        }

        .selector-header {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-main, #f6f3ec);
          margin-bottom: 16px;
        }

        .language-row {
          display: flex;
          gap: 12px;
          margin-bottom: 12px;
        }

        .language-select {
          flex: 1;
          padding: 10px 12px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: 8px;
          color: var(--text-main, #f6f3ec);
          font-size: 13px;
          cursor: pointer;
        }

        .display-mode-select {
          width: 100%;
          padding: 10px 12px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: 8px;
          color: var(--text-main, #f6f3ec);
          font-size: 13px;
          cursor: pointer;
        }

        .preview-area {
          margin-top: 16px;
          padding: 16px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border-radius: 8px;
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
        }

        .preview-bible {
          display: flex;
          gap: 16px;
        }

        .preview-text {
          flex: 1;
          font-size: 12px;
          color: var(--text-muted, #a8adc9);
          line-height: 1.6;
        }

        .preview-label {
          font-size: 10px;
          color: var(--text-dim, #6c7292);
          margin-bottom: 4px;
          text-transform: uppercase;
        }
      </style>

      <div class="bible-selector">
        <div class="selector-header">Multi-Bible Translation</div>

        <div class="language-row">
          <select class="language-select">
            <option value="fr">French (Louis Segond)</option>
            <option value="en">English (NIV)</option>
            <option value="es">Spanish (RVR1960)</option>
            <option value="de">German (Luther)</option>
          </select>
          <select class="language-select">
            <option value="en">English (NIV)</option>
            <option value="fr">French (Louis Segond)</option>
            <option value="es">Spanish (RVR1960)</option>
            <option value="de">German (Luther)</option>
          </select>
        </div>

        <select class="display-mode-select">
          <option value="side-by-side">Side by Side</option>
          <option value="stacked">Stacked</option>
          <option value="toggle">Toggle (Primary shown)</option>
        </select>

        <div class="preview-area">
          <div class="preview-bible">
            <div>
              <div class="preview-label">French</div>
              <div class="preview-text">Car Dieu a tant aimé le monde qu'il a donné son Fils unique...</div>
            </div>
            <div>
              <div class="preview-label">English</div>
              <div class="preview-text">For God so loved the world that he gave his one and only Son...</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
}

class AudioMixer extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.render();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          font-family: 'Plus Jakarta Sans', sans-serif;
        }

        .audio-mixer {
          background: var(--bg-card, rgba(255, 255, 255, 0.055));
          border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.1));
          border-radius: var(--radius-md, 14px);
          padding: 16px;
        }

        .mixer-header {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-main, #f6f3ec);
          margin-bottom: 16px;
        }

        .channel-row {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
        }

        .channel-name {
          width: 80px;
          font-size: 12px;
          color: var(--text-muted, #a8adc9);
        }

        .channel-slider {
          flex: 1;
          -webkit-appearance: none;
          height: 4px;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border-radius: 2px;
          outline: none;
        }

        .channel-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px;
          height: 16px;
          background: var(--primary, #7c8cf5);
          border-radius: 50%;
          cursor: pointer;
        }

        .channel-value {
          width: 40px;
          font-size: 12px;
          color: var(--text-muted, #a8adc9);
          text-align: right;
        }

        .channel-toggle {
          width: 36px;
          height: 20px;
        }

        .mute-button {
          width: 32px;
          height: 32px;
          border: none;
          background: var(--bg-input, rgba(8, 11, 22, 0.55));
          border-radius: 6px;
          color: var(--text-muted, #a8adc9);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .mute-button:hover {
          background: var(--bg-card-hover, rgba(255, 255, 255, 0.09));
        }

        .mute-button.muted {
          background: #ef4444;
          color: white;
        }
      </style>

      <div class="audio-mixer">
        <div class="mixer-header">Audio Channel Routing</div>

        <div class="channel-row">
          <span class="channel-name">Main</span>
          <input type="range" class="channel-slider" min="0" max="100" value="100">
          <span class="channel-value">100%</span>
          <button class="mute-button">M</button>
        </div>

        <div class="channel-row">
          <span class="channel-name">Backup</span>
          <input type="range" class="channel-slider" min="0" max="100" value="80">
          <span class="channel-value">80%</span>
          <button class="mute-button">M</button>
        </div>

        <div class="channel-row">
          <span class="channel-name">Music</span>
          <input type="range" class="channel-slider" min="0" max="100" value="50">
          <span class="channel-value">50%</span>
          <button class="mute-button">M</button>
        </div>
      </div>
    `;
  }
}

customElements.define('announcement-layer-control', AnnouncementLayerControl);
customElements.define('stage-display-config', StageDisplayConfig);
customElements.define('multi-bible-selector', MultiBibleSelector);
customElements.define('audio-mixer', AudioMixer);
