/**
 * ============================================================================
 *  cloud-sync.js — Cloud integration for xtruck
 * ----------------------------------------------------------------------------
 *  Provides cloud backup and sync functionality for sermons, verses, and
 *  analytics data. Supports multiple cloud providers and automatic sync.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

class CloudSyncManager {
  constructor() {
    this.providers = {
      local: {
        name: 'Local Storage',
        enabled: true,
        syncPath: path.join(__dirname, 'cloud-backup')
      },
      // Add other cloud providers here (Google Drive, Dropbox, etc.)
      // For now, we'll implement local file-based sync
    };

    this.currentProvider = 'local';
    this.syncInterval = 5 * 60 * 1000; // 5 minutes
    this.syncTimer = null;
    this.lastSyncTime = null;
    this.syncQueue = [];
    this.isSyncing = false;

    this.initializeProvider();
  }

  /**
   * Initialize the current provider
   */
  initializeProvider() {
    const provider = this.providers[this.currentProvider];
    
    if (this.currentProvider === 'local') {
      if (!fs.existsSync(provider.syncPath)) {
        fs.mkdirSync(provider.syncPath, { recursive: true });
        console.log('[Cloud Sync] Local backup directory created');
      }
    }
    
    console.log(`[Cloud Sync] Initialized with provider: ${provider.name}`);
  }

  /**
   * Set the current cloud provider
   */
  setProvider(providerName) {
    if (this.providers[providerName]) {
      this.currentProvider = providerName;
      this.initializeProvider();
      console.log(`[Cloud Sync] Provider changed to: ${providerName}`);
    } else {
      console.warn(`[Cloud Sync] Provider not found: ${providerName}`);
    }
  }

  /**
   * Start automatic sync
   */
  startAutoSync(intervalMs = null) {
    if (intervalMs) {
      this.syncInterval = intervalMs;
    }
    
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
    }
    
    this.syncTimer = setInterval(() => {
      this.syncAll();
    }, this.syncInterval);
    
    console.log(`[Cloud Sync] Auto-sync started (interval: ${this.syncInterval}ms)`);
  }

  /**
   * Stop automatic sync
   */
  stopAutoSync() {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
      console.log('[Cloud Sync] Auto-sync stopped');
    }
  }

  /**
   * Add item to sync queue
   */
  queueSync(type, data) {
    this.syncQueue.push({
      type,
      data,
      timestamp: Date.now()
    });
    
    console.log(`[Cloud Sync] Item queued for sync: ${type}`);
  }

  /**
   * Sync all queued items
   */
  async syncAll() {
    if (this.isSyncing || this.syncQueue.length === 0) {
      return Promise.resolve();
    }

    this.isSyncing = true;
    console.log('[Cloud Sync] Starting sync...');

    try {
      while (this.syncQueue.length > 0) {
        const item = this.syncQueue.shift();
        await this.syncItem(item);
      }

      this.lastSyncTime = Date.now();
      console.log('[Cloud Sync] Sync completed successfully');
    } catch (error) {
      console.error('[Cloud Sync] Sync failed:', error.message);
    } finally {
      this.isSyncing = false;
    }
    
    return Promise.resolve();
  }

  /**
   * Sync a single item
   */
  async syncItem(item) {
    const provider = this.providers[this.currentProvider];
    
    switch (this.currentProvider) {
      case 'local':
        await this.syncToLocal(item, provider.syncPath);
        break;
      default:
        console.warn(`[Cloud Sync] Sync not implemented for provider: ${this.currentProvider}`);
    }
  }

  /**
   * Sync to local storage
   */
  async syncToLocal(item, syncPath) {
    const timestamp = new Date(item.timestamp).toISOString().split('T')[0];
    const filename = `${item.type}_${timestamp}.json`;
    const filepath = path.join(syncPath, filename);
    
    const data = {
      ...item,
      syncedAt: Date.now(),
      provider: this.currentProvider
    };
    
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
    console.log(`[Cloud Sync] Synced ${item.type} to local: ${filename}`);
  }

  /**
   * Backup sermon data
   */
  async backupSermon(sermonData) {
    const backupData = {
      type: 'sermon',
      data: sermonData,
      timestamp: Date.now()
    };
    
    this.queueSync('sermon', backupData);
    return this.syncAll();
  }

  /**
   * Backup verse display
   */
  async backupVerse(verseData) {
    const backupData = {
      type: 'verse',
      data: verseData,
      timestamp: Date.now()
    };
    
    this.queueSync('verse', backupData);
    return this.syncAll();
  }

  /**
   * Backup analytics data
   */
  async backupAnalytics(analyticsData) {
    const backupData = {
      type: 'analytics',
      data: analyticsData,
      timestamp: Date.now()
    };
    
    this.queueSync('analytics', backupData);
    return this.syncAll();
  }

  /**
   * Get sync status
   */
  getSyncStatus() {
    return {
      provider: this.currentProvider,
      providerName: this.providers[this.currentProvider].name,
      isSyncing: this.isSyncing,
      lastSyncTime: this.lastSyncTime,
      queueSize: this.syncQueue.length,
      autoSyncEnabled: this.syncTimer !== null,
      syncInterval: this.syncInterval
    };
  }

  /**
   * Get backed up data
   */
  async getBackups(type = null) {
    const provider = this.providers[this.currentProvider];
    
    if (this.currentProvider !== 'local') {
      return [];
    }

    if (!fs.existsSync(provider.syncPath)) {
      return [];
    }

    const files = fs.readdirSync(provider.syncPath);
    const backups = [];

    files.forEach(file => {
      if (file.endsWith('.json')) {
        const filepath = path.join(provider.syncPath, file);
        const content = JSON.parse(fs.readFileSync(filepath, 'utf8'));
        
        if (!type || content.type === type) {
          backups.push(content);
        }
      }
    });

    return backups.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Restore from backup
   */
  async restoreFromBackup(backupId) {
    const backups = await this.getBackups();
    const backup = backups.find(b => b.timestamp === backupId);
    
    if (!backup) {
      throw new Error('Backup not found');
    }

    console.log(`[Cloud Sync] Restoring from backup: ${backup.type}`);
    return backup.data;
  }

  /**
   * Delete old backups
   */
  async cleanupOldBackups(daysToKeep = 30) {
    const provider = this.providers[this.currentProvider];
    
    if (this.currentProvider !== 'local') {
      return;
    }

    if (!fs.existsSync(provider.syncPath)) {
      return;
    }

    const files = fs.readdirSync(provider.syncPath);
    const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    let deletedCount = 0;

    files.forEach(file => {
      if (file.endsWith('.json')) {
        const filepath = path.join(provider.syncPath, file);
        const stats = fs.statSync(filepath);
        
        if (stats.mtimeMs < cutoffTime) {
          fs.unlinkSync(filepath);
          deletedCount++;
        }
      }
    });

    console.log(`[Cloud Sync] Cleaned up ${deletedCount} old backups`);
    return deletedCount;
  }

  /**
   * Export all data
   */
  async exportAllData() {
    const backups = await this.getBackups();
    
    return {
      exportDate: Date.now(),
      provider: this.currentProvider,
      totalBackups: backups.length,
      data: backups
    };
  }

  /**
   * Import data
   */
  async importData(importData) {
    if (!importData.data || !Array.isArray(importData.data)) {
      throw new Error('Invalid import data format');
    }

    let importedCount = 0;
    
    for (const item of importData.data) {
      this.queueSync(item.type, item);
      importedCount++;
    }

    await this.syncAll();
    console.log(`[Cloud Sync] Imported ${importedCount} items`);
    
    return importedCount;
  }
}

// Create singleton instance
const cloudSync = new CloudSyncManager();

module.exports = {
  CloudSyncManager,
  setProvider: (name) => cloudSync.setProvider(name),
  startAutoSync: (interval) => cloudSync.startAutoSync(interval),
  stopAutoSync: () => cloudSync.stopAutoSync(),
  queueSync: (type, data) => cloudSync.queueSync(type, data),
  syncAll: () => cloudSync.syncAll(),
  backupSermon: (data) => cloudSync.backupSermon(data),
  backupVerse: (data) => cloudSync.backupVerse(data),
  backupAnalytics: (data) => cloudSync.backupAnalytics(data),
  getSyncStatus: () => cloudSync.getSyncStatus(),
  getBackups: (type) => cloudSync.getBackups(type),
  restoreFromBackup: (id) => cloudSync.restoreFromBackup(id),
  cleanupOldBackups: (days) => cloudSync.cleanupOldBackups(days),
  exportAllData: () => cloudSync.exportAllData(),
  importData: (data) => cloudSync.importData(data)
};