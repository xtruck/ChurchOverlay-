'use strict';
/**
 * ============================================================================
 *  PROFESSIONAL-INTEGRATION.js — System Integration & Backward Compatibility
 * ----------------------------------------------------------------------------
 *  Integrates all new professional features while maintaining existing functionality
 *  Ensures the app remains fully operational with enhanced capabilities
 * ============================================================================
 */

const professionalSceneManager = require('./professional-scene-manager');
const advancedMediaManager = require('./advanced-media-manager');
const creativePresentationFeatures = require('./creative-presentation-features');
const sceneStore = require('./scene-store');
const mediaLibrary = require('./media-library');

class ProfessionalIntegration {
  constructor() {
    this.sceneManager = null;
    this.mediaManager = null;
    this.creativeFeatures = null;
    this.initialized = false;
    this.compatibilityMode = false;
  }

  /**
   * Initialize the professional integration system
   */
  async initialize(userDataDir) {
    console.log('[ProfessionalIntegration] Initializing professional features...');

    try {
      // Initialize managers
      this.sceneManager = new professionalSceneManager();
      await this.sceneManager.initialize(userDataDir);

      this.mediaManager = new advancedMediaManager();
      await this.mediaManager.initialize(userDataDir);

      this.creativeFeatures = new creativePresentationFeatures();
      await this.creativeFeatures.initialize(userDataDir);

      // Verify backward compatibility
      await this.verifyBackwardCompatibility();

      this.initialized = true;
      console.log('[ProfessionalIntegration] Professional features initialized successfully');

      return {
        success: true,
        features: {
          sceneManager: true,
          mediaManager: true,
          creativeFeatures: true
        }
      };
    } catch (error) {
      console.error('[ProfessionalIntegration] Initialization failed:', error);
      
      // Fall back to compatibility mode
      this.compatibilityMode = true;
      console.warn('[ProfessionalIntegration] Running in compatibility mode');

      return {
        success: true,
        compatibilityMode: true,
        error: error.message
      };
    }
  }

  /**
   * Verify backward compatibility with existing systems
   */
  async verifyBackwardCompatibility() {
    console.log('[ProfessionalIntegration] Verifying backward compatibility...');

    // Test scene-store compatibility
    try {
      const scenes = sceneStore.listItems();
      console.log(`[ProfessionalIntegration] scene-store compatible: ${scenes.length} scenes found`);
    } catch (e) {
      console.warn('[ProfessionalIntegration] scene-store compatibility issue:', e.message);
    }

    // Test media-library compatibility
    try {
      const media = mediaLibrary.listItems();
      console.log(`[ProfessionalIntegration] media-library compatible: ${media.length} items found`);
    } catch (e) {
      console.warn('[ProfessionalIntegration] media-library compatibility issue:', e.message);
    }

    // Ensure existing data is preserved
    await this.migrateExistingData();
  }

  /**
   * Migrate existing data to new systems
   */
  async migrateExistingData() {
    console.log('[ProfessionalIntegration] Migrating existing data...');

    // Migrate existing scenes to professional scene manager
    try {
      const existingScenes = sceneStore.listItems();
      const mainCollection = this.sceneManager.getAllCollections()[0];

      if (mainCollection && existingScenes.length > 0) {
        for (const scene of existingScenes) {
          try {
            // Check if scene already exists in collection
            const exists = mainCollection.scenes.some(s => s.sceneId === scene.id);
            if (!exists) {
              await this.sceneManager.addSceneToCollection(mainCollection.id, {
                name: scene.name,
                background: scene.background,
                elements: scene.elements,
                triggerPhrases: scene.triggerPhrases
              });
            }
          } catch (e) {
            console.warn('[ProfessionalIntegration] Failed to migrate scene:', scene.id, e.message);
          }
        }
      }
    } catch (e) {
      console.warn('[ProfessionalIntegration] Scene migration failed:', e.message);
    }

    // Migrate existing media to advanced media manager
    try {
      const existingMedia = mediaLibrary.listItems();
      
      for (const media of existingMedia) {
        try {
          // Auto-tag existing media
          await this.mediaManager.autoTagMedia(media.id, media.filename);
        } catch (e) {
          console.warn('[ProfessionalIntegration] Failed to tag media:', media.id, e.message);
        }
      }
    } catch (e) {
      console.warn('[ProfessionalIntegration] Media migration failed:', e.message);
    }

    console.log('[ProfessionalIntegration] Data migration complete');
  }

