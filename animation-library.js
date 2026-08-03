/**
 * ============================================================================
 * animation-library.js — Advanced Cinematic Animations for ChurchOverlay
 * ============================================================================
 * Professional-grade animation library for verse display with:
 * - Cinematic reveal effects
 * - Smooth transitions
 * - Mood-based particle systems
 * - Text reveal animations
 * - 3D perspective effects
 * - Glowing/bloom effects
 * ============================================================================
 */

'use strict';

const AnimationLibrary = {
  // Animation categories
  categories: {
    REVEAL: 'reveal',
    TRANSITION: 'transition',
    TEXT: 'text',
    PARTICLE: 'particle',
    SPECIAL: 'special',
  },

  // Animation presets
  presets: {
    // Cinematic Reveal Animations
    cinematicFadeIn: {
      name: 'Cinematic Fade',
      category: 'reveal',
      duration: 1200,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      keyframes: `
        0% { opacity: 0; transform: scale(0.95) translateY(20px); filter: blur(8px); }
        50% { opacity: 0.7; transform: scale(0.98) translateY(5px); filter: blur(2px); }
        100% { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); }
      `,
    },

    dramaticZoom: {
      name: 'Dramatic Zoom',
      category: 'reveal',
      duration: 1000,
      easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      keyframes: `
        0% { opacity: 0; transform: scale(0.5) rotateX(15deg); }
        60% { transform: scale(1.05) rotateX(-2deg); }
        100% { opacity: 1; transform: scale(1) rotateX(0deg); }
      `,
    },

    elegantSlide: {
      name: 'Elegant Slide',
      category: 'reveal',
      duration: 900,
      easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)',
      keyframes: `
        0% { opacity: 0; transform: translateX(-100px) skewX(-5deg); }
        100% { opacity: 1; transform: translateX(0) skewX(0deg); }
      `,
    },

    spiritualGlow: {
      name: 'Spiritual Glow',
      category: 'reveal',
      duration: 1500,
      easing: 'ease-out',
      keyframes: `
        0% { opacity: 0; transform: scale(0.8); filter: brightness(0.5) blur(10px); }
        50% { filter: brightness(1.5) blur(2px); box-shadow: 0 0 60px var(--overlay-glow); }
        100% { opacity: 1; transform: scale(1); filter: brightness(1) blur(0); box-shadow: 0 0 40px var(--overlay-glow); }
      `,
    },

    // Transition Animations
    smoothCrossfade: {
      name: 'Smooth Crossfade',
      category: 'transition',
      duration: 600,
      easing: 'ease-in-out',
      keyframes: `
        0% { opacity: 1; transform: scale(1); }
        50% { opacity: 0.5; transform: scale(0.98); }
        100% { opacity: 1; transform: scale(1); }
      `,
    },

    cinematicWipe: {
      name: 'Cinematic Wipe',
      category: 'transition',
      duration: 800,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      keyframes: `
        0% { clip-path: inset(0 100% 0 0); opacity: 0; }
        100% { clip-path: inset(0 0 0 0); opacity: 1; }
      `,
    },

    // Text Reveal Animations
    typewriter: {
      name: 'Typewriter',
      category: 'text',
      duration: 2000,
      easing: 'steps(20)',
      keyframes: `
        0% { width: 0; }
        100% { width: 100%; }
      `,
    },

    wordByWord: {
      name: 'Word by Word',
      category: 'text',
      duration: 1500,
      easing: 'ease-out',
      keyframes: `
        0% { opacity: 0; transform: translateY(10px); }
        100% { opacity: 1; transform: translateY(0); }
      `,
    },

    characterReveal: {
      name: 'Character Reveal',
      category: 'text',
      duration: 1800,
      easing: 'ease-out',
      keyframes: `
        0% { opacity: 0; transform: translateY(5px) rotateX(90deg); }
        100% { opacity: 1; transform: translateY(0) rotateX(0deg); }
      `,
    },

    // Special Effects
    holyLight: {
      name: 'Holy Light',
      category: 'special',
      duration: 2000,
      easing: 'ease-out',
      keyframes: `
        0% { opacity: 0; transform: translateY(-50px); filter: brightness(2) drop-shadow(0 0 30px white); }
        30% { filter: brightness(3) drop-shadow(0 0 50px white); }
        100% { opacity: 1; transform: translateY(0); filter: brightness(1) drop-shadow(0 0 20px var(--overlay-glow)); }
      `,
    },

    divinePresence: {
      name: 'Divine Presence',
      category: 'special',
      duration: 2500,
      easing: 'ease-in-out',
      keyframes: `
        0% { opacity: 0; transform: scale(0.3) rotate(180deg); filter: hue-rotate(180deg); }
        50% { filter: hue-rotate(90deg); }
        100% { opacity: 1; transform: scale(1) rotate(0deg); filter: hue-rotate(0deg); }
      `,
    },

    // Particle Effects
    risingEmbers: {
      name: 'Rising Embers',
      category: 'particle',
      duration: 4000,
      easing: 'linear',
      keyframes: `
        0% { transform: translateY(100vh) scale(0); opacity: 0; }
        10% { opacity: 1; }
        90% { opacity: 0.8; }
        100% { transform: translateY(-10vh) scale(1); opacity: 0; }
      `,
    },

    fallingGrace: {
      name: 'Falling Grace',
      category: 'particle',
      duration: 5000,
      easing: 'linear',
      keyframes: `
        0% { transform: translateY(-10vh) rotate(0deg); opacity: 0; }
        10% { opacity: 1; }
        90% { opacity: 0.7; }
        100% { transform: translateY(100vh) rotate(360deg); opacity: 0; }
      `,
    },

    divineSparkles: {
      name: 'Divine Sparkles',
      category: 'particle',
      duration: 3000,
      easing: 'ease-out',
      keyframes: `
        0% { transform: scale(0) rotate(0deg); opacity: 0; }
        50% { transform: scale(1.5) rotate(180deg); opacity: 1; }
        100% { transform: scale(0) rotate(360deg); opacity: 0; }
      `,
    },
  },

  // Mood-based animation recommendations
  moodRecommendations: {
    joy: ['cinematicFadeIn', 'divineSparkles', 'holyLight'],
    peace: ['gentleFade', 'fallingGrace', 'spiritualGlow'],
    worship: ['dramaticZoom', 'risingEmbers', 'divinePresence'],
    repentance: ['solemnFade', 'cinematicWipe', 'spiritualGlow'],
    celebration: ['elegantSlide', 'divineSparkles', 'holyLight'],
    reflection: ['smoothCrossfade', 'fallingGrace', 'wordByWord'],
    inspiration: ['cinematicFadeIn', 'risingEmbers', 'characterReveal'],
    solemnity: ['solemnFade', 'smoothCrossfade', 'typewriter'],
  },

  // Initialize animation library
  init() {
    this.injectStyles();
    console.log('[animation-library] Advanced animations loaded');
  },

  // Inject CSS keyframes into the page
  injectStyles() {
    let css = '';

    for (const [key, preset] of Object.entries(this.presets)) {
      const animationName = `anim-${key}`;
      css += `
        @keyframes ${animationName} {
          ${preset.keyframes}
        }
        .${animationName} {
          animation: ${animationName} ${preset.duration}ms ${preset.easing} forwards;
        }
      `;
    }

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  },

  // Apply animation to element
  applyAnimation(element, animationKey, options = {}) {
    const preset = this.presets[animationKey];
    if (!preset) {
      console.warn(`[animation-library] Animation "${animationKey}" not found`);
      return;
    }

    const animationName = `anim-${animationKey}`;
    element.classList.remove(animationName);

    // Trigger reflow to restart animation
    void element.offsetWidth;

    element.classList.add(animationName);

    // Apply custom duration if provided
    if (options.duration) {
      element.style.animationDuration = `${options.duration}ms`;
    }

    // Apply custom easing if provided
    if (options.easing) {
      element.style.animationTimingFunction = options.easing;
    }

    // Return promise for animation completion
    return new Promise((resolve) => {
      const duration = options.duration || preset.duration;
      setTimeout(resolve, duration);
    });
  },

  // Get recommended animation for mood
  getRecommendation(mood) {
    const recommendations = this.moodRecommendations[mood] || this.moodRecommendations.peace;
    return recommendations[Math.floor(Math.random() * recommendations.length)];
  },

  // Create particle system
  // CORRECTIF PERF (audit CPU) : cette fonction tourne pendant TOUTE la durée
  // du culte (appelée une fois par changement d'ambiance, puis les particules
  // restent animées à l'infini jusqu'au prochain changement). Avant :
  // 30 éléments DOM, chacun avec une animation "infinite" ET un box-shadow
  // à deux couches -> chaque frame, le compositeur doit repeindre 30 ombres
  // portées floutées en continu. C'était la source principale de la
  // consommation CPU/GPU signalée. Deux changements :
  //  1) particleCount 30 -> 12 (le rendu visuel reste "ambiant", pas dense)
  //  2) box-shadow supprimé du style inline (déjà présent sur .advanced-particle
  //     si besoin visuel, mais on le laisse volontairement absent ici : un
  //     halo lumineux sur un point de 2-6px n'est perceptible qu'à courte
  //     distance de l'écran, alors que son coût de rendu est élevé partout).
  createParticleSystem(container, mood = 'peace') {
    const particleType = this.getRecommendation(mood);
    const preset = this.presets[particleType];

    // Remove existing particles
    const existingParticles = container.querySelectorAll('.advanced-particle');
    existingParticles.forEach((p) => p.remove());

    // Create new particles (réduit de 30 à 12 pour la charge CPU/GPU)
    const particleCount = 12;
    const colors = {
      joy: '#FFD700',
      peace: '#00ACC1',
      worship: '#FF6B6B',
      repentance: '#9C27B0',
      celebration: '#FFA726',
      reflection: '#78909C',
      inspiration: '#42A5F5',
      solemnity: '#5D4037',
    };
    const color = colors[mood] || colors.peace;

    // On construit tout dans un fragment hors DOM, puis on l'insère en un
    // seul appendChild : évite 12 reflows séparés (un par particule).
    const fragment = document.createDocumentFragment();

    for (let i = 0; i < particleCount; i++) {
      const particle = document.createElement('div');
      particle.className = 'advanced-particle';

      // Random positioning
      particle.style.left = Math.random() * 100 + '%';
      particle.style.top = Math.random() * 100 + '%';

      // Random size
      const size = 2 + Math.random() * 4;
      particle.style.width = `${size}px`;
      particle.style.height = `${size}px`;

      // Random delay
      particle.style.animationDelay = `${Math.random() * 3000}ms`;
      particle.style.animationDuration = `${preset.duration + Math.random() * 2000}ms`;

      // Apply animation
      particle.style.animationName = `anim-${particleType}`;
      particle.style.animationTimingFunction = preset.easing;
      particle.style.animationIterationCount = 'infinite';

      // CORRECTIF PERF : plus de box-shadow par particule (coûteux à
      // repeindre en continu sur 12 éléments animés). background + opacity
      // suffisent pour un effet ambiant discret.
      particle.style.background = color;
      particle.style.borderRadius = '50%';
      particle.style.position = 'absolute';
      particle.style.pointerEvents = 'none';
      particle.style.opacity = '0';
      // Indique au navigateur de préparer une couche composite dédiée pour
      // cet élément (transform/opacity uniquement) au lieu de repeindre le
      // parent à chaque frame — nettement moins cher sur des animations
      // longue durée comme celle-ci.
      particle.style.willChange = 'transform, opacity';

      fragment.appendChild(particle);
    }

    container.appendChild(fragment);
  },

  // Text reveal effect
  revealText(element, text, animationType = 'wordByWord') {
    element.innerHTML = '';

    if (animationType === 'wordByWord') {
      const words = text.split(' ');
      words.forEach((word, index) => {
        const span = document.createElement('span');
        span.textContent = word + ' ';
        span.style.opacity = '0';
        span.style.display = 'inline-block';
        span.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        element.appendChild(span);

        setTimeout(() => {
          span.style.opacity = '1';
          span.style.transform = 'translateY(0)';
        }, index * 100);
      });
    } else if (animationType === 'characterReveal') {
      const chars = text.split('');
      chars.forEach((char, index) => {
        const span = document.createElement('span');
        span.textContent = char;
        span.style.opacity = '0';
        span.style.display = 'inline-block';
        span.style.transition = 'opacity 0.05s ease';
        element.appendChild(span);

        setTimeout(() => {
          span.style.opacity = '1';
        }, index * 30);
      });
    } else {
      element.textContent = text;
    }
  },

  // Smooth transition between verses
  transitionVerse(oldElement, newElement, transitionType = 'smoothCrossfade') {
    return new Promise((resolve) => {
      const preset = this.presets[transitionType];
      if (!preset) {
        console.warn(`[animation-library] Transition "${transitionType}" not found`);
        resolve();
        return;
      }

      // Fade out old
      oldElement.style.transition = `opacity ${preset.duration / 2}ms ${preset.easing}`;
      oldElement.style.opacity = '0';

      setTimeout(() => {
        // Swap elements
        oldElement.style.display = 'none';
        newElement.style.display = 'block';
        newElement.style.opacity = '0';

        // Fade in new
        setTimeout(() => {
          newElement.style.transition = `opacity ${preset.duration / 2}ms ${preset.easing}`;
          newElement.style.opacity = '1';

          setTimeout(resolve, preset.duration / 2);
        }, 50);
      }, preset.duration / 2);
    });
  },

  // Get all available animations by category
  getAnimationsByCategory(category) {
    return Object.entries(this.presets)
      .filter(([_, preset]) => preset.category === category)
      .map(([key, preset]) => ({ key, name: preset.name, ...preset }));
  },

  // Get all available moods
  getAvailableMoods() {
    return Object.keys(this.moodRecommendations);
  },
};

// Export for use in overlay.html
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AnimationLibrary;
}
