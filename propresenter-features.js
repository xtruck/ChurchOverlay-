'use strict';
/**
 * ============================================================================
 *  propresenter-features.js — ProPresenter-Inspired Professional Features
 * ----------------------------------------------------------------------------
 *  Implementing the most useful ProPresenter 7 features:
 *  - Announcement Layer (separate lobby display)
 *  - Stage Display customization
 *  - Multi-Bible translation display
 *  - Dynamic text scaling
 *  - Linked text fields
 *  - Audio channel routing
 *  - Calendar/scheduling
 *  - Key/Fill channels
 *  - Multi-output management
 * ============================================================================
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class ProPresenterFeatures {
  constructor() {
    this.announcementLayer = {
      enabled: false,
      content: [],
      loopInterval: null,
      currentIndex: 0,
      targetOutput: 'lobby',
    };

    this.stageDisplays = new Map();
    this.stageDisplayLayouts = new Map();

    this.bibleTranslations = new Map();
    this.multiBibleConfig = {
      enabled: false,
      primaryLanguage: 'fr',
      secondaryLanguage: 'en',
      displayMode: 'side-by-side', // side-by-side, stacked, toggle
    };

    this.linkedTextFields = new Map();
    this.dynamicTextScaling = {
      enabled: true,
      baseSize: 32,
      minSize: 12,
      maxSize: 64,
    };

    this.audioRouting = {
      channels: {
        main: { enabled: true, volume: 1.0 },
        backup: { enabled: false, volume: 0.8 },
        music: { enabled: false, volume: 0.5 },
      },
    };

    this.scheduledEvents = new Map();
    this.keyFillChannels = {
      key: { enabled: true, content: 'foreground' },
      fill: { enabled: true, content: 'background' },
    };

    this.multiOutputs = new Map();
  }

  /**
   * Initialize ProPresenter features
   */
  async initialize(userDataDir) {
    this.userDataDir = userDataDir;
    this.configPath = path.join(userDataDir, 'propresenter-features.json');

    // Load existing configuration
    await this.loadConfiguration();

    console.log('[ProPresenterFeatures] Initialized with ProPresenter 7-style features');
  }

  /**
   * Announcement Layer - separate output for lobby displays
   */
  async enableAnnouncementLayer(targetOutput = 'lobby') {
    this.announcementLayer.enabled = true;
    this.announcementLayer.targetOutput = targetOutput;

    // Start looping announcement content
    this.startAnnouncementLoop();

    console.log('[ProPresenterFeatures] Announcement layer enabled for:', targetOutput);

    return { success: true, targetOutput };
  }

  addAnnouncementContent(content) {
    const announcement = {
      id: crypto.randomUUID(),
      type: content.type || 'slide', // slide, image, video, text
      content: content.content,
      duration: content.duration || 5000,
      enabled: true,
      createdAt: Date.now(),
    };

    this.announcementLayer.content.push(announcement);
    return announcement;
  }

  removeAnnouncementContent(announcementId) {
    this.announcementLayer.content = this.announcementLayer.content.filter(
      (a) => a.id !== announcementId
    );
  }

  startAnnouncementLoop() {
    if (this.announcementLayer.loopInterval) {
      clearInterval(this.announcementLayer.loopInterval);
    }

    this.announcementLayer.loopInterval = setInterval(() => {
      if (this.announcementLayer.content.length === 0) return;

      const current = this.announcementLayer.content[this.announcementLayer.currentIndex];
      if (current && current.enabled) {
        this.emitAnnouncementDisplay(current);
      }

      this.announcementLayer.currentIndex =
        (this.announcementLayer.currentIndex + 1) % this.announcementLayer.content.length;
    }, 5000); // Check every 5 seconds
  }

  emitAnnouncementDisplay(announcement) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('announcement-display', {
          detail: {
            content: announcement,
            targetOutput: this.announcementLayer.targetOutput,
          },
        })
      );
    }
  }

  /**
   * Stage Display customization
   */
  createStageDisplay(config) {
    const stageDisplay = {
      id: crypto.randomUUID(),
      name: config.name || 'Stage Display',
      layout: config.layout || 'default',
      elements: config.elements || [],
      output: config.output || 'stage',
      resolution: config.resolution || '1920x1080',
      enabled: true,
      createdAt: Date.now(),
    };

    this.stageDisplays.set(stageDisplay.id, stageDisplay);

    return stageDisplay;
  }

  createStageLayout(name, layoutConfig) {
    const layout = {
      id: crypto.randomUUID(),
      name: name,
      sections: layoutConfig.sections || [], // header, content, footer, notes
      layout: layoutConfig.layout || 'grid',
      backgroundColor: layoutConfig.backgroundColor || '#0b0f1a',
      textColor: layoutConfig.textColor || '#ffffff',
      fontSize: layoutConfig.fontSize || 24,
    };

    this.stageDisplayLayouts.set(layout.id, layout);

    return layout;
  }

  updateStageDisplay(stageDisplayId, updates) {
    const display = this.stageDisplays.get(stageDisplayId);
    if (!display) {
      throw new Error('Stage display not found');
    }

    Object.assign(display, updates);
    return display;
  }

  /**
   * Multi-Bible translation display
   */
  enableMultiBible(config) {
    this.multiBibleConfig = {
      enabled: true,
      primaryLanguage: config.primaryLanguage || 'fr',
      secondaryLanguage: config.secondaryLanguage || 'en',
      displayMode: config.displayMode || 'side-by-side',
    };

    console.log('[ProPresenterFeatures] Multi-Bible enabled:', this.multiBibleConfig);

    return this.multiBibleConfig;
  }

  async fetchParallelBibleVerses(reference, languages) {
    const verses = new Map();

    for (const language of languages) {
      try {
        // This would call bible-lookup-with-api.js with language parameter
        // For now, simulate the result
        verses.set(language, {
          reference,
          language,
          text: `[Verse in ${language}] ${reference}`,
          fetchedAt: Date.now(),
        });
      } catch (e) {
        console.warn(`[ProPresenterFeatures] Failed to fetch verse in ${language}:`, e.message);
      }
    }

    return verses;
  }

  formatMultiBibleDisplay(verses, displayMode) {
    const verseArray = Array.from(verses.values());

    switch (displayMode) {
      case 'side-by-side':
        return verseArray.map((v) => ({
          language: v.language,
          text: v.text,
          width: 50 / verseArray.length,
        }));
      case 'stacked':
        return verseArray.map((v) => ({
          language: v.language,
          text: v.text,
          height: 100 / verseArray.length,
        }));
      case 'toggle':
        // Show primary, allow toggle to secondary
        return {
          primary: verses.get(this.multiBibleConfig.primaryLanguage),
          secondary: verses.get(this.multiBibleConfig.secondaryLanguage),
        };
      default:
        return verseArray;
    }
  }

  /**
   * Dynamic text scaling (ProPresenter 7 feature)
   */
  setDynamicTextScaling(config) {
    this.dynamicTextScaling = {
      enabled: config.enabled !== false,
      baseSize: config.baseSize || 32,
      minSize: config.minSize || 12,
      maxSize: config.maxSize || 64,
      scalingFactor: config.scalingFactor || 1.0,
    };

    return this.dynamicTextScaling;
  }

  calculateOptimalTextSize(text, _containerWidth, _containerHeight) {
    if (!this.dynamicTextScaling.enabled) {
      return this.dynamicTextScaling.baseSize;
    }

    // Calculate optimal size based on text length and container
    const textLength = text.length;
    const textRatio = textLength / 50; // Normalize to 50 characters

    let calculatedSize = this.dynamicTextScaling.baseSize / (textRatio * 0.5);

    // Clamp to min/max bounds
    calculatedSize = Math.max(
      this.dynamicTextScaling.minSize,
      Math.min(this.dynamicTextScaling.maxSize, calculatedSize)
    );

    return Math.round(calculatedSize);
  }

  /**
   * Linked text fields (ProPresenter 7 feature)
   */
  createLinkedTextField(sourceId, linkedFields) {
    const linkedField = {
      id: crypto.randomUUID(),
      sourceId: sourceId, // e.g., timer, slide number, media cue
      linkedFields: linkedFields || [], // Array of element IDs to update
      format: 'text', // text, number, time
      prefix: '',
      suffix: '',
      enabled: true,
    };

    this.linkedTextFields.set(linkedField.id, linkedField);

    return linkedField;
  }

  updateLinkedField(linkedFieldId, value) {
    const linkedField = this.linkedTextFields.get(linkedFieldId);
    if (!linkedField) {
      throw new Error('Linked field not found');
    }

    const formattedValue = this.formatLinkedValue(value, linkedField);

    // Update all linked elements
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('linked-field-update', {
          detail: {
            linkedFieldId,
            linkedFields: linkedField.linkedFields,
            value: formattedValue,
          },
        })
      );
    }

    return { success: true, formattedValue };
  }

  formatLinkedValue(value, linkedField) {
    switch (linkedField.format) {
      case 'time':
        return `${linkedField.prefix}${this.formatTime(value)}${linkedField.suffix}`;
      case 'number':
        return `${linkedField.prefix}${value}${linkedField.suffix}`;
      case 'text':
      default:
        return `${linkedField.prefix}${value}${linkedField.suffix}`;
    }
  }

  formatTime(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Audio channel routing (ProPresenter 7 feature)
   */
  configureAudioChannel(channel, config) {
    if (!this.audioRouting.channels[channel]) {
      throw new Error(`Invalid audio channel: ${channel}`);
    }

    this.audioRouting.channels[channel] = {
      ...this.audioRouting.channels[channel],
      ...config,
    };

    console.log('[ProPresenterFeatures] Audio channel configured:', channel, config);

    return this.audioRouting.channels[channel];
  }

  getAudioRoutingStatus() {
    return this.audioRouting;
  }

  /**
   * Calendar/scheduling (ProPresenter 7 feature)
   */
  scheduleEvent(config) {
    const event = {
      id: crypto.randomUUID(),
      name: config.name,
      type: config.type || 'media-play', // media-play, scene-switch, announcement
      scheduledTime: config.scheduledTime,
      duration: config.duration || 0,
      content: config.content || {},
      repeat: config.repeat || false,
      repeatInterval: config.repeatInterval || null,
      executed: false,
      createdAt: Date.now(),
    };

    this.scheduledEvents.set(event.id, event);

    console.log('[ProPresenterFeatures] Event scheduled:', event.name, event.scheduledTime);

    return event;
  }

  checkScheduledEvents() {
    const now = Date.now();
    const eventsToExecute = [];

    for (const event of this.scheduledEvents.values()) {
      if (event.executed) continue;

      if (now >= new Date(event.scheduledTime).getTime()) {
        eventsToExecute.push(event);
        event.executed = true;

        // Handle repeat events
        if (event.repeat && event.repeatInterval) {
          const nextExecution = new Date(event.scheduledTime).getTime() + event.repeatInterval;
          event.scheduledTime = new Date(nextExecution).toISOString();
          event.executed = false;
        }
      }
    }

    // Execute events
    for (const event of eventsToExecute) {
      this.executeScheduledEvent(event);
    }

    return eventsToExecute;
  }

  executeScheduledEvent(event) {
    console.log('[ProPresenterFeatures] Executing scheduled event:', event.name);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('scheduled-event-triggered', {
          detail: event,
        })
      );
    }
  }

  /**
   * Key/Fill channels (ProPresenter broadcast feature)
   */
  configureKeyFillChannels(config) {
    this.keyFillChannels = {
      key: {
        enabled: config.key?.enabled !== false,
        content: config.key?.content || 'foreground',
        alpha: config.key?.alpha || 1.0,
      },
      fill: {
        enabled: config.fill?.enabled !== false,
        content: config.fill?.content || 'background',
        alpha: config.fill?.alpha || 1.0,
      },
    };

    console.log('[ProPresenterFeatures] Key/Fill channels configured');

    return this.keyFillChannels;
  }

  getKeyFillStatus() {
    return this.keyFillChannels;
  }

  /**
   * Multi-output management (ProPresenter multiscreen)
   */
  addOutput(outputConfig) {
    const output = {
      id: crypto.randomUUID(),
      name: outputConfig.name || 'Output',
      type: outputConfig.type || 'screen', // screen, ndi, sdi, recording
      resolution: outputConfig.resolution || '1920x1080',
      fps: outputConfig.fps || 60,
      enabled: true,
      content: outputConfig.content || 'main',
      createdAt: Date.now(),
    };

    this.multiOutputs.set(output.id, output);

    return output;
  }

  removeOutput(outputId) {
    return this.multiOutputs.delete(outputId);
  }

  updateOutputContent(outputId, content) {
    const output = this.multiOutputs.get(outputId);
    if (!output) {
      throw new Error('Output not found');
    }

    output.content = content;

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('output-content-updated', {
          detail: { outputId, content },
        })
      );
    }

    return output;
  }

  /**
   * Advanced slide notes (ProPresenter 7 feature)
   */
  addSlideNotes(slideId, notes) {
    const slideNotes = {
      slideId,
      notes: Array.isArray(notes) ? notes : [notes],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Store in memory (in production, would be saved to file)
    this.slideNotes = this.slideNotes || new Map();
    this.slideNotes.set(slideId, slideNotes);

    return slideNotes;
  }

  getSlideNotes(slideId) {
    this.slideNotes = this.slideNotes || new Map();
    return this.slideNotes.get(slideId);
  }

  /**
   * EasyView - operator display customization (ProPresenter 7)
   */
  configureEasyView(config) {
    this.easyViewConfig = {
      enabled: config.enabled !== false,
      fontFamily: config.fontFamily || 'Plus Jakarta Sans',
      fontSize: config.fontSize || 24,
      textColor: config.textColor || '#ffffff',
      backgroundColor: config.backgroundColor || '#0b0f1a',
      showSpeakerNotes: config.showSpeakerNotes !== false,
      showTimers: config.showTimers !== false,
      showNextSlide: config.showNextSlide !== false,
    };

    return this.easyViewConfig;
  }

  /**
   * Save configuration
   */
  async saveConfiguration() {
    const config = {
      announcementLayer: this.announcementLayer,
      stageDisplays: Array.from(this.stageDisplays.entries()),
      stageDisplayLayouts: Array.from(this.stageDisplayLayouts.entries()),
      multiBibleConfig: this.multiBibleConfig,
      linkedTextFields: Array.from(this.linkedTextFields.entries()),
      dynamicTextScaling: this.dynamicTextScaling,
      audioRouting: this.audioRouting,
      scheduledEvents: Array.from(this.scheduledEvents.entries()),
      keyFillChannels: this.keyFillChannels,
      multiOutputs: Array.from(this.multiOutputs.entries()),
      easyViewConfig: this.easyViewConfig,
    };

    fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf8');
  }

  /**
   * Load configuration
   */
  async loadConfiguration() {
    if (!fs.existsSync(this.configPath)) {
      return;
    }

    try {
      const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));

      this.announcementLayer = config.announcementLayer || this.announcementLayer;
      this.stageDisplays = new Map(config.stageDisplays || []);
      this.stageDisplayLayouts = new Map(config.stageDisplayLayouts || []);
      this.multiBibleConfig = config.multiBibleConfig || this.multiBibleConfig;
      this.linkedTextFields = new Map(config.linkedTextFields || []);
      this.dynamicTextScaling = config.dynamicTextScaling || this.dynamicTextScaling;
      this.audioRouting = config.audioRouting || this.audioRouting;
      this.scheduledEvents = new Map(config.scheduledEvents || []);
      this.keyFillChannels = config.keyFillChannels || this.keyFillChannels;
      this.multiOutputs = new Map(config.multiOutputs || []);
      this.easyViewConfig = config.easyViewConfig || {};

      // Restart announcement loop if it was enabled
      if (this.announcementLayer.enabled) {
        this.startAnnouncementLoop();
      }
    } catch (e) {
      console.warn('[ProPresenterFeatures] Failed to load configuration:', e.message);
    }
  }

  /**
   * Get system status
   */
  getStatus() {
    return {
      announcementLayer: this.announcementLayer,
      stageDisplays: Array.from(this.stageDisplays.values()),
      multiBibleConfig: this.multiBibleConfig,
      linkedTextFields: Array.from(this.linkedTextFields.values()),
      dynamicTextScaling: this.dynamicTextScaling,
      audioRouting: this.audioRouting,
      scheduledEvents: Array.from(this.scheduledEvents.values()),
      keyFillChannels: this.keyFillChannels,
      multiOutputs: Array.from(this.multiOutputs.values()),
      easyViewConfig: this.easyViewConfig,
    };
  }
}

module.exports = ProPresenterFeatures;