  /**
   * Get unified system status
   */
  getSystemStatus() {
    if (!this.initialized) {
      return {
        initialized: false,
        compatibilityMode: this.compatibilityMode
      };
    }

    return {
      initialized: true,
      compatibilityMode: this.compatibilityMode,
      sceneManager: this.sceneManager?.getStatus(),
      mediaManager: this.mediaManager?.getStatus(),
      creativeFeatures: this.creativeFeatures?.getStatus(),
      backwardCompatibility: {
        sceneStore: sceneStore.listItems().length,
        mediaLibrary: mediaLibrary.listItems().length
      }
    };
  }

  /**
   * Unified scene operations (backward compatible)
   */
  async addScene(sceneData) {
    // Use new system if available, otherwise fall back to old
    if (this.sceneManager && !this.compatibilityMode) {
      return await this.sceneManager.addSceneToCollection(
        this.sceneManager.activeCollection,
        sceneData
      );
    } else {
      return sceneStore.addScene(sceneData);
    }
  }

  async updateScene(sceneId, patch) {
    if (this.sceneManager && !this.compatibilityMode) {
      const collection = this.sceneManager.getActiveCollection();
      if (collection) {
        const sceneEntry = collection.scenes.find(s => s.sceneId === sceneId);
        if (sceneEntry) {
          return sceneStore.updateScene(sceneId, patch);
        }
      }
    }
    return sceneStore.updateScene(sceneId, patch);
  }

  async deleteScene(sceneId) {
    if (this.sceneManager && !this.compatibilityMode) {
      // Remove from collection first
      const collection = this.sceneManager.getActiveCollection();
      if (collection) {
        collection.scenes = collection.scenes.filter(s => s.sceneId !== sceneId);
        await this.sceneManager.saveCollections();
      }
    }
    return sceneStore.deleteItem(sceneId);
  }

  /**
   * Unified media operations (backward compatible)
   */
  async addMedia(sourcePath, options = {}) {
    if (this.mediaManager && !this.compatibilityMode) {
      return await this.mediaManager.uploadMedia(sourcePath, options);
    } else {
      return mediaLibrary.addItem({ sourcePath, ...options });
    }
  }

  async deleteMedia(mediaId) {
    // Always use media-library for deletion (source of truth)
    return mediaLibrary.deleteItem(mediaId);
  }

  /**
   * Unified search operations
   */
  searchMedia(query, filters = {}) {
    if (this.mediaManager && !this.compatibilityMode) {
      return this.mediaManager.searchMedia(query, filters);
    } else {
      // Basic search in media-library
      const allMedia = mediaLibrary.listItems();
      const normalizedQuery = query.toLowerCase();
      return allMedia.filter(item => 
        item.label.toLowerCase().includes(normalizedQuery) ||
        item.filename.toLowerCase().includes(normalizedQuery)
      );
    }
  }

  /**
   * Scene switching with transitions
   */
  async switchScene(sceneId, transition = null) {
    if (this.sceneManager && !this.compatibilityMode) {
      return await this.sceneManager.switchScene(sceneId, transition);
    } else {
      // Basic scene switching (old behavior)
      console.log('[ProfessionalIntegration] Basic scene switch:', sceneId);
      return { success: true, sceneId };
    }
  }

  /**
   * Layer control (new feature, backward compatible)
   */
  setLayerVisibility(layerName, visible) {
    if (this.sceneManager && !this.compatibilityMode) {
      return this.sceneManager.setLayerVisibility(layerName, visible);
    }
    // Silently ignore in compatibility mode
    return { success: true };
  }

  /**
   * Output configuration (new feature, backward compatible)
   */
  async configureOutput(outputType, config) {
    if (this.sceneManager && !this.compatibilityMode) {
      return await this.sceneManager.configureOutput(outputType, config);
    }
    // Silently ignore in compatibility mode
    return { success: true };
  }

