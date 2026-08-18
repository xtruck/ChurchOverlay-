/**
 * ============================================================================
 *  verse-display-card.js — Modern Verse Display Component
 * ----------------------------------------------------------------------------
 *  Beautiful, animated verse display with AR-style presentation
 *  Features: Smooth animations, context-aware styling, AI enhancements
 * ============================================================================
 */

class VerseDisplayCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.currentVerse = null;
    this.animationStyle = 'fade';
    this.displayDuration = 5000;
    this.theme = 'default';
  }

  static get observedAttributes() {
    return ['verse', 'animation', 'duration', 'theme'];
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue !== newValue) {
      this.updateProperty(name, newValue);
    }
  }

  updateProperty(name, value) {
    switch (name) {
      case 'verse':
        this.currentVerse = JSON.parse(value);
        this.render();
        break;
      case 'animation':
        this.animationStyle = value;
        this.updateAnimation();
        break;
      case 'duration':
        this.displayDuration = parseInt(value);
        break;
      case 'theme':
        this.theme = value;
        this.updateTheme();
        break;
    }
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
          height: 100%;
          font-family: 'Cormorant Garamond', serif;
        }

        .verse-container {
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          justify-content: center;
      align-items: center;
          padding: 40px;
          position: relative;
          overflow: hidden;
        }

        .verse-content {
          text-align: center;
          max-width: 1200px;
          position: relative;
          z-index: 2;
        }

        .verse-reference {
          font-size: 2.5rem;
          font-weight: 600;
          color: var(--primary, #7c8cf5);
          margin-bottom: 24px;
          letter-spacing: 2px;
          text-transform: uppercase;
          opacity: 0;
          transform: translateY(-20px);
        }

        .verse-text {
          font-size: 3rem;
          line-height: 1.4;
          color: var(--text-main, #f6f3ec);
          font-style: italic;
          opacity: 0;
          transform: translateY(20px);
          text-shadow: 0 2px 20px rgba(0, 0, 0, 0.3);
        }

        .verse-text .verse-number {
          font-size: 0.6em;
      vertical-align: super;
          color: var(--primary, #7c8cf5);
          font-weight: 600;
          margin: 0 4px;
        }

        /* Animation Styles */
        .fade-in .verse-reference {
          animation: fadeInDown 0.8s cubic-bezier(0.19, 1, 0.22, 1) forwards;
        }

        .fade-in .verse-text {
          animation: fadeInUp 0.8s cubic-bezier(0.19, 1, 0.22, 1) 0.2s forwards;
        }

        .slide-up .verse-reference {
          animation: slideUp 0.6s cubic-bezier(0.19, 1, 0.22, 1) forwards;
        }

        .slide-up .verse-text {
          animation: slideUp 0.6s cubic-bezier(0.19, 1, 0.22, 1) 0.15s forwards;
        }

        .scale-in .verse-reference {
          animation: scaleIn 0.7s cubic-bezier(0.19, 1, 0.22, 1) forwards;
        }

        .scale-in .verse-text {
          animation: scaleIn 0.7s cubic-bezier(0.19, 1, 0.22, 1) 0.2s forwards;
        }

        /* Background Effects */
        .background-glow {
          position: absolute;
          width: 600px;
          height: 600px;
          background: radial-gradient(circle, var(--primary-glow, rgba(124, 140, 245, 0.15)) 0%, transparent 70%);
          border-radius: 50%;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          opacity: 0;
          animation: glowPulse 4s ease-in-out infinite;
        }

        .particle-container {
          position: absolute;
          width: 100%;
          height: 100%;
          overflow: hidden;
          pointer-events: none;
        }

        .particle {
          position: absolute;
          width: 4px;
          height: 4px;
          background: var(--primary, #7c8cf5);
          border-radius: 50%;
          opacity: 0;
          animation: float 8s ease-in-out infinite;
        }

        /* Progress Bar */
        .progress-bar {
          position: absolute;
          bottom: 0;
          left: 0;
          height: 4px;
          background: linear-gradient(90deg, var(--primary, #7c8cf5), var(--primary-hover, #6b7ce4));
          width: 0%;
          transition: width 0.1s linear;
        }

        /* Theme Variations */
        [theme="elegant"] .verse-text {
          font-family: 'Cormorant Garamond', serif;
          font-size: 3.5rem;
        }

        [theme="modern"] .verse-text {
          font-family: 'Plus Jakarta Sans', sans-serif;
          font-size: 2.5rem;
          font-style: normal;
          font-weight: 300;
        }

        [theme="bold"] .verse-text {
          font-family: 'Plus Jakarta Sans', sans-serif;
          font-size: 2.8rem;
          font-weight: 700;
          font-style: normal;
        }

        /* Animations */
        @keyframes fadeInDown {
          from {
            opacity: 0;
            transform: translateY(-20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes fadeInUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(40px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes scaleIn {
          from {
            opacity: 0;
            transform: scale(0.9);
          }
          to {
            opacity: 1;
            transform: scale(1);
          }
        }

        @keyframes glowPulse {
          0%, 100% {
            opacity: 0.3;
            transform: translate(-50%, -50%) scale(1);
          }
          50% {
            opacity: 0.6;
            transform: translate(-50%, -50%) scale(1.1);
          }
        }

        @keyframes float {
          0% {
            opacity: 0;
            transform: translateY(100vh) rotate(0deg);
          }
          10% {
            opacity: 0.6;
          }
          90% {
            opacity: 0.6;
          }
          100% {
            opacity: 0;
            transform: translateY(-100vh) rotate(720deg);
          }
        }

        /* Responsive */
        @media (max-width: 768px) {
          .verse-reference {
            font-size: 1.8rem;
          }
          .verse-text {
            font-size: 2rem;
          }
        }
      </style>

      <div class="verse-container" id="container">
        <div class="background-glow"></div>
        <div class="particle-container" id="particles"></div>
        <div class="verse-content">
          <div class="verse-reference" id="reference"></div>
          <div class="verse-text" id="text"></div>
        </div>
        <div class="progress-bar" id="progress"></div>
      </div>
    `;

    this.updateVerseContent();
    this.createParticles();
  }

  setupEventListeners() {
    // Listen for theme changes
    window.addEventListener('theme-change', (e) => {
      this.theme = e.detail.theme;
      this.updateTheme();
    });
  }

  updateVerseContent() {
    if (!this.currentVerse) return;

    const referenceEl = this.shadowRoot.getElementById('reference');
    const textEl = this.shadowRoot.getElementById('text');

    referenceEl.textContent = this.currentVerse.reference;
    textEl.innerHTML = this.formatVerseText(this.currentVerse.text);

    this.updateAnimation();
    this.startProgress();
  }

  formatVerseText(text) {
    // Add verse numbers if present
    return text.replace(/(\d+)/g, '<span class="verse-number">$1</span>');
  }

  updateAnimation() {
    const container = this.shadowRoot.getElementById('container');
    container.className = `verse-container ${this.animationStyle}`;
  }

  updateTheme() {
    this.setAttribute('theme', this.theme);
  }

  createParticles() {
    const container = this.shadowRoot.getElementById('particles');
    container.innerHTML = '';

    for (let i = 0; i < 20; i++) {
      const particle = document.createElement('div');
      particle.className = 'particle';
      particle.style.left = `${Math.random() * 100}%`;
      particle.style.animationDelay = `${Math.random() * 8}s`;
      particle.style.animationDuration = `${6 + Math.random() * 4}s`;
      container.appendChild(particle);
    }
  }

  startProgress() {
    const progress = this.shadowRoot.getElementById('progress');
    progress.style.width = '0%';
    progress.style.transition = `width ${this.displayDuration}ms linear`;

    // Trigger reflow
    progress.offsetHeight;

    progress.style.width = '100%';

    // Hide after duration
    setTimeout(() => {
      this.hide();
    }, this.displayDuration);
  }

  show() {
    this.style.opacity = '1';
    this.style.pointerEvents = 'auto';
  }

  hide() {
    this.style.opacity = '0';
    this.style.pointerEvents = 'none';
  }

  setVerse(verse) {
    this.currentVerse = verse;
    this.updateVerseContent();
  }

  setAnimation(style) {
    this.animationStyle = style;
    this.updateAnimation();
  }

  setTheme(theme) {
    this.theme = theme;
    this.updateTheme();
  }

  setDuration(duration) {
    this.displayDuration = duration;
  }
}

customElements.define('verse-display-card', VerseDisplayCard);
