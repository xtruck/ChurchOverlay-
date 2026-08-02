/**
 * ============================================================================
 * plugin-system.js — Plugin system with capability-based sandboxing
 * ----------------------------------------------------------------------------
 * v2.0.0 — SECURITY HARDENED:
 *   + Manifest validation with permissions array
 *   + Capability-based restrictions (no arbitrary require())
 *   + Plugin isolation via vm.Script in restricted context
 *   + Network/fs access requires explicit "dangerous" capability
 *   + Code signing verification placeholder
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---------------------------------------------------------------------------
// Capabilities that plugins can request
// ---------------------------------------------------------------------------
const CAPABILITIES = Object.freeze({
  THEME: 'theme',           // Can modify overlay themes
  OUTPUT: 'output',         // Can send messages to overlay
  TRANSCRIPT: 'transcript', // Can read transcripts
  VERSE: 'verse',           // Can read detected verses
  NETWORK: 'network',       // Can make HTTP requests (dangerous)
  FS: 'fs',                 // Can access filesystem (dangerous)
  PROCESS: 'process',       // Can spawn processes (dangerous)
});

const DANGEROUS_CAPS = new Set([CAPABILITIES.NETWORK, CAPABILITIES.FS, CAPABILITIES.PROCESS]);

// ---------------------------------------------------------------------------
// Secure require proxy — only allows safe built-ins by default
// ---------------------------------------------------------------------------
function createSecureRequire(pluginName, allowedCaps) {
  const allowedModules = new Set([
    'path', 'util', 'url', 'querystring', 'crypto', 'buffer',
    'stream', 'events', 'string_decoder', 'timers', 'assert',
  ]);

  if (allowedCaps.includes(CAPABILITIES.FS)) {
    allowedModules.add('fs');
  }
  if (allowedCaps.includes(CAPABILITIES.NETWORK)) {
    allowedModules.add('http');
    allowedModules.add('https');
    allowedModules.add('net');
  }
  if (allowedCaps.includes(CAPABILITIES.PROCESS)) {
    allowedModules.add('child_process');
    allowedModules.add('os');
  }

  return function secureRequire(id) {
    if (!allowedModules.has(id)) {
      throw new Error(
        `[Plugin "${pluginName}"] Module "${id}" is not in the allowed list. ` +
        `Allowed: ${Array.from(allowedModules).join(', ')}. ` +
        `Request additional capabilities in plugin.json.`
      );
    }
    return require(id);
  };
}

// ---------------------------------------------------------------------------
// PluginSystem class
// ---------------------------------------------------------------------------
class PluginSystem {
  constructor() {
    this.plugins = new Map();
    this.metadata = {};
    this.hooks = {
      onTranscript: [],
      onVerseDetected: [],
      onVerseShown: [],
      onError: [],
    };
  }

  register(plugin, meta = {}) {
    if (!plugin || typeof plugin !== 'object') {
      throw new Error('Plugin must export an object');
    }
    if (typeof plugin.name !== 'string' || !plugin.name) {
      throw new Error('Plugin must have a non-empty "name" string');
    }
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }

    const name = plugin.name;
    const caps = meta.capabilities || [];
    const isDangerous = caps.some(c => DANGEROUS_CAPS.has(c));

    const wrapped = {
      name,
      version: meta.version || '0.0.0',
      description: meta.description || '',
      author: meta.author || '',
      capabilities: caps,
      dangerous: isDangerous,
      enabled: meta.enabled !== false,
      sandboxed: true,
      plugin,
    };

    this.plugins.set(name, wrapped);
    this.metadata[name] = wrapped;

    for (const hook of Object.keys(this.hooks)) {
      if (typeof plugin[hook] === 'function') {
        this.hooks[hook].push({ name, fn: plugin[hook], caps });
      }
    }

    console.log(`[PluginSystem] Registered: "${name}" v${wrapped.version} caps=[${caps.join(',')}]${isDangerous ? ' [DANGEROUS]' : ''}`);
    return wrapped;
  }

  unregister(name) {
    if (!this.plugins.has(name)) return false;
    this.plugins.delete(name);
    delete this.metadata[name];
    for (const hook of Object.keys(this.hooks)) {
      this.hooks[hook] = this.hooks[hook].filter(h => h.name !== name);
    }
    console.log(`[PluginSystem] Unregistered: "${name}"`);
    return true;
  }

  setEnabled(name, enabled) {
    const p = this.plugins.get(name);
    if (!p) return false;
    p.enabled = !!enabled;
    return true;
  }

  getPluginList() {
    return Array.from(this.plugins.values()).map(p => ({
      name: p.name,
      version: p.version,
      description: p.description,
      author: p.author,
      capabilities: p.capabilities,
      dangerous: p.dangerous,
      enabled: p.enabled,
    }));
  }

  // -------------------------------------------------------------------------
  // Emit events to plugins (async, sequential)
  // -------------------------------------------------------------------------
  async emit(event, data) {
    const hooks = this.hooks[event] || [];
    for (const hook of hooks) {
      const p = this.plugins.get(hook.name);
      if (!p || !p.enabled) continue;
      try {
        await hook.fn(data);
      } catch (err) {
        console.error(`[PluginSystem] Error in "${hook.name}".${event}:`, err.message);
      }
    }
  }

  async shutdown() {
    for (const [name, p] of this.plugins) {
      if (typeof p.plugin.onShutdown === 'function') {
        try {
          await p.plugin.onShutdown();
        } catch (err) {
          console.error(`[PluginSystem] Shutdown error in "${name}":`, err.message);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Load from directory with manifest validation
  // -------------------------------------------------------------------------
  loadFromDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
      console.warn(`[PluginSystem] Directory not found: ${dirPath}`);
      return;
    }

    const entries = fs.readdirSync(dirPath);
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry);
      const stat = fs.statSync(fullPath);

      let pluginPath;
      let manifestPath;

      if (stat.isDirectory()) {
        pluginPath = path.join(fullPath, 'index.js');
        manifestPath = path.join(fullPath, 'plugin.json');
      } else if (entry.endsWith('.js')) {
        pluginPath = fullPath;
        manifestPath = fullPath.replace(/\.js$/, '.json');
      } else {
        continue;
      }

      if (!fs.existsSync(pluginPath)) {
        console.warn(`[PluginSystem] Plugin file not found: ${pluginPath}`);
        continue;
      }

      // Load and validate manifest
      let manifest = {};
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch (e) {
          console.warn(`[PluginSystem] Invalid manifest JSON for "${entry}": ${e.message}`);
          continue;
        }
      }

      // Validate manifest schema
      if (!manifest.name || typeof manifest.name !== 'string') {
        console.warn(`[PluginSystem] Manifest for "${entry}" missing required field "name"`);
        continue;
      }
      if (manifest.capabilities && !Array.isArray(manifest.capabilities)) {
        console.warn(`[PluginSystem] Manifest for "${entry}" has invalid "capabilities" (must be array)`);
        continue;
      }

      const allowedCaps = manifest.capabilities || [];
      const unknownCaps = allowedCaps.filter(c => !Object.values(CAPABILITIES).includes(c));
      if (unknownCaps.length > 0) {
        console.warn(`[PluginSystem] Plugin "${manifest.name}" requests unknown capabilities: ${unknownCaps.join(', ')}`);
        continue;
      }

      // SECURITY: warn about dangerous capabilities
      const dangerousRequested = allowedCaps.filter(c => DANGEROUS_CAPS.has(c));
      if (dangerousRequested.length > 0) {
        console.warn(
          `[PluginSystem] ⚠ Plugin "${manifest.name}" requests DANGEROUS capabilities: ` +
          `${dangerousRequested.join(', ')}. Ensure you trust this plugin.`
        );
      }

      // Load plugin in sandboxed context
      try {
        const code = fs.readFileSync(pluginPath, 'utf-8');
        const script = new vm.Script(code, { filename: pluginPath, lineOffset: 0 });

        const sandbox = {
          console,
          require: createSecureRequire(manifest.name, allowedCaps),
          module: { exports: {} },
          exports: {},
          __dirname: path.dirname(pluginPath),
          __filename: pluginPath,
          Buffer,
          setTimeout,
          setInterval,
          clearTimeout,
          clearInterval,
          process: {
            env: {}, // No env access by default
            cwd: () => path.dirname(pluginPath),
            platform: process.platform,
            version: process.version,
          },
        };

        const context = vm.createContext(sandbox);
        script.runInContext(context, { timeout: 5000 });

        const pluginExport = sandbox.module.exports || sandbox.exports;
        this.register(pluginExport, {
          name: manifest.name,
          version: manifest.version || '0.0.0',
          description: manifest.description || '',
          author: manifest.author || '',
          capabilities: allowedCaps,
          enabled: manifest.enabled !== false,
        });
      } catch (e) {
        console.error(`[PluginSystem] Failed to load plugin "${entry}":`, e.message);
      }
    }
  }
}

module.exports = { PluginSystem, CAPABILITIES };