  /**
   * Creative features (new feature, backward compatible)
   */
  async enableCreativeFeature(featureType, config) {
    if (this.creativeFeatures && !this.compatibilityMode) {
      switch (featureType) {
        case 'audience-interaction':
          return await this.creativeFeatures.enableAudienceInteraction(config);
        case 'collaboration':
          return await this.creativeFeatures.startCollaborationSession(config);
        case 'automation':
          return await this.creativeFeatures.createAutomationRule(config);
        case 'multi-view':
          return await this.creativeFeatures.enableMultiView(config);
        default:
          throw new Error('Unknown feature type');
      }
    }
    // Silently ignore in compatibility mode
    return { success: true };
  }

  /**
   * Execute scheduled event
   */
  async executeScheduledEvent(eventId) {
    if (this.creativeFeatures && !this.compatibilityMode) {
      return await this.creativeFeatures.executeScheduledEvent(eventId);
    }
    return { success: true };
  }

  /**
   * Export/import session state
   */
  async exportSession() {
    if (this.creativeFeatures && !this.compatibilityMode) {
      return await this.creativeFeatures.exportSession();
    }
    // Basic export in compatibility mode
    return {
      scenes: sceneStore.listItems(),
      media: mediaLibrary.listItems(),
      exportedAt: Date.now(),
      compatibilityMode: true
    };
  }

  async importSession(sessionState) {
    if (this.creativeFeatures && !this.compatibilityMode) {
      return await this.creativeFeatures.importSession(sessionState);
    }
    // Basic import in compatibility mode
    try {
      if (sessionState.scenes) {
        for (const scene of sessionState.scenes) {
          try {
            sceneStore.addScene(scene);
          } catch (e) {
            console.warn('[ProfessionalIntegration] Failed to import scene:', e.message);
          }
        }
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Emergency fallback - disable all new features
   */
  async emergencyFallback() {
    console.warn('[ProfessionalIntegration] Activating emergency fallback mode');
    
    this.compatibilityMode = true;
    
    // Disable new features
    this.sceneManager = null;
    this.mediaManager = null;
    this.creativeFeatures = null;
    
    // Keep only basic operations
    console.log('[ProfessionalIntegration] Running in basic mode only');
    
    return {
      success: true,
      mode: 'basic'
    };
  }

  /**
   * Health check for system
   */
  async healthCheck() {
    const health = {
      status: 'healthy',
      components: {},
      timestamp: Date.now()
    };

    // Check scene-store
    try {
      sceneStore.listItems();
      health.components.sceneStore = 'healthy';
    } catch (e) {
      health.components.sceneStore = 'unhealthy';
      health.status = 'degraded';
    }

    // Check media-library
    try {
      mediaLibrary.listItems();
      health.components.mediaLibrary = 'healthy';
    } catch (e) {
      health.components.mediaLibrary = 'unhealthy';
      health.status = 'degraded';
    }

    // Check new components if initialized
    if (this.initialized && !this.compatibilityMode) {
      try {
        this.sceneManager.getStatus();
        health.components.sceneManager = 'healthy';
      } catch (e) {
        health.components.sceneManager = 'unhealthy';
        health.status = 'degraded';
      }

      try {
        this.mediaManager.getStatus();
        health.components.mediaManager = 'healthy';
      } catch (e) {
        health.components.mediaManager = 'unhealthy';
        health.status = 'degraded';
      }

      try {
        this.creativeFeatures.getStatus();
        health.components.creativeFeatures = 'healthy';
      } catch (e) {
        health.components.creativeFeatures = 'unhealthy';
        health.status = 'degraded';
      }
    }

    return health;
  }
}

// Singleton instance
let professionalIntegration = null;

/**
 * Get or create the professional integration instance
 */
function getProfessionalIntegration() {
  if (!professionalIntegration) {
    professionalIntegration = new ProfessionalIntegration();
  }
  return professionalIntegration;
}

module.exports = {
  ProfessionalIntegration,
  getProfessionalIntegration
};