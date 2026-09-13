'use strict';
/**
 * ============================================================================
 *  a2ui-parser.js — Generative UI déclarative (A2UI), côté client
 * ----------------------------------------------------------------------------
 *  AJOUT (chantier durcissement v1.0 — Generative UI). Certaines réponses du
 *  LLM (assistant Q&R sur les prédications, sermon-qa.js ; futur sondage de
 *  sermon) peuvent vouloir proposer une interface plutôt qu'un simple texte —
 *  une carte d'information, un petit formulaire de sondage ("Cette
 *  prédication vous a-t-elle été utile ?"). Le LLM ne génère donc PAS du
 *  HTML : il génère un ARBRE JSON DÉCLARATIF, validé ici contre un catalogue
 *  FERMÉ de composants avant tout rendu — jamais de innerHTML, jamais de
 *  <script>/<style>/balise arbitraire, jamais de valeur exécutée comme du
 *  code. Même philosophie de défense que prompt-sanitizer.js (neutraliser
 *  une source non fiable — ici, la sortie du LLM plutôt que la parole
 *  captée) et que la note de test-validation.js : "overlay.html affiche
 *  tout via textContent, qui neutralise" — ce module applique la même règle
 *  au rendu généré par IA.
 *
 *  CATALOGUE FERMÉ (les 5 seuls types acceptés, voir cahier des charges) :
 *    Card          - conteneur (titre optionnel + enfants)
 *    TextLabel     - texte simple
 *    Button        - action déclarative (label + identifiant d'action opaque
 *                    — jamais exécuté par ce module : à l'hôte de router
 *                    `action` vers sa propre table de gestionnaires connus,
 *                    exactement comme action-registry.js pour les commandes
 *                    WS — ce module ne fait qu'accepter/refuser la FORME)
 *    TextInput     - champ de saisie (nom + valeur/placeholder)
 *    ProgressGauge - jauge numérique (valeur/max/étiquette)
 *  Tout autre `type` (y compris "Html", "Script", "Iframe"...) fait échouer
 *  la validation du nœud ET DE TOUT L'ARBRE — rejet strict, pas de repli
 *  partiel qui afficherait "ce qu'on a pu comprendre" d'une charge utile
 *  suspecte.
 *
 *  parseA2UI()  : pur, aucune dépendance au DOM — utilisable en Node (voir
 *                 test/test-a2ui-parser.js) et dans le navigateur.
 *  renderA2UI() : seule fonction qui touche le DOM — n'utilise jamais
 *                 innerHTML/outerHTML, uniquement createElement + textContent
 *                 (donc aucune chaîne, même passée la validation ci-dessus,
 *                 ne peut être interprétée comme balise/JS par le navigateur
 *                 — défense en profondeur, pas une confiance aveugle en
 *                 parseA2UI()). Non disponible/no-op hors navigateur.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Catalogue fermé : type -> { props autorisées + validateur, children? }
// ---------------------------------------------------------------------------

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPlainString(v) {
  return typeof v === 'string';
}

const CATALOG = {
  Card: {
    allowsChildren: true,
    props: {
      title: { required: false, validate: isPlainString },
      subtitle: { required: false, validate: isPlainString },
    },
  },
  TextLabel: {
    allowsChildren: false,
    props: {
      text: { required: true, validate: isPlainString },
      variant: { required: false, validate: (v) => ['body', 'muted', 'heading'].includes(v) },
    },
  },
  Button: {
    allowsChildren: false,
    props: {
      label: { required: true, validate: isPlainString },
      // Identifiant OPAQUE — jamais eval()/new Function() : à l'hôte de le
      // comparer à une liste connue avant d'agir (voir en-tête de fichier).
      action: { required: true, validate: isPlainString },
      style: {
        required: false,
        validate: (v) => ['primary', 'secondary', 'danger'].includes(v),
      },
    },
  },
  TextInput: {
    allowsChildren: false,
    props: {
      name: { required: true, validate: isPlainString },
      placeholder: { required: false, validate: isPlainString },
      value: { required: false, validate: isPlainString },
      inputType: { required: false, validate: (v) => ['text', 'number'].includes(v) },
    },
  },
  ProgressGauge: {
    allowsChildren: false,
    props: {
      value: { required: true, validate: isFiniteNumber },
      max: { required: false, validate: isFiniteNumber },
      label: { required: false, validate: isPlainString },
    },
  },
};

const ALLOWED_TYPES = Object.keys(CATALOG);

// Limites défensives — une sortie LLM malformée/hostile ne doit jamais
// produire un arbre arbitrairement grand ou profond avant d'être rejetée.
const MAX_DEPTH = 8;
const MAX_NODES = 200;

// Détecte tout ce qui ressemble à du HTML/JS injecté dans une valeur de
// prop censée être du texte affiché — défense en profondeur : renderA2UI()
// n'utilise jamais innerHTML, mais un composant en amont (aperçu Studio,
// export, futur canal de rendu) pourrait un jour être moins prudent, donc
// la charge utile est refusée à la source plutôt que de compter uniquement
// sur le rendu pour neutraliser.
const HTML_LIKE_PATTERN = /<\s*\/?\s*[a-z!][\s\S]*>|javascript:|on[a-z]+\s*=/i;

/**
 * @param {*} value
 * @returns {string|null} message d'erreur si `value` contient du HTML/JS,
 *   sinon null.
 */
