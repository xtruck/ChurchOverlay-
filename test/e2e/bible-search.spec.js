// test/e2e/bible-search.spec.js — couvre la recherche de versets par
// thème (nouvelle fonctionnalité, voir dashboard/features/bible-search.js)
// bout-en-bout : chargement des thèmes à la connexion, clic sur un
// thème, résultats, et le bouton "afficher maintenant" qui déclenche
// réellement l'affichage du verset.
'use strict';
const { test, expect } = require('./fixtures');

test.describe('Recherche de versets par thème', () => {
  test('les thèmes se chargent à la connexion, une recherche renvoie des résultats affichables', async ({
    page,
  }) => {
    await page.goto('/');

    // Bascule vers "Réglages" -> #analysis (où vit la carte de recherche).
    await page.locator('.sidebar .nav-item[data-sections="analysis,studio,media-wall"]').click();

    const topicChips = page.locator('#bibleTopicChips .mood-btn');
    await expect(topicChips.first()).toBeVisible({ timeout: 5000 });

    // "amour" fait partie du TOPIC_INDEX fixe côté serveur (voir
    // bible-semantic-search.js) — cliquable directement.
    await page.locator('#bibleTopicChips .mood-btn', { hasText: 'amour' }).click();

    const results = page.locator('#bibleSearchOutput .queue-item');
    await expect(results.first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#bibleSearchOutput')).toContainText('Jean 3:16');

    // Cliquer "afficher maintenant" sur le premier résultat déclenche un
    // vrai showVerse — vérifié via la carte verset en direct (voir aussi
    // hero-live-state.spec.js pour la couverture de .is-live elle-même).
    await results.first().locator('.queue-send').click();
    await expect(page.locator('#verseDisplay')).toHaveClass(/is-live/, { timeout: 5000 });
  });
});
