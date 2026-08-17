# LICENCES-TRADUCTIONS — Politique de traduction pour ChurchOverlay

> Document créé 2026-08-17. Politique : **uniquement des traductions libres de droits** pour le
> logiciel commercial. Les traductions sous copyright (NIV, ESV, NLT, NASB, Segond21, Le Semeur)
> sont exclues de la distribution.

## Traductions distribuées

| Code | Nom complet | Langue | Licence | Source API |
|------|-------------|--------|---------|------------|
| `lsg` | Louis Segond 1910 | FR | Domaine public | helloao + getbible |
| `darby` | Darby | FR | Domaine public | getbible |
| `kjv` | King James Version | EN | Domaine public | helloao |
| `web` | World English Bible | EN | Domaine public (CC0) | helloao |
| `asv` | American Standard Version | EN | Domaine public | helloao |

## Traductions **exclues** (copyright, sans licence payante)

| Nom | Raison d'exclusion |
|-----|-------------------|
| NIV (New International Version) | Biblica/Zondervan — licence commerciale requise |
| ESV (English Standard Version) | Crossway — licence commerciale requise |
| NLT (New Living Translation) | Tyndale House — licence commerciale requise |
| NASB (New American Standard Bible) | Lockman Foundation — licence commerciale requise |
| Segond 21 | Société biblique de Genève — licence requise |
| Le Semeur | Alliance biblique française — licence requise |

## Architecture de traductions extensible

La structure `AVAILABLE_TRANSLATIONS` dans `bible-lookup-with-api.js` (lignes 500-535) permet
d'ajouter une traduction sous licence payante sans toucher au cœur du logiciel :

```js
AVAILABLE_TRANSLATIONS = {
  fr: {
    lsg: { helloaoId: 'fra_lsg', getbibleId: 'ls1910', label: 'Louis Segond 1910', license: 'Domaine public' },
    darby: { helloaoId: null, getbibleId: 'darby', label: 'Darby', license: 'Domaine public' },
    // Ajout futur : segond21: { ..., license: 'Société biblique de Genève (payante)' }
  },
  en: {
    kjv: { helloaoId: 'eng_kjv', label: 'King James Version', license: 'Domaine public' },
    web: { helloaoId: 'eng_web', label: 'World English Bible', license: 'Domaine public' },
    asv: { helloaoId: 'eng_asv', label: 'American Standard Version', license: 'Domaine public' },
    // Ajout futur : niv: { ..., license: 'Biblica (payante)' }
  }
};
```

### Principe d'ajout d'une traduction sous licence

1. La traduction est activable par licence (clé API ou token, via `safeStorage`)
2. La mention de copyright est affichée automatiquement dans l'interface
3. Le logiciel fonctionne parfaitement sans elle (les 5 traductions libres couvrent le besoin)
4. L'ajout ne touche jamais aux traductions libres existantes

## Points juridiques

- **Aucune traduction sous copyright n'est distribuée** avec le logiciel
- **Aucune clé API payante** n'est requise pour le fonctionnement de base
- La recherche biblique utilise des API gratuites (helloao, getbible) qui servent des traductions
  de domaine public
- Les API tiers peuvent changer leurs conditions — le repli hors-ligne (`bible-offline-cache.js`)
  télécharge et persiste les textes pour une utilisation sans connexion
