'use strict';
/**
 * ============================================================================
 *  silero-vad.js — Détection d'activité vocale neuronale (Silero VAD, ONNX)
 * ----------------------------------------------------------------------------
 *  Remplace la classification RMS/seuil statique de audio-capture.js par un
 *  modèle entraîné à distinguer la parole du bruit de fond (musique, sono,
 *  ventilateur, réverbération, foule...) — un simple niveau sonore ne peut
 *  pas faire cette distinction, d'où les faux positifs de transcription
 *  observés en usage réel (segments bruyants envoyés au STT comme si
 *  c'était de la parole).
 *
 *  Modèle : https://github.com/snakers4/silero-vad (licence MIT, voir
 *  models/SILERO_VAD_LICENSE), fichier models/silero_vad.onnx (~2.3 Mo).
 *
 *  Contrat du modèle — vérifié EMPIRIQUEMENT (pas seulement documenté) via
 *  une inspection manuelle des tenseurs d'entrée/sortie et un test de
 *  formes valides avant d'écrire ce wrapper :
 *    - inputs  : 'input' (float32 [1, 576]), 'state' (float32 [2,1,128],
 *      état LSTM réinjecté d'une fenêtre à l'autre), 'sr' (int64 scalaire).
 *    - outputs : 'output' (float32 [1,1], probabilité de parole 0-1),
 *      'stateN' (float32 [2,1,128], nouvel état à réinjecter).
 *    - SEULE combinaison validée par l'équipe Silero ET confirmée
 *      fonctionnelle ici : 16000 Hz + entrée de EXACTEMENT 576 échantillons
 *      = 64 échantillons de CONTEXTE (les 64 derniers de la fenêtre
 *      précédente, zéros au démarrage) + 512 échantillons courants (32ms).
 *      C'est l'architecture officielle du modèle v5 : le wrapper python de
 *      référence (silero_vad.utils_vad.OnnxWrapper.__call__) préfixe
 *      systématiquement ce contexte avant chaque inférence, sans quoi la
 *      fenêtrage STFT interne du modèle se décale d'une trame et la
 *      probabilité de sortie est figée à ~0.001 pour TOUTE entrée (silence,
 *      bruit, et même parole réelle). Envoyer 512 échantillons nus produit
 *      exactement ce bug (vérifié sur onnxruntime-node ET onnxruntime
 *      python). Le contexte est réinjecté de fenêtre en fenêtre via le
 *      streamState, comme l'état LSTM.
 *      audio-capture.js capture déjà en 16kHz mono — aucun ré-échantillonnage
 *      nécessaire.
 * ============================================================================
 */

const path = require('path');
const fs = require('fs');

const WINDOW_SAMPLES = 512; // 32ms à 16kHz — fenêtre d'écart entre deux inférences
const CONTEXT_SAMPLES = 64; // contexte STFT requis par le modèle v5 (voir header)
const MODEL_INPUT_SAMPLES = WINDOW_SAMPLES + CONTEXT_SAMPLES; // 576
const SAMPLE_RATE = 16000;
const STATE_DIMS = [2, 1, 128];
const STATE_SIZE = STATE_DIMS[0] * STATE_DIMS[1] * STATE_DIMS[2];

let ort = null;
let session = null;
let initError = null;
let initPromise = null;

/**
 * Résout le chemin du modèle .onnx. En dev (`node server.js` direct) comme
 * en app empaquetée, ce fichier est un simple binaire statique référencé
 * dans package.json → build.files (pas un module natif) — pas besoin d'un
 * traitement asar.unpacked spécial, contrairement aux modules natifs
 * (voir better-sqlite3 dans package.json → build.files).
 */
function resolveModelPath() {
  return path.join(__dirname, 'models', 'silero_vad.onnx');
}

