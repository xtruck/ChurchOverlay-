/**
 * ============================================================================
 *  contextual-toolbar.js — Canva-Inspired Contextual Editing Toolbar
 * ----------------------------------------------------------------------------
 *  Floating toolbar that adapts to current selection and task
 *  Features: AI suggestions, quick actions, adaptive positioning
 * ============================================================================
 */

class ContextualToolbar extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.currentContext = null;
    this.position = { x: 0, y: 0 };
    this.isVisible = false;
    this.aiSuggestions = [];
  }

  connectedCallback() {
    this.render();
    this.setupEventListeners();
    this.setupPositionObserver();
  }

  render() {
    this.shadowRoot.innerHTML = `
      <style>
        :host {
          position: fixed;
          z-index: 10000;
          display: none;
          font-family: 'Plus Jakarta Sans', sans-serif;
        }

        :host([visible]) {
          display: block;
        }

        .toolbar {
          background: rgba(22, 27, 46, 0.95);
          backdrop-filter: blur(20px);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 12px;
          padding: 8px;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
          display: flex;
          align-items: center;
          gap: 4px;
          min-width: 200px;
          animation: slideIn 0.2s cubic-bezier(0.19, 1, 0.22, 1);
        }

        @keyframes slideIn {
          from {
            opacity: 0;
            transform: translateY(10px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }

        .toolbar-section {
          display: flex;
          align-items: center;
          gap: 4px;
          padding: 0 8px;
          border-right: 1px solid rgba(255, 255, 255, 0.1);
        }

        .toolbar-section:last-child {
          border-right: none;
        }

        .toolbar-button {
          width: 36px;
          height: 36px;
          border: none;
          background: transparent;
          border-radius: 8px;
          color: rgba(255, 255, 255, 0.7);
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.15s ease;
          position: relative;
        }

        .toolbar-button:hover {
          background: rgba(255, 255, 255, 0.1);
          color: white;
        }

        .toolbar-button:active {
          transform: scale(0.95);
        }

        .toolbar-button svg {
          width: 18px;
          height: 18px;
        }

        .toolbar-button.ai-enhanced::after {
          content: '';
          position: absolute;
          top: 2px;
          right: 2px;
          width: 6px;
          height: 6px;
          background: #7c8cf5;
          border-radius: 50%;
          box-shadow: 0 0 8px #7c8cf5;
        }

        .toolbar-divider {
          width: 1px;
          height: 24px;
          background: rgba(255, 255, 255, 0.1);
          margin: 0 4px;
        }

        .ai-suggestion {
          background: linear-gradient(135deg, rgba(124, 140, 245, 0.2), rgba(124, 140, 245, 0.1));
          border: 1px solid rgba(124, 140, 245, 0.3);
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 13px;
          color: white;
          cursor: pointer;
          transition: all 0.15s ease;
          max-width: 200px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .ai-suggestion:hover {
          background: linear-gradient(135deg, rgba(124, 140, 245, 0.3), rgba(124, 140, 245, 0.2));
          transform: translateY(-1px);
        }

        .ai-badge {
          background: #7c8cf5;
          color: white;
          font-size: 10px;
          padding: 2px 6px;
          border-radius: 4px;
          margin-left: 6px;
          font-weight: 600;
        }

        .tooltip {
          position: absolute;
          bottom: calc(100% + 8px);
          left: 50%;
          transform: translateX(-50%);
          background: rgba(0, 0, 0, 0.9);
          color: white;
          padding: 6px 10px;
          border-radius: 6px;
          font-size: 12px;
          white-space: nowrap;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.15s ease;
        }

        .toolbar-button:hover .tooltip {
          opacity: 1;
        }
      </style>

      <div class="toolbar" id="toolbar">
        <div class="toolbar-section" id="primary-actions">
          <!-- Primary context actions -->
        </div>
        <div class="toolbar-section" id="ai-actions">
          <!-- AI-powered actions -->
        </div>
        <div class="toolbar-section" id="style-actions">
          <!-- Style and formatting -->
        </div>
      </div>
    `;
  }

  setupEventListeners() {
    // Listen for selection changes
    document.addEventListener('selectionchange', () => this.handleSelectionChange());
    
    // Listen for context changes from the app
    window.addEventListener('context-change', (e) => this.handleContextChange(e.detail));
    
    // Listen for AI suggestions
    window.addEventListener('ai-suggestions', (e) => this.handleAISuggestions(e.detail));
  }

  setupPositionObserver() {
    // Observe viewport changes to keep toolbar in view
    const resizeObserver = new ResizeObserver(() => this.ensureInViewport());
    resizeObserver.observe(document.body);
  }

  handleSelectionChange() {
    const selection = window.getSelection();
    if (selection.rangeCount > 0 && selection.toString().trim()) {
      this.showForSelection(selection);
    } else {
      this.hide();
    }
  }

  handleContextChange(context) {
    this.currentContext = context;
    this.updateToolbar();
  }

  handleAISuggestions(suggestions) {
    this.aiSuggestions = suggestions;
    this.updateToolbar();
  }

  showForSelection(selection) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    
    this.position = {
      x: rect.left + rect.width / 2,
      y: rect.top - 50
    };
    
    this.show();
  }

  show() {
    this.style.left = `${this.position.x}px`;
    this.style.top = `${this.position.y}px`;
    this.style.transform = 'translate(-50%, 0)';
    this.setAttribute('visible', '');
    this.isVisible = true;
    
    this.updateToolbar();
  }

  hide() {
    this.removeAttribute('visible');
    this.isVisible = false;
  }

  updateToolbar() {
    const primaryActions = this.shadowRoot.getElementById('primary-actions');
    const aiActions = this.shadowRoot.getElementById('ai-actions');
    const styleActions = this.shadowRoot.getElementById('style-actions');
    
    // Clear existing content
    primaryActions.innerHTML = '';
    aiActions.innerHTML = '';
    styleActions.innerHTML = '';
    
    // Add context-specific actions
    if (this.currentContext) {
      this.addContextActions(primaryActions, this.currentContext);
    }
    
    // Add AI suggestions
    if (this.aiSuggestions.length > 0) {
      this.addAISuggestions(aiActions);
    }
    
    // Add common style actions
    this.addStyleActions(styleActions);
  }

  addContextActions(container, context) {
    const actions = this.getActionsForContext(context);
    
    actions.forEach(action => {
      const button = this.createActionButton(action);
      container.appendChild(button);
    });
  }

  addAISuggestions(container) {
    this.aiSuggestions.slice(0, 2).forEach(suggestion => {
      const suggestionEl = document.createElement('div');
      suggestionEl.className = 'ai-suggestion';
      suggestionEl.innerHTML = `
        ${suggestion.text}
        <span class="ai-badge">AI</span>
      `;
      suggestionEl.addEventListener('click', () => this.applySuggestion(suggestion));
      container.appendChild(suggestionEl);
    });
  }

  addStyleActions(container) {
    const styleActions = [
      { icon: 'bold', action: 'bold', tooltip: 'Bold' },
      { icon: 'italic', action: 'italic', tooltip: 'Italic' },
      { icon: 'color', action: 'color', tooltip: 'Color' },
      { icon: 'size', action: 'size', tooltip: 'Size' }
    ];
    
    styleActions.forEach(action => {
      const button = this.createActionButton(action);
      container.appendChild(button);
    });
  }

  createActionButton(action) {
    const button = document.createElement('button');
    button.className = `toolbar-button ${action.aiEnhanced ? 'ai-enhanced' : ''}`;
    button.innerHTML = `
      ${this.getIconForAction(action.icon)}
      <span class="tooltip">${action.tooltip}</span>
    `;
    button.addEventListener('click', () => this.executeAction(action));
    return button;
  }

  getIconForAction(iconName) {
    const icons = {
      bold: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>',
      italic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>',
      color: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/></svg>',
      size: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>',
      magic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L15 8l6 1-4 4 1 6-6-3-6 3 1-6-4-4 6-1z"/></svg>',
      copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      verse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M6 8h12"/></svg>'
    };
    
    return icons[iconName] || icons.magic;
  }

  getActionsForContext(context) {
    switch (context.type) {
      case 'verse':
        return [
          { icon: 'verse', action: 'show-verse', tooltip: 'Show Verse', aiEnhanced: true },
          { icon: 'copy', action: 'copy-verse', tooltip: 'Copy Verse' },
          { icon: 'magic', action: 'ai-enhance', tooltip: 'AI Enhance', aiEnhanced: true }
        ];
      case 'text':
        return [
          { icon: 'bold', action: 'bold', tooltip: 'Bold' },
          { icon: 'italic', action: 'italic', tooltip: 'Italic' },
          { icon: 'magic', action: 'ai-improve', tooltip: 'AI Improve', aiEnhanced: true }
        ];
      case 'media':
        return [
          { icon: 'magic', action: 'ai-style', tooltip: 'AI Style', aiEnhanced: true },
          { icon: 'color', action: 'adjust', tooltip: 'Adjust' }
        ];
      default:
        return [
          { icon: 'magic', action: 'ai-suggest', tooltip: 'AI Suggest', aiEnhanced: true }
        ];
    }
  }

  executeAction(action) {
    console.log('Executing action:', action);
    
    // Emit action event for the app to handle
    window.dispatchEvent(new CustomEvent('toolbar-action', {
      detail: action
    }));
  }

  applySuggestion(suggestion) {
    console.log('Applying AI suggestion:', suggestion);
    
    // Emit suggestion applied event
    window.dispatchEvent(new CustomEvent('ai-suggestion-applied', {
      detail: suggestion
    }));
  }

  ensureInViewport() {
    if (!this.isVisible) return;
    
    const toolbar = this.shadowRoot.getElementById('toolbar');
    const rect = toolbar.getBoundingClientRect();
    
    // Adjust position if toolbar is outside viewport
    if (rect.left < 0) {
      this.style.left = '10px';
      this.style.transform = 'none';
    }
    if (rect.right > window.innerWidth) {
      this.style.left = `${window.innerWidth - 10}px`;
      this.style.transform = 'translate(-100%, 0)';
    }
    if (rect.top < 0) {
      this.style.top = '10px';
    }
    if (rect.bottom > window.innerHeight) {
      this.style.top = `${window.innerHeight - rect.height - 10}px`;
    }
  }
}

customElements.define('contextual-toolbar', ContextualToolbar);