function findHtmlInjection(value, pathLabel) {
  if (typeof value !== 'string') return null;
  return HTML_LIKE_PATTERN.test(value)
    ? `${pathLabel} contient une balise/du code non autorisé : ${JSON.stringify(value.slice(0, 80))}`
    : null;
}

/**
 * Valide récursivement un nœud contre le catalogue fermé.
 * @param {*} node
 * @param {string} pathLabel - pour des messages d'erreur exploitables
 * @param {number} depth
 * @param {{count: number}} counter - nœuds déjà validés (partagé sur l'arbre)
 * @param {string[]} errors - accumulateur (rempli en place)
 * @returns {object|null} nœud sanitisé (mêmes props, filtrées) ou null si invalide
 */
function validateNode(node, pathLabel, depth, counter, errors) {
  if (depth > MAX_DEPTH) {
    errors.push(`${pathLabel} dépasse la profondeur maximale (${MAX_DEPTH}).`);
    return null;
  }
  counter.count++;
  if (counter.count > MAX_NODES) {
    errors.push(`Arbre A2UI trop volumineux (> ${MAX_NODES} nœuds).`);
    return null;
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${pathLabel} : nœud attendu (objet {type, props, children?}).`);
    return null;
  }
  // Rejet strict des clés de premier niveau inconnues (ex. un champ
  // "extra"/"dangerouslySetInnerHTML" ajouté à côté de type/props/children)
  // — un nœud A2UI n'a QUE ces trois clés possibles, jamais une quatrième.
  const unknownNodeKeys = Object.keys(node).filter(
    (k) => !['type', 'props', 'children'].includes(k)
  );
  if (unknownNodeKeys.length > 0) {
    errors.push(`${pathLabel} : clé(s) de nœud non autorisée(s) : ${unknownNodeKeys.join(', ')}.`);
    return null;
  }

  const { type } = node;
  if (!ALLOWED_TYPES.includes(type)) {
    errors.push(
      `${pathLabel} : type "${String(type)}" absent du catalogue fermé (${ALLOWED_TYPES.join(', ')}).`
    );
    return null;
  }
  const spec = CATALOG[type];
  const rawProps = node.props && typeof node.props === 'object' ? node.props : {};
  const sanitizedProps = {};

  for (const [propName, propSpec] of Object.entries(spec.props)) {
    const has = Object.prototype.hasOwnProperty.call(rawProps, propName);
    if (!has) {
      if (propSpec.required) {
        errors.push(`${pathLabel} (${type}) : prop requise "${propName}" manquante.`);
        return null;
      }
      continue;
    }
    const value = rawProps[propName];
    const htmlError = findHtmlInjection(value, `${pathLabel}.${propName}`);
    if (htmlError) {
      errors.push(htmlError);
      return null;
    }
    if (!propSpec.validate(value)) {
      errors.push(`${pathLabel} (${type}) : valeur invalide pour "${propName}".`);
      return null;
    }
    sanitizedProps[propName] = value;
  }

  // Toute prop hors catalogue est un rejet strict, pas un simple abandon
  // silencieux — une prop inconnue est un signal que l'appelant (ou le LLM)
  // s'attend à un comportement que ce module ne peut pas garantir sûr.
  const unknownProps = Object.keys(rawProps).filter((k) => !(k in spec.props));
  if (unknownProps.length > 0) {
    errors.push(`${pathLabel} (${type}) : prop(s) non autorisée(s) : ${unknownProps.join(', ')}.`);
    return null;
  }

  const result = { type, props: sanitizedProps };

  if (node.children !== undefined) {
    if (!spec.allowsChildren) {
      errors.push(`${pathLabel} (${type}) ne peut pas avoir d'enfants.`);
      return null;
    }
    if (!Array.isArray(node.children)) {
      errors.push(`${pathLabel} (${type}) : "children" doit être un tableau.`);
      return null;
    }
    const children = [];
    for (let i = 0; i < node.children.length; i++) {
      const child = validateNode(
        node.children[i],
        `${pathLabel}.children[${i}]`,
        depth + 1,
        counter,
        errors
      );
      if (child === null) return null; // rejet strict : un enfant invalide invalide tout le sous-arbre
      children.push(child);
    }
    result.children = children;
  }

  return result;
}

