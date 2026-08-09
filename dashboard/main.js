/**
 * dashboard/main.js — point d'entrée du tableau de bord (chargé via
 * <script type="module"> dans dashboard.html).
 *
 * Pour l'instant, importe simplement legacy-core.js (l'ancien dashboard.js
 * déplacé tel quel — voir son en-tête pour le détail de la transition). Les
 * lots suivants du chantier de modularisation feront de ce fichier le vrai
 * point de câblage : import de chaque module dashboard/features/*.js et
 * appel de leurs fonctions d'initialisation, à mesure que legacy-core.js
 * est démantelé.
 */
import './legacy-core.js';