/**
 * Charge le modèle une seule fois (idempotent, sûr à appeler plusieurs
 * fois/en concurrence). Ne lève jamais — retourne { ok, error } pour que
 * l'appelant décide explicitement du repli plutôt que de propager une
 * exception au milieu du pipeline audio.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function init() {
  if (session) return { ok: true, error: null };
  if (initError) return { ok: false, error: initError };
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const modelPath = resolveModelPath();
      if (!fs.existsSync(modelPath)) {
        throw new Error(`Modèle introuvable : ${modelPath}`);
      }
      // AJOUT : require() différé (pas en haut de fichier) — évite de payer
      // le coût de chargement d'onnxruntime-node pour les usages qui
      // n'activent jamais le VAD neuronal (ex. tests unitaires ciblés).
      ort = require('onnxruntime-node');
      session = await ort.InferenceSession.create(modelPath);
      return { ok: true, error: null };
    } catch (err) {
      initError = (err && err.message) || String(err);
      session = null;
      return { ok: false, error: initError };
    }
  })();

  return initPromise;
}

/** @returns {boolean} true seulement après un init() réussi. */
function isAvailable() {
  return !!session;
}

/**
 * Crée un état de streaming pour UN flux de capture continu. L'état LSTM
 * ET le contexte STFT de 64 échantillons sont spécifiques à un flux audio —
 * ne jamais partager entre deux captures concurrentes (ex. deux fenêtres de
 * test en parallèle).
 * @returns {{ state: Float32Array, context: Float32Array }}
 */
function createStreamState() {
  return {
    state: new Float32Array(STATE_SIZE),
    context: new Float32Array(CONTEXT_SAMPLES),
  };
}

/**
 * Convertit un buffer PCM16LE en Float32Array normalisé [-1, 1] (format
 * attendu par le tenseur 'input' du modèle).
 * @param {Buffer} buffer
 * @returns {Float32Array}
 */
function pcm16ToFloat32(buffer) {
  const numSamples = Math.floor(buffer.length / 2);
  const out = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    out[i] = buffer.readInt16LE(i * 2) / 32768;
  }
  return out;
}

/**
 * Classe UNE fenêtre de EXACTEMENT WINDOW_SAMPLES échantillons. Les appels
 * DOIVENT être séquentiels pour un même streamState (le LSTM dépend de
 * l'ordre) — voir la file d'attente sérielle côté audio-capture.js, ce
 * module ne l'impose pas lui-même.
 *
 * Le modèle v5 exige une entrée de MODEL_INPUT_SAMPLES (576) échantillons :
 * les CONTEXT_SAMPLES (64) premiers sont les 64 derniers échantillons de la
 * fenêtre précédente (zéros au tout premier appel), stockés dans le
 * streamState. C'est ce préfixe-contexte qui rend le fenêtrage STFT interne
 * du modèle cohérent — sans lui, la probabilité de sortie reste figée à
 * ~0.001 quelle que soit l'entrée (voir header du module).
 * @param {Float32Array} samples - EXACTEMENT WINDOW_SAMPLES échantillons.
 * @param {{ state: Float32Array, context: Float32Array }} streamState - créé
 *   par createStreamState(), ses champs `state` et `context` sont mis à jour
 *   en place à chaque appel.
 * @returns {Promise<number>} probabilité de parole, 0-1.
 */
async function processWindow(samples, streamState) {
  if (samples.length !== WINDOW_SAMPLES) {
    throw new Error(`silero-vad: attendu ${WINDOW_SAMPLES} échantillons, reçu ${samples.length}`);
  }
  if (!session) {
    throw new Error('silero-vad: session non initialisée (appeler init() au préalable)');
  }
  const input = new Float32Array(MODEL_INPUT_SAMPLES);
  input.set(streamState.context, 0);
  input.set(samples, CONTEXT_SAMPLES);
  const stateTensor = new ort.Tensor('float32', streamState.state, STATE_DIMS);
  const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
  const out = await session.run({
    input: new ort.Tensor('float32', input, [1, MODEL_INPUT_SAMPLES]),
    state: stateTensor,
    sr,
  });
  streamState.state = Float32Array.from(out.stateN.data);
  streamState.context = input.slice(-CONTEXT_SAMPLES);
  return out.output.data[0];
}

module.exports = {
  WINDOW_SAMPLES,
  SAMPLE_RATE,
  init,
  isAvailable,
  createStreamState,
  pcm16ToFloat32,
  processWindow,
};
