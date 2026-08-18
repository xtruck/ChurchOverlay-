// test/e2e/companion-checkin.spec.js — couvre le chantier 4.6 (présence
// anonyme via companion.html) : un seul POST /api/checkin par onglet, même
// après plusieurs cycles de sondage (POLL_MS), et pas de nouveau POST après
// un rechargement dans le MÊME onglet (sessionStorage).
'use strict';
const { test, expect } = require('./fixtures');

test.describe('Présence anonyme (companion.html)', () => {
  test('POST /api/checkin envoyé une seule fois par session de navigateur', async ({ page }) => {
    const checkinRequests = [];
    page.on('request', (req) => {
      if (req.url().endsWith('/api/checkin') && req.method() === 'POST') {
        checkinRequests.push(req);
      }
    });

    await page.goto('/companion');
    await expect.poll(() => checkinRequests.length, { timeout: 3000 }).toBe(1);

    // Laisse largement passer un cycle de sondage complet (4000ms) --
    // aucun second POST ne doit partir.
    await page.waitForTimeout(4500);
    expect(checkinRequests.length).toBe(1);

    // Rechargement dans le MÊME onglet : sessionStorage survit, pas de
    // nouveau POST.
    await page.reload();
    await page.waitForTimeout(500);
    expect(checkinRequests.length).toBe(1);
  });
});
