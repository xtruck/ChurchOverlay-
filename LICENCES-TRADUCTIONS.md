# Licences des traductions bibliques

ChurchOverlay est un logiciel **commercial** (vendu à des églises, conférences,
expositions). Une traduction biblique intégrée sans les droits nécessaires
serait un vrai risque juridique pour ChurchOverlay et pour chaque église qui
l'utilise — ce document existe pour que ce risque reste toujours visible et
jamais tranché à la légère.

**Ce document n'est pas un avis juridique.** Il documente l'état constaté du
code et des fournisseurs de données utilisés (`bible-lookup-with-api.js`) et
signale les décisions qui nécessitent une vérification par un juriste avant
toute mise en production commerciale à grande échelle. Voir la mission
maître (§3, verrou dur n°4) : les questions juridiques se documentent, elles
ne se tranchent pas depuis ce dépôt.

## Traductions actuellement intégrées

Toutes proviennent de `bible.helloao.org` et/ou `getbible.net`, deux services
qui ne servent QUE des traductions du domaine public (voir leur propre
documentation). Vérifié par lecture du code (`AVAILABLE_TRANSLATIONS` dans
`bible-lookup-with-api.js`) le 2026-08-16 :

| Code    | Traduction                    | Langue | Licence        | Fournisseur(s)     |
| ------- | ----------------------------- | ------ | -------------- | ------------------ |
| `lsg`   | Louis Segond 1910             | FR     | Domaine public | helloao, getbible  |
| `darby` | Darby (révision 2024)         | FR     | Domaine public | getbible seulement |
| `kjv`   | King James Version            | EN     | Domaine public | helloao seulement  |
| `web`   | World English Bible (moderne) | EN     | Domaine public | helloao seulement  |
| `asv`   | American Standard Version     | EN     | Domaine public | helloao seulement  |

Le domaine public de ces cinq traductions est un fait largement établi et
documenté publiquement (œuvres anciennes, droits expirés) — mais **aucune
vérification formelle par un juriste n'a été faite dans le cadre de ce
dépôt**. À faire avant toute vente à grande échelle, pas seulement supposé.

La mention de licence de la traduction ACTIVE est affichée automatiquement
dans le tableau de bord (`dashboard/features/translation-picker.js`,
`AVAILABLE_TRANSLATIONS[...].license`) — jamais laissée à la mémoire de
l'opérateur, et mise à jour en temps réel si la traduction change en cours
de culte (voix ou tableau de bord).

## Traductions explicitement EXCLUES (licence commerciale requise)

D'après la mission maître (§6) — **aucune ne doit être ajoutée à ce dépôt
sans licence commerciale vérifiée et payée** :

- **NIV** (New International Version) — Biblica/Zondervan
- **ESV** (English Standard Version) — Crossway
- **NLT** (New Living Translation) — Tyndale House
- **NASB** (New American Standard Bible) — The Lockman Foundation
- **Segond 21** — Société Biblique de Genève

Toutes les quatre premières (anglaises) et la Segond 21 sont sous droits
actifs — leur texte n'est disponible dans AUCUN fournisseur actuellement
intégré (`helloao`, `getbible`), donc aucun risque d'intégration accidentelle
aujourd'hui. Le risque serait qu'un futur développeur ajoute un fournisseur
tiers qui, lui, les distribue sans vérifier leurs propres conditions
d'utilisation en amont.

## Architecture — ajouter une traduction sous licence plus tard

`AVAILABLE_TRANSLATIONS` (`bible-lookup-with-api.js`) est déjà structuré
pour ça : chaque traduction est une entrée indépendante avec son propre
`code` logique, son (ou ses) identifiant(s) de fournisseur, un `label`
d'affichage et un `license`. `fetchFromProvider()` essaie chaque fournisseur
dans l'ordre pour un `code` donné — un fournisseur qui ne sert pas cette
traduction échoue proprement (id absent) et laisse le suivant prendre le
relais.

Pour ajouter une traduction sous licence (une fois la licence obtenue) :

1. Ajouter une entrée dans `AVAILABLE_TRANSLATIONS[lang]` avec le `code`
   choisi, l'id du fournisseur qui la sert légalement (API sous licence
   dédiée — **jamais** `helloao`/`getbible`, qui ne servent que du domaine
   public), et `license: '<nom de la licence obtenue>'`.
2. Le tableau de bord (`translation-picker.js`) affiche automatiquement le
   nouveau bouton ET sa mention de licence — aucune modification requise
   côté UI.
3. Documenter la licence obtenue dans ce fichier (tableau ci-dessus).

Aucune modification du cœur de détection/affichage n'est nécessaire — c'est
la garantie que l'ajout d'une traduction sous licence, une fois les droits
obtenus, est un changement de configuration, pas un chantier de code.

## Licence du dépôt lui-même

Distincte des licences de traduction ci-dessus. Le dépôt est actuellement
sous licence **MIT** (voir `LICENSE`), ce qui autorise légalement n'importe
qui à redistribuer ou revendre ce code. C'est un sujet séparé, documenté
dans la mission maître (§10, Chantier G) — verrou dur n°4, à trancher avec
un juriste, pas depuis ce dépôt.
