'use strict';
/**
 * ============================================================================
 *  creative-presentation-features.js — Advanced Creative Presentation Features
 * ----------------------------------------------------------------------------
 *  Innovative features for conferences, events, and professional presentations:
 *  - Dynamic transitions and effects
 *  - Audience interaction tools
 *  - Real-time collaboration
 *  - Advanced scheduling and automation
 *  - Professional output management
 * ============================================================================
 */

const professionalSceneManager = require('./professional-scene-manager');
const advancedMediaManager = require('./advanced-media-manager');

class CreativePresentationFeatures {
  constructor() {
    this.activeFeatures = new Map();
    this.scheduledEvents = new Map();
    this.audienceInteractions = new Map();
    this.collaborationSessions = new Map();
    this.automationRules = new Map();
  }

  /**
   * Initialize creative features
   */
  async initialize(userDataDir) {
    this.userDataDir = userDataDir;

    // Initialize managers
    this.sceneManager = new professionalSceneManager();
    await this.sceneManager.initialize(userDataDir);

    this.mediaManager = new advancedMediaManager();
    await this.mediaManager.initialize(userDataDir);

    console.log('[CreativeFeatures] Initialized with professional capabilities');
  }

  /**
   * Dynamic transitions between scenes (OBS-style)
   */
  async executeTransition(fromScene, toScene, transitionConfig) {
    const transition = {
      type: transitionConfig.type || 'fade',
      duration: transitionConfig.duration || 500,
      easing: transitionConfig.easing || 'ease-in-out',
      customStinger: transitionConfig.customStinger || null,
    };

    console.log('[CreativeFeatures] Executing transition:', transition);

    // Emit transition event for UI to handle
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('scene-transition', {
          detail: { fromScene, toScene, transition },
        })
      );
    }

    return {
      success: true,
      transition,
      estimatedDuration: transition.duration,
    };
  }

  /**
   * Advanced transition effects
   */
  getAvailableTransitions() {
    return {
      basic: [
        { id: 'fade', name: 'Fade', duration: 500, description: 'Simple crossfade' },
        { id: 'slide', name: 'Slide', duration: 400, description: 'Slide from direction' },
        { id: 'zoom', name: 'Zoom', duration: 600, description: 'Zoom in/out effect' },
        { id: 'cut', name: 'Cut', duration: 0, description: 'Instant cut' },
      ],
      advanced: [
        { id: 'stinger', name: 'Stinger', duration: 1000, description: 'Custom video transition' },
        { id: 'ripple', name: 'Ripple', duration: 800, description: 'Ripple dissolve effect' },
        { id: 'pixelate', name: 'Pixelate', duration: 600, description: 'Pixel dissolve' },
        { id: 'blur', name: 'Blur', duration: 500, description: 'Blur transition' },
      ],
      professional: [
        { id: 'broadcast', name: 'Broadcast', duration: 1200, description: 'TV-style transition' },
        { id: 'cinematic', name: 'Cinematic', duration: 1500, description: 'Film-style wipe' },
        {
          id: 'corporate',
          name: 'Corporate',
          duration: 800,
          description: 'Clean business transition',
        },
      ],
    };
  }

  /**
   * Audience interaction features
   */
  async enableAudienceInteraction(config) {
    const interaction = {
      id: Date.now().toString(),
      type: config.type || 'qna', // qna, poll, chat, reaction
      enabled: true,
      settings: {
        moderation: config.moderation !== false,
        displayMode: config.displayMode || 'overlay', // overlay, sidebar, fullscreen
        autoHide: config.autoHide !== false,
        timeout: config.timeout || 30000,
      },
      createdAt: Date.now(),
    };

    this.audienceInteractions.set(interaction.id, interaction);

    console.log('[CreativeFeatures] Enabled audience interaction:', interaction.type);

    return interaction;
  }

  /**
   * Poll creation and management
   */
  async createPoll(question, options) {
    const poll = {
      id: Date.now().toString(),
      type: 'poll',
      question,
      options: options.map((opt, index) => ({
        id: index.toString(),
        text: opt,
        votes: 0,
      })),
      active: true,
      createdAt: Date.now(),
    };

    this.audienceInteractions.set(poll.id, poll);

    return poll;
  }

  /**
   * Submit poll response
   */
  async submitPollResponse(pollId, optionId) {
    const poll = this.audienceInteractions.get(pollId);
    if (!poll || poll.type !== 'poll') {
      throw new Error('Poll not found');
    }

    const option = poll.options.find((opt) => opt.id === optionId);
    if (option) {
      option.votes++;
    }

    return {
      success: true,
      poll: this.getPollResults(pollId),
    };
  }

  /**
   * Get poll results
   */
  getPollResults(pollId) {
    const poll = this.audienceInteractions.get(pollId);
    if (!poll) return null;

    const totalVotes = poll.options.reduce((sum, opt) => sum + opt.votes, 0);

    return {
      ...poll,
      results: poll.options.map((opt) => ({
        ...opt,
        percentage: totalVotes > 0 ? (opt.votes / totalVotes) * 100 : 0,
      })),
      totalVotes,
    };
  }

  /**
   * Real-time collaboration features
   */
  async startCollaborationSession(config) {
    const session = {
      id: Date.now().toString(),
      name: config.name || 'Collaboration Session',
      host: config.host || 'operator',
      participants: [],
      permissions: {
        edit: config.allowEdit !== false,
        sceneControl: config.allowSceneControl !== false,
        mediaControl: config.allowMediaControl !== false,
      },
      status: 'active',
      createdAt: Date.now(),
    };

    this.collaborationSessions.set(session.id, session);

    console.log('[CreativeFeatures] Started collaboration session:', session.name);

    return session;
  }

  /**
   * Join collaboration session
   */
  async joinCollaborationSession(sessionId, participant) {
    const session = this.collaborationSessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    const participantData = {
      id: participant.id || Date.now().toString(),
      name: participant.name || 'Anonymous',
      role: participant.role || 'viewer',
      joinedAt: Date.now(),
    };

    session.participants.push(participantData);

    return {
      success: true,
      session,
      participant: participantData,
    };
  }

  /**
   * Broadcast collaboration action
   */
  async broadcastCollaborationAction(sessionId, action) {
    const session = this.collaborationSessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    // Broadcast to all participants
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('collaboration-action', {
          detail: { sessionId, action },
        })
      );
    }

    return { success: true };
  }

  /**
   * Automation and scheduling
   */
  async scheduleEvent(config) {
    const event = {
      id: Date.now().toString(),
      type: config.type || 'scene-switch', // scene-switch, media-play, transition, custom
      trigger: config.trigger || 'manual', // manual, time, voice, condition
      triggerTime: config.triggerTime || null,
      triggerCondition: config.triggerCondition || null,
      action: config.action,
      enabled: true,
      executed: false,
      createdAt: Date.now(),
    };

    this.scheduledEvents.set(event.id, event);

    console.log('[CreativeFeatures] Scheduled event:', event.type);

    return event;
  }

  /**
   * Execute scheduled event
   */
  async executeScheduledEvent(eventId) {
    const event = this.scheduledEvents.get(eventId);
    if (!event) {
      throw new Error('Event not found');
    }

    try {
      switch (event.type) {
        case 'scene-switch':
          await this.sceneManager.switchScene(event.action.sceneId, event.action.transition);
          break;
        case 'media-play':
          // Implement media playback
          break;
        case 'transition':
          await this.executeTransition(event.action.from, event.action.to, event.action.transition);
          break;
        case 'custom':
          // Execute custom action
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('custom-automation', {
                detail: event.action,
              })
            );
          }
          break;
      }

      event.executed = true;
      event.executedAt = Date.now();

      return { success: true, event };
    } catch (error) {
      console.error('[CreativeFeatures] Failed to execute event:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Create automation rule
   */
  async createAutomationRule(config) {
    const rule = {
      id: Date.now().toString(),
      name: config.name || 'Automation Rule',
      condition: config.condition, // voice, time, manual, external
      conditionValue: config.conditionValue,
      action: config.action,
      enabled: true,
      triggerCount: 0,
      lastTriggered: null,
      createdAt: Date.now(),
    };

    this.automationRules.set(rule.id, rule);

    return rule;
  }

  /**
   * Check and trigger automation rules
   */
  async checkAutomationRules(context) {
    const triggeredRules = [];

    for (const [ruleId, rule] of this.automationRules) {
      if (!rule.enabled) continue;

      let shouldTrigger = false;

      switch (rule.condition) {
        case 'voice':
          if (context.transcript && context.transcript.includes(rule.conditionValue)) {
            shouldTrigger = true;
          }
          break;
        case 'time': {
          const currentTime = new Date();
          const triggerTime = new Date(rule.conditionValue);
          if (Math.abs(currentTime - triggerTime) < 1000) {
            // Within 1 second
            shouldTrigger = true;
          }
          break;
        }
        case 'manual':
          shouldTrigger = context.manualTrigger === ruleId;
          break;
      }

      if (shouldTrigger) {
        await this.executeAutomationAction(rule.action);
        rule.triggerCount++;
        rule.lastTriggered = Date.now();
        triggeredRules.push(rule);
      }
    }

    return triggeredRules;
  }

  /**
   * Execute automation action
   */
  async executeAutomationAction(action) {
    switch (action.type) {
      case 'scene-switch':
        return await this.sceneManager.switchScene(action.sceneId, action.transition);
      case 'media-play':
        // Implement media playback
        break;
      case 'transition':
        return await this.executeTransition(action.from, action.to, action.transition);
      case 'function':
        if (action.functionName && typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('automation-function', {
              detail: { functionName: action.functionName, params: action.params },
            })
          );
        }
        break;
    }

    return { success: true };
  }

  /**
   * Professional output management
   */
  async configureOutput(outputType, config) {
    return await this.sceneManager.configureOutput(outputType, config);
  }

  /**
   * Get output status
   */
  getOutputStatus() {
    return this.sceneManager.outputConfig;
  }

  /**
   * Multi-view output (like OBS Multi-View)
   */
  async enableMultiView(config) {
    const multiViewConfig = {
      enabled: true,
      layout: config.layout || 'grid', // grid, vertical, horizontal, custom
      sources: config.sources || [],
      gridSize: config.gridSize || { rows: 2, cols: 2 },
      labels: config.labels !== false,
      timestamps: config.timestamps !== false,
    };

    this.activeFeatures.set('multiView', multiViewConfig);

    console.log('[CreativeFeatures] Multi-view enabled:', multiViewConfig.layout);

    return multiViewConfig;
  }

  /**
   * Advanced effects and overlays
   */
  async applyEffect(effectConfig) {
    const effect = {
      id: Date.now().toString(),
      type: effectConfig.type || 'filter', // filter, overlay, animation
      name: effectConfig.name || 'Custom Effect',
      settings: effectConfig.settings || {},
      duration: effectConfig.duration || 0, // 0 = permanent
      startTime: Date.now(),
    };

    this.activeFeatures.set(effect.id, effect);

    // Emit effect event
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('effect-applied', {
          detail: effect,
        })
      );
    }

    return effect;
  }

  /**
   * Remove effect
   */
  async removeEffect(effectId) {
    const effect = this.activeFeatures.get(effectId);
    if (!effect) {
      throw new Error('Effect not found');
    }

    this.activeFeatures.delete(effectId);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('effect-removed', {
          detail: { effectId },
        })
      );
    }

    return { success: true };
  }

  /**
   * Template system for quick setups
   */
  async createTemplate(config) {
    const template = {
      id: Date.now().toString(),
      name: config.name || 'Custom Template',
      type: config.type || 'conference', // service, conference, event, custom
      scenes: config.scenes || [],
      media: config.media || [],
      settings: config.settings || {},
      transitions: config.transitions || {},
      createdAt: Date.now(),
    };

    // Save template
    const templatesPath = require('path').join(this.userDataDir, 'templates.json');
    const fs = require('fs');

    let templates = [];
    if (fs.existsSync(templatesPath)) {
      templates = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
    }

    templates.push(template);
    fs.writeFileSync(templatesPath, JSON.stringify(templates, null, 2), 'utf8');

    return template;
  }

  /**
   * Load template
   */
  async loadTemplate(templateId) {
    const templatesPath = require('path').join(this.userDataDir, 'templates.json');
    const fs = require('fs');

    if (!fs.existsSync(templatesPath)) {
      throw new Error('No templates found');
    }

    const templates = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
    const template = templates.find((t) => t.id === templateId);

    if (!template) {
      throw new Error('Template not found');
    }

    // Apply template to current session
    for (const sceneData of template.scenes) {
      await this.sceneManager.addSceneToCollection(this.sceneManager.activeCollection, sceneData);
    }

    return template;
  }

  /**
   * Get system status
   */
  getStatus() {
    return {
      sceneManager: this.sceneManager?.getStatus(),
      mediaManager: this.mediaManager?.getStatus(),
      activeFeatures: Object.fromEntries(this.activeFeatures),
      scheduledEvents: Array.from(this.scheduledEvents.values()).filter((e) => !e.executed),
      collaborationSessions: Array.from(this.collaborationSessions.values()),
      automationRules: Array.from(this.automationRules.values()),
      audienceInteractions: Array.from(this.audienceInteractions.values()),
    };
  }

  /**
   * Export current session state
   */
  async exportSession() {
    const sessionState = {
      sceneCollections: this.sceneManager.getAllCollections(),
      mediaLibrary: this.mediaManager ? this.mediaManager.searchMedia('') : [],
      activeFeatures: Object.fromEntries(this.activeFeatures),
      scheduledEvents: Array.from(this.scheduledEvents.values()),
      automationRules: Array.from(this.automationRules.values()),
      exportedAt: Date.now(),
      version: '1.0',
    };

    return sessionState;
  }

  /**
   * Import session state
   */
  async importSession(sessionState) {
    try {
      // Import scene collections
      for (const collection of sessionState.sceneCollections) {
        await this.sceneManager.importCollection(collection);
      }

      // Import active features
      for (const [id, feature] of Object.entries(sessionState.activeFeatures)) {
        this.activeFeatures.set(id, feature);
      }

      // Import scheduled events
      for (const event of sessionState.scheduledEvents) {
        this.scheduledEvents.set(event.id, event);
      }

      // Import automation rules
      for (const rule of sessionState.automationRules) {
        this.automationRules.set(rule.id, rule);
      }

      return { success: true };
    } catch (error) {
      console.error('[CreativeFeatures] Failed to import session:', error);
      return { success: false, error: error.message };
    }
  }
}

module.exports = CreativePresentationFeatures;
