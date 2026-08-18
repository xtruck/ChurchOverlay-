'use strict';
/**
 * ============================================================================
 *  professional-scene-manager.js — OBS-Style Professional Multi-Scene System
 * ----------------------------------------------------------------------------
 *  Enhanced scene management for conferences, events, and professional presentations
 *  Features: Scene collections, transitions, layer management, professional outputs
 * ============================================================================
 */

const sceneStore = require('./scene-store');
const mediaLibrary = require('./media-library');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ProfessionalSceneManager {
  constructor() {
    this.sceneCollections = new Map(); // Scene collections like OBS scenes
    this.activeCollection = null;
    this.activeScene = null;
    this.transitions = new Map();
    this.outputConfig = {
      main: { enabled: true, resolution: '1920x1080', fps: 60 },
      stage: { enabled: false, resolution: '1920x1080', fps: 30 },
      lobby: { enabled: false, resolution: '1920x1080', fps: 30 },
      record: { enabled: false, format: 'mp4', quality: 'high' }
    };
    this.layerVisibility = new Map(); // Layer visibility controls
    this.sceneHistory = []; // Undo/redo support
    this.historyIndex = -1;
  }

  /**
   * Initialize the professional scene manager
   */
  async initialize(userDataDir) {
    this.userDataDir = userDataDir;
    this.collectionsPath = path.join(userDataDir, 'scene-collections.json');
    this.configPath = path.join(userDataDir, 'output-config.json');
    
    // Initialize stores
    sceneStore.setUserDataDir(userDataDir);
    mediaLibrary.setUserDataDir(userDataDir);
    
    // Load existing data
    await this.loadCollections();
    await this.loadOutputConfig();
    
    // Create default collection if none exists
    if (this.sceneCollections.size === 0) {
      await this.createDefaultCollection();
    }
    
    // Set first collection as active
    const firstCollection = this.sceneCollections.keys().next().value;
    if (firstCollection) {
      this.activeCollection = firstCollection;
    }
    
    console.log('[ProfessionalSceneManager] Initialized with', this.sceneCollections.size, 'collections');
  }

  /**
   * Create a default scene collection for new users
   */
  async createDefaultCollection() {
    const defaultCollection = {
      id: crypto.randomUUID(),
      name: 'Main Service',
      type: 'service',
      scenes: [],
      transitions: {
        default: { type: 'fade', duration: 500 },
        stinger: null
      },
      layers: {
        background: { visible: true, locked: false },
        content: { visible: true, locked: false },
        overlay: { visible: true, locked: false },
        watermark: { visible: false, locked: true }
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    // Add some default scenes
    defaultCollection.scenes = [
      {
        id: crypto.randomUUID(),
        name: 'Black Screen',
        type: 'basic',
        background: { type: 'color', color: '#000000' },
        elements: [],
        isDefault: true
      },
      {
        id: crypto.randomUUID(),
        name: 'Logo Full',
        type: 'basic',
        background: { type: 'color', color: '#0b0f1a' },
        elements: [
          {
            id: crypto.randomUUID(),
            type: 'image',
            position: 'center',
            widthPct: 40,
            mediaId: null, // Will be set when logo is added
            rotationDeg: 0
          }
        ]
      },
      {
        id: crypto.randomUUID(),
        name: 'Welcome Screen',
        type: 'basic',
        background: { type: 'media', mediaId: null },
        elements: [
          {
            id: crypto.randomUUID(),
            type: 'text',
            text: 'Welcome',
            position: 'center',
            fontFamily: 'Cormorant Garamond',
            fontSizePct: 8,
            fontWeight: 700,
            color: '#FFFFFF',
            align: 'center',
            rotationDeg: 0
          }
        ]
      }
    ];
    
    this.sceneCollections.set(defaultCollection.id, defaultCollection);
    await this.saveCollections();
    
    console.log('[ProfessionalSceneManager] Created default collection:', defaultCollection.name);
  }

  /**
   * Create a new scene collection
   */
  async createCollection(name, type = 'custom') {
    const collection = {
      id: crypto.randomUUID(),
      name: name,
      type: type, // 'service', 'conference', 'custom', 'event'
      scenes: [],
      transitions: {
        default: { type: 'fade', duration: 500 },
        stinger: null
      },
      layers: {
        background: { visible: true, locked: false },
        content: { visible: true, locked: false },
        overlay: { visible: true, locked: false },
        watermark: { visible: false, locked: true }
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    this.sceneCollections.set(collection.id, collection);
    await this.saveCollections();
    
    return collection;
  }

  /**
   * Add a scene to a collection
   */
  async addSceneToCollection(collectionId, sceneData) {
    const collection = this.sceneCollections.get(collectionId);
    if (!collection) {
      throw new Error('Collection not found');
    }
    
    // Create scene in scene-store
    const scene = sceneStore.addScene(sceneData);
    
    // Add to collection
    collection.scenes.push({
      sceneId: scene.id,
      order: collection.scenes.length,
      customTransition: null
    });
    
    collection.updatedAt = new Date().toISOString();
    await this.saveCollections();
    
    return scene;
  }

  /**
   * Switch to a specific scene in the active collection
   */
  async switchScene(sceneId, transition = null) {
    const collection = this.sceneCollections.get(this.activeCollection);
    if (!collection) {
      throw new Error('No active collection');
    }
    
    const sceneEntry = collection.scenes.find(s => s.sceneId === sceneId);
    if (!sceneEntry) {
      throw new Error('Scene not found in collection');
    }
    
    // Get transition (use custom if available, otherwise default)
    const transitionConfig = transition || sceneEntry.customTransition || collection.transitions.default;
    
    // Store for history
    this.addToHistory({
      type: 'scene-switch',
      from: this.activeScene,
      to: sceneId,
      transition: transitionConfig,
      timestamp: Date.now()
    });
    
    this.activeScene = sceneId;
    
    return {
      sceneId,
      transition: transitionConfig,
      success: true
    };
  }

  /**
   * Set up scene transitions
   */
  async setTransition(collectionId, sceneId, transitionConfig) {
    const collection = this.sceneCollections.get(collectionId);
    if (!collection) {
      throw new Error('Collection not found');
    }
    
    if (sceneId === 'default') {
      collection.transitions.default = transitionConfig;
    } else {
      const sceneEntry = collection.scenes.find(s => s.sceneId === sceneId);
      if (sceneEntry) {
        sceneEntry.customTransition = transitionConfig;
      }
    }
    
    collection.updatedAt = new Date().toISOString();
    await this.saveCollections();
    
    return { success: true };
  }

  /**
   * Configure output settings (like OBS Output Settings)
   */
  async configureOutput(outputType, config) {
    if (this.outputConfig[outputType]) {
      this.outputConfig[outputType] = {
        ...this.outputConfig[outputType],
        ...config
      };
      await this.saveOutputConfig();
      return { success: true };
    }
    
    throw new Error('Invalid output type');
  }

  /**
   * Control layer visibility (like OBS layer controls)
   */
  setLayerVisibility(layerName, visible) {
    const collection = this.sceneCollections.get(this.activeCollection);
    if (collection && collection.layers[layerName]) {
      collection.layers[layerName].visible = visible;
      this.layerVisibility.set(layerName, visible);
      return { success: true };
    }
    
    throw new Error('Invalid layer name');
  }

  /**
   * Duplicate a scene (like OBS scene duplication)
   */
  async duplicateScene(sceneId) {
    const originalScene = sceneStore.getItem(sceneId);
    if (!originalScene) {
      throw new Error('Scene not found');
    }
    
    // Create duplicate with modified name
    const duplicateData = {
      ...originalScene,
      name: originalScene.name + ' (Copy)',
      triggerPhrases: [...originalScene.triggerPhrases] // Copy trigger phrases
    };
    
    // Remove fields that should be regenerated
    delete duplicateData.id;
    delete duplicateData.addedAt;
    delete duplicateData.updatedAt;
    delete duplicateData.isDefault;
    
    const newScene = sceneStore.addScene(duplicateData);
    
    // Add to active collection
    if (this.activeCollection) {
      await this.addSceneToCollection(this.activeCollection, {
        name: newScene.name,
        background: newScene.background,
        elements: newScene.elements,
        triggerPhrases: newScene.triggerPhrases
      });
    }
    
    return newScene;
  }

  /**
   * Get all collections with their scenes
   */
  getAllCollections() {
    const collections = [];
    for (const [id, collection] of this.sceneCollections) {
      const scenesWithDetails = collection.scenes.map(sceneEntry => {
        const scene = sceneStore.getItem(sceneEntry.sceneId);
        return {
          ...sceneEntry,
          details: scene
        };
      });
      
      collections.push({
        ...collection,
        scenes: scenesWithDetails
      });
    }
    
    return collections;
  }

  /**
   * Get active collection with scenes
   */
  getActiveCollection() {
    if (!this.activeCollection) return null;
    
    const collection = this.sceneCollections.get(this.activeCollection);
    if (!collection) return null;
    
    const scenesWithDetails = collection.scenes.map(sceneEntry => {
      const scene = sceneStore.getItem(sceneEntry.sceneId);
      return {
        ...sceneEntry,
        details: scene
      };
    });
    
    return {
      ...collection,
      scenes: scenesWithDetails
    };
  }

  /**
   * Import scenes from another collection or file
   */
  async importScenes(sourceCollectionId, targetCollectionId = null) {
    const sourceCollection = this.sceneCollections.get(sourceCollectionId);
    if (!sourceCollection) {
      throw new Error('Source collection not found');
    }
    
    const targetId = targetCollectionId || this.activeCollection;
    const targetCollection = this.sceneCollections.get(targetId);
    if (!targetCollection) {
      throw new Error('Target collection not found');
    }
    
    // Import each scene
    const importedScenes = [];
    for (const sceneEntry of sourceCollection.scenes) {
      const originalScene = sceneStore.getItem(sceneEntry.sceneId);
      if (originalScene) {
        const newScene = await this.addSceneToCollection(targetId, {
          name: originalScene.name,
          background: originalScene.background,
          elements: originalScene.elements,
          triggerPhrases: originalScene.triggerPhrases
        });
        importedScenes.push(newScene);
      }
    }
    
    return importedScenes;
  }

  /**
   * Export collection for backup or sharing
   */
  async exportCollection(collectionId) {
    const collection = this.sceneCollections.get(collectionId);
    if (!collection) {
      throw new Error('Collection not found');
    }
    
    // Get full scene data
    const exportData = {
      ...collection,
      scenes: collection.scenes.map(sceneEntry => {
        const scene = sceneStore.getItem(sceneEntry.sceneId);
        return {
          ...sceneEntry,
          fullSceneData: scene
        };
      })
    };
    
    return exportData;
  }

  /**
   * Import collection from export data
   */
  async importCollection(exportData) {
    const newCollection = {
      id: crypto.randomUUID(),
      name: exportData.name + ' (Imported)',
      type: exportData.type || 'custom',
      scenes: [],
      transitions: exportData.transitions || { default: { type: 'fade', duration: 500 } },
      layers: exportData.layers || {
        background: { visible: true, locked: false },
        content: { visible: true, locked: false },
        overlay: { visible: true, locked: false },
        watermark: { visible: false, locked: true }
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    
    // Import scenes
    for (const sceneEntry of exportData.scenes) {
      if (sceneEntry.fullSceneData) {
        const newScene = await this.addSceneToCollection(newCollection.id, {
          name: sceneEntry.fullSceneData.name,
          background: sceneEntry.fullSceneData.background,
          elements: sceneEntry.fullSceneData.elements,
          triggerPhrases: sceneEntry.fullSceneData.triggerPhrases
        });
      }
    }
    
    this.sceneCollections.set(newCollection.id, newCollection);
    await this.saveCollections();
    
    return newCollection;
  }

  /**
   * Add to history for undo/redo
   */
  addToHistory(action) {
    // Remove any future history if we're not at the end
    if (this.historyIndex < this.sceneHistory.length - 1) {
      this.sceneHistory = this.sceneHistory.slice(0, this.historyIndex + 1);
    }
    
    this.sceneHistory.push(action);
    this.historyIndex = this.sceneHistory.length - 1;
    
    // Limit history size
    if (this.sceneHistory.length > 50) {
      this.sceneHistory.shift();
      this.historyIndex--;
    }
  }

  /**
   * Undo last action
   */
  undo() {
    if (this.historyIndex <= 0) {
      return { success: false, message: 'Nothing to undo' };
    }
    
    const action = this.sceneHistory[this.historyIndex];
    this.historyIndex--;
    
    // Implement undo logic based on action type
    if (action.type === 'scene-switch') {
      return this.switchScene(action.from);
    }
    
    return { success: true, message: 'Undo performed' };
  }

  /**
   * Redo last undone action
   */
  redo() {
    if (this.historyIndex >= this.sceneHistory.length - 1) {
      return { success: false, message: 'Nothing to redo' };
    }
    
    this.historyIndex++;
    const action = this.sceneHistory[this.historyIndex];
    
    // Implement redo logic based on action type
    if (action.type === 'scene-switch') {
      return this.switchScene(action.to, action.transition);
    }
    
    return { success: true, message: 'Redo performed' };
  }

  /**
   * Save collections to disk
   */
  async saveCollections() {
    const data = Array.from(this.sceneCollections.entries());
    fs.writeFileSync(this.collectionsPath, JSON.stringify(data, null, 2), 'utf8');
  }

  /**
   * Load collections from disk
   */
  async loadCollections() {
    if (!fs.existsSync(this.collectionsPath)) {
      return;
    }
    
    try {
      const data = JSON.parse(fs.readFileSync(this.collectionsPath, 'utf8'));
      this.sceneCollections = new Map(data);
    } catch (e) {
      console.warn('[ProfessionalSceneManager] Failed to load collections:', e.message);
    }
  }

  /**
   * Save output configuration
   */
  async saveOutputConfig() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.outputConfig, null, 2), 'utf8');
  }

  /**
   * Load output configuration
   */
  async loadOutputConfig() {
    if (!fs.existsSync(this.configPath)) {
      return;
    }
    
    try {
      const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      this.outputConfig = { ...this.outputConfig, ...data };
    } catch (e) {
      console.warn('[ProfessionalSceneManager] Failed to load output config:', e.message);
    }
  }

  /**
   * Get system status
   */
  getStatus() {
    return {
      activeCollection: this.activeCollection,
      activeScene: this.activeScene,
      totalCollections: this.sceneCollections.size,
      totalScenes: Array.from(this.sceneCollections.values()).reduce((sum, col) => sum + col.scenes.length, 0),
      outputConfig: this.outputConfig,
      layerVisibility: Object.fromEntries(this.layerVisibility),
      historySize: this.sceneHistory.length,
      historyIndex: this.historyIndex
    };
  }
}

module.exports = ProfessionalSceneManager;