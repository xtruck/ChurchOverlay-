/**
 * dashboard/main.js — point d'entrée du tableau de bord (chargé via
 * <script type="module"> dans dashboard.html).
 *
 * legacy-core.js (l'ancien dashboard.js, encore en grande partie non
 * démantelé) importé en premier pour préserver l'ordre d'exécution relatif
 * de ce qu'il lui reste — les modules dashboard/features/*.js ci-dessous
 * sont chacun des IIFE auto-suffisantes (gardées par des vérifications DOM,
 * document déjà entièrement parsé au moment où un <script type="module">
 * s'exécute), donc leur ordre relatif entre elles n'a pas d'importance.
 */
import './legacy-core.js';
import './utils.js';
import './features/api-settings.js';
import './features/camera-panel.js';
import './features/ui-effects.js';
import './features/perf-pill.js';
import './features/companion-link.js';
