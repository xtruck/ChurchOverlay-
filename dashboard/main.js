/**
 * dashboard/main.js — point d'entrée du tableau de bord (chargé via
 * <script type="module"> dans dashboard.html).
 *
 * dashboard.js (le fichier monolithique d'origine) a été entièrement
 * démantelé en modules dédiés sous dashboard/ et dashboard/features/ (voir
 * git log pour l'historique du chantier de modularisation). state.js
 * importé en premier pour préserver l'ordre d'exécution d'origine (il
 * initie la connexion WebSocket et l'auto-détection du mode de culte) ;
 * ws-dispatch.js est déjà chargé indirectement (state.js l'importe pour
 * handleMessage) mais n'est importé nulle part d'autre — pas besoin de le
 * lister ici aussi (un module ES ne s'évalue qu'une fois, peu importe par
 * combien de chemins il est importé). Les modules dashboard/features/*.js
 * ci-dessous sont chacun des IIFE auto-suffisantes (gardées par des
 * vérifications DOM, document déjà entièrement parsé au moment où un
 * <script type="module"> s'exécute), donc leur ordre relatif entre elles
 * n'a pas d'importance.
 */
import './state.js';
import './utils.js';
import './features/api-settings.js';
import './features/camera-panel.js';
import './features/ui-effects.js';
import './features/perf-pill.js';
import './features/confidence-mode.js';
import './features/command-palette.js';
import './features/training-mode.js';
import './features/startup-wizard.js';
import './features/companion-link.js';
// AJOUT (lot 6) : mood-theme.js/song-library.js/offline-bible.js sont déjà
// chargés indirectement (legacy-core.js les importe pour renderMoodPicker/
// setActiveMoodButton/renderSongLibrary/renderOfflineBibleStatus) — pas
// besoin de les lister ici aussi (un module ES ne s'évalue qu'une fois,
// peu importe par combien de chemins il est importé). verse-queue.js, lui,
// n'est importé par personne d'autre : sans cette ligne, son
// renderQueue() initial et ses window.x ne s'exécuteraient jamais.
import './features/verse-queue.js';
// AJOUT (lot 7) : preservice-ai.js est déjà chargé indirectement (legacy-core.js
// l'importe pour renderAiEnricherOutput/renderSessionStats/etc.).
// propresenter-planning-center.js, comme verse-queue.js, n'est importé par
// personne d'autre : sans cette ligne, ses appels loadProPresenterConfig()/
// loadPlanningCenterConfig() au chargement et ses window.x ne
// s'exécuteraient jamais.
import './features/propresenter-planning-center.js';
// AJOUT : obs-scenes.js, comme propresenter-planning-center.js et
// verse-queue.js, n'est importé par personne d'autre — sans cette ligne,
// son loadObsConfig() initial et ses window.x ne s'exécuteraient jamais.
import './features/obs-scenes.js';
import './features/agent.js';
// AJOUT : ProPresenter 7 style studio workspace
import './features/propresenter-studio.js';
// AJOUT (phase 3, point 2 — plus aucun onclick inline dans dashboard.html) :
// câblage des 153 écouteurs de clic, DÉLIBÉRÉMENT EN DERNIER. Le module ne
// fait que des addEventListener sur des id déjà présents dans le document
// (un <script type="module"> est différé, le DOM est donc complet), et il
// résout les fonctions via window au moment du clic — il n'ajoute aucune
// arête d'import et ne peut donc pas déplacer l'ordre d'évaluation des
// features ci-dessus.
import './event-bindings.js';
