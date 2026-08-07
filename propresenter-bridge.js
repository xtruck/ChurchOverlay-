/**
 * ============================================================================
 * ProPresenter Bridge Plugin for ChurchOverlay
 * ============================================================================
 * Automatically sends detected Bible verses to ProPresenter 7+ via its
 * REST API (port 50000 by default).
 *
 * Installation: Copy to config/plugins/propresenter-bridge.js
 * Configuration: Edit the CONFIG object below
 * ============================================================================
 */

'use strict';

const CONFIG = {
  // ProPresenter API endpoint
  BASE_URL: 'http://localhost:50000',
  // API version (v1 for ProPresenter 7.4+)
  API_VERSION: 'v1',
  // Target presentation name (or null for active presentation)
  TARGET_PRESENTATION: 'Bible Verses',
  // Target slide index (or null to append)
  TARGET_SLIDE: null,
  // Auto-trigger slide?
  AUTO_TRIGGER: true,
  // Timeout for API calls (ms)
  TIMEOUT: 3000,
};

// Simple fetch with timeout
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.TIMEOUT);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// Send verse to ProPresenter
async function sendToProPresenter(verse) {
  try {
    // Method 1: Send as message (appears in Messages window)
    const messageResponse = await fetchWithTimeout(
      `${CONFIG.BASE_URL}/${CONFIG.API_VERSION}/message`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `${verse.reference}
${verse.text}`,
          theme: 'Default',
        }),
      }
    );

    if (!messageResponse.ok) {
      throw new Error(`HTTP ${messageResponse.status}`);
    }

    console.log(`[pro-presenter] Sent: ${verse.reference}`);
    return true;
  } catch (err) {
    console.warn('[pro-presenter] Failed to send:', err.message);
    return false;
  }
}

// Plugin export
module.exports = {
  name: 'pro-presenter-bridge',
  version: '1.0.0',
  type: 'output',
  description: 'Sends Bible verses to ProPresenter 7+',
  author: 'ChurchOverlay Team',
  enabled: true,

  hooks: {
    onInit: () => {
      console.log('[pro-presenter] Bridge initialized');
      console.log('[pro-presenter] Target:', CONFIG.BASE_URL);
    },

    onVerseShown: async (verse) => {
      await sendToProPresenter(verse);
    },

    onError: (error) => {
      console.error('[pro-presenter] Pipeline error:', error.message);
    },

    onShutdown: () => {
      console.log('[pro-presenter] Bridge shutting down');
    },
  },
};
