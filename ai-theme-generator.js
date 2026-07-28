/**
 * ============================================================================
 * plugin-system.js — Extensible Plugin Architecture for ChurchOverlay
 * ============================================================================
 * Allows third-party extensions without modifying core code.
 * 
 * Plugin types:
 *   - input:     Custom audio sources (YouTube, file, etc.)
 *   - output:    Custom display targets (ProPresenter, vMix, etc.)
 *   - detector:  Custom verse detection algorithms
 *   - theme:     Dynamic theme generators
 *   - ai:        AI-powered features
 * 
 * Usage:
 *   const plugins = new PluginSystem();
 *   plugins.loadFromDirectory('./config/plugins');
 *   plugins.hooks.onTranscript.forEach(h => h(text));
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------
// Hook definitions — plugins can register callbacks here
// -----------------------------------------------------------------------
const HOOKS = [
  'onInit',           // Called once at startup
  'onTranscript',     // Called with every STT transcript
  'onVerseDetected',  // Called when a verse is detected
  'onVerseShown',     // Called when a verse is displayed
  'onVerseHidden',    // Called when overlay is hidden
  'onThemeChange',    // Called when theme changes
  'onLanguageChange', // Called when display language changes
  'onError',          // Called on any pipeline error
  'onShutdown',       // Called before app exits
];

// -----------------------------------------------------------------------
// Plugin System
// -----------------------------------------------------------------------
class PluginSystem {
  constructor() {
    this.plugins = new Map();
    this.hooks = {};
    HOOKS.forEach(h => this.hooks[h] = []);
    this.metadata = {
      loadedAt: Date.now(),
      pluginCount: 0,
    };
  }

  /**
   * Register a plugin
   */
  register(plugin) {
    if (!plugin.name) {
      throw new Error('Plugin must have a name');
    }
    if (this.plugins.has(plugin.name)) {
      console.warn(`[plugin] Plugin "${plugin.name}" already registered, skipping`);
      return false;
    }

    // Validate plugin structure
    if (plugin.hooks) {
      for (const [hookName, handler] of Object.entries(plugin.hooks)) {
        if (!HOOKS.includes(hookName)) {
          console.warn(`[plugin] Unknown hook "${hookName}" in plugin "${plugin.name}"`);
          continue;
        }
        if (typeof handler !== 'function') {
          console.warn(`[plugin] Hook "${hookName}" in "${plugin.name}" is not a function`);
          continue;
        }
        this.hooks[hookName].push({ plugin: plugin.name, handler });
      }
    }

    // Store plugin
    this.plugins.set(plugin.name, {
      ...plugin,
      registeredAt: Date.now(),
      enabled: plugin.enabled !== false,
    });

    this.metadata.pluginCount++;
    console.log(`[plugin] Registered: ${plugin.name} v${plugin.version || '0.0.0'} (${plugin.type || 'generic'})`);

    // Call onInit immediately if provided
    if (plugin.hooks?.onInit) {
      try {
        plugin.hooks.onInit();
      } catch (err) {
        console.error(`[plugin] onInit failed for ${plugin.name}:`, err.message);
      }
    }

    return true;
  }

  /**
   * Unregister a plugin
   */
  unregister(name) {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;

    // Call onShutdown
    if (plugin.hooks?.onShutdown) {
      try { plugin.hooks.onShutdown(); } catch (_) {}
    }

    // Remove all hooks
    for (const hookName of HOOKS) {
      this.hooks[hookName] = this.hooks[hookName].filter(h => h.plugin !== name);
    }

    this.plugins.delete(name);
    this.metadata.pluginCount--;
    console.log(`[plugin] Unregistered: ${name}`);
    return true;
  }

  /**
   * Execute all handlers for a hook
   */
  async emit(hookName, data) {
    const handlers = this.hooks[hookName] || [];
    const results = [];
    for (const { plugin, handler } of handlers) {
      try {
        const result = await handler(data);
        if (result !== undefined) results.push({ plugin, result });
      } catch (err) {
        console.error(`[plugin] Hook "${hookName}" failed in "${plugin}":`, err.message);
      }
    }
    return results;
  }

  /**
   * Load plugins from a directory
   */
  loadFromDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
      console.log(`[plugin] Directory not found: ${dirPath}`);
      return;
    }

    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        // Try loading as a package (index.js or package.json main)
        const indexPath = path.join(fullPath, 'index.js');
        const pkgPath = path.join(fullPath, 'package.json');

        let loadPath = null;
        if (fs.existsSync(indexPath)) {
          loadPath = indexPath;
        } else if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.main) {
            loadPath = path.join(fullPath, pkg.main);
          }
        }

        if (loadPath) {
          try {
            delete require.cache[require.resolve(loadPath)];
            const plugin = require(loadPath);
            this.register(plugin);
          } catch (err) {
            console.error(`[plugin] Failed to load "${entry}":`, err.message);
          }
        }
      } else if (entry.endsWith('.js')) {
        // Single-file plugin
        try {
          delete require.cache[require.resolve(fullPath)];
          const plugin = require(fullPath);
          this.register(plugin);
        } catch (err) {
          console.error(`[plugin] Failed to load "${entry}":`, err.message);
        }
      }
    }
  }

  /**
   * Get plugin info for dashboard
   */
  getPluginList() {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.name,
      version: p.version || '0.0.0',
      type: p.type || 'generic',
      description: p.description || '',
      author: p.author || '',
      enabled: p.enabled,
      hooks: Object.keys(p.hooks || {}),
    }));
  }

  /**
   * Enable/disable a plugin
   */
  setEnabled(name, enabled) {
    const plugin = this.plugins.get(name);
    if (plugin) {
      plugin.enabled = enabled;
      console.log(`[plugin] ${name} ${enabled ? 'enabled' : 'disabled'}`);
    }
  }

  /**
   * Shutdown all plugins gracefully
   */
  async shutdown() {
    await this.emit('onShutdown');
    this.plugins.clear();
    HOOKS.forEach(h => this.hooks[h] = []);
  }
}

// -----------------------------------------------------------------------
// Example Plugin Template (for documentation)
// -----------------------------------------------------------------------
const EXAMPLE_PLUGIN = {
  name: 'example-plugin',
  version: '1.0.0',
  type: 'output',
  description: 'Example plugin showing the structure',
  author: 'Your Name',
  enabled: true,
  hooks: {
    onInit: () => {
      console.log('[example] Plugin initialized');
    },
    onTranscript: (text) => {
      console.log('[example] Transcript:', text);
    },
    onVerseDetected: (verse) => {
      console.log('[example] Verse detected:', verse.reference);
    },
    onVerseShown: (verse) => {
      // Send to external system (ProPresenter, vMix, etc.)
      console.log('[example] Sending to external display:', verse.reference);
    },
    onShutdown: () => {
      console.log('[example] Plugin shutting down');
    },
  },
};

module.exports = { PluginSystem, HOOKS, EXAMPLE_PLUGIN };