/**
 * Valide (et sanitise) une charge utile A2UI reçue du LLM/serveur.
 * @param {string|object} input - JSON string ou objet déjà parsé
 * @returns {{valid: true, root: object}|{valid: false, errors: string[]}}
 */
function parseA2UI(input) {
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch (e) {
      return { valid: false, errors: [`JSON invalide : ${e.message}`] };
    }
  }
  const errors = [];
  const root = validateNode(raw, 'root', 0, { count: 0 }, errors);
  return root === null ? { valid: false, errors } : { valid: true, root };
}

// ---------------------------------------------------------------------------
// Rendu DOM (navigateur uniquement) — textContent partout, jamais innerHTML.
// ---------------------------------------------------------------------------

/**
 * Construit un élément DOM pour un nœud DÉJÀ validé par parseA2UI(). Ne
 * revalide pas le catalogue (fait confiance à la forme, jamais au CONTENU
 * texte, qui reste posé via textContent) — appeler uniquement avec
 * `parseA2UI(input).root`, jamais avec une entrée non validée.
 * @param {object} node - { type, props, children? }
 * @param {(action: string, node: object) => void} [onAction] - appelé avec
 *   l'identifiant opaque `action` d'un Button cliqué ; c'est à L'HÔTE de
 *   décider quoi en faire (aucune exécution ici).
 * @returns {HTMLElement}
 */
function renderA2UI(node, onAction) {
  if (typeof document === 'undefined') {
    throw new Error('renderA2UI() nécessite un DOM (navigateur) — voir parseA2UI() pour Node.');
  }
  const { type, props = {}, children = [] } = node;

  let el;
  switch (type) {
    case 'Card': {
      el = document.createElement('div');
      el.className = 'a2ui-card';
      if (props.title) {
        const title = document.createElement('div');
        title.className = 'a2ui-card-title';
        title.textContent = props.title;
        el.appendChild(title);
      }
      if (props.subtitle) {
        const subtitle = document.createElement('div');
        subtitle.className = 'a2ui-card-subtitle';
        subtitle.textContent = props.subtitle;
        el.appendChild(subtitle);
      }
      for (const child of children) {
        el.appendChild(renderA2UI(child, onAction));
      }
      break;
    }
    case 'TextLabel': {
      el = document.createElement('p');
      el.className = `a2ui-text a2ui-text--${props.variant || 'body'}`;
      el.textContent = props.text;
      break;
    }
    case 'Button': {
      el = document.createElement('button');
      el.type = 'button';
      el.className = `a2ui-button a2ui-button--${props.style || 'primary'}`;
      el.textContent = props.label;
      el.addEventListener('click', () => {
        if (typeof onAction === 'function') onAction(props.action, node);
      });
      break;
    }
    case 'TextInput': {
      el = document.createElement('input');
      el.type = props.inputType === 'number' ? 'number' : 'text';
      el.name = props.name;
      if (props.placeholder) el.placeholder = props.placeholder;
      if (props.value !== undefined) el.value = props.value;
      break;
    }
    case 'ProgressGauge': {
      el = document.createElement('div');
      el.className = 'a2ui-gauge';
      const max = props.max || 100;
      const bar = document.createElement('progress');
      bar.max = max;
      bar.value = Math.min(Math.max(props.value, 0), max);
      el.appendChild(bar);
      if (props.label) {
        const label = document.createElement('span');
        label.className = 'a2ui-gauge-label';
        label.textContent = props.label;
        el.appendChild(label);
      }
      break;
    }
    default:
      // Ne devrait jamais arriver sur un arbre issu de parseA2UI() — filet
      // de sécurité si renderA2UI() est appelé directement avec une entrée
      // non validée.
      throw new Error(`renderA2UI: type non supporté "${type}" (catalogue fermé).`);
  }
  return el;
}

const api = { ALLOWED_TYPES, parseA2UI, renderA2UI };

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.A2UIParser = api;
}
