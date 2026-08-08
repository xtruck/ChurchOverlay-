/**
 * ============================================================================
 *  audio-capture-worklet.js — AudioWorkletProcessor pour la capture micro
 * ----------------------------------------------------------------------------
 *  Remplace l'ancien ScriptProcessorNode (createScriptProcessor, déprécié —
 *  voir avertissement DevTools "Use AudioWorkletNode instead") : un
 *  AudioWorkletProcessor tourne sur le thread audio dédié du navigateur,
 *  séparé du thread principal (celui de dashboard.js/l'UI), ce qui évite
 *  qu'un pic de traitement audio ne bloque l'interface.
 *
 *  Chargé via audioContext.audioWorklet.addModule() (voir dashboard.js,
 *  startRealAudioCapture) : ce fichier tourne dans un scope global séparé
 *  (AudioWorkletGlobalScope) sans accès au DOM ni aux fonctions de la page —
 *  la logique de downsampling/conversion PCM16 de dashboard.js
 *  (downsampleBuffer/floatTo16BitPCM) est donc dupliquée ici plutôt que
 *  partagée, et la seule communication avec le thread principal se fait via
 *  MessagePort (this.port).
 * ============================================================================
 */

// AJOUT (bruit de fond — recommandation "filtres audio" façon OBS) : un
// expandeur/gate de bruit doux, calculé ici plutôt que via un
// DynamicsCompressorNode natif (compresseur : réduit les PICS forts, ne
// touche pas au bruit de fond faible — l'inverse de ce qu'il faut ici).
// Suit l'enveloppe (attaque rapide/relâchement lent, classique en gate
// audio) et ATTÉNUE plutôt qu'annule le signal sous le seuil (GATE_FLOOR,
// pas 0) : un hard-mute couperait net le tout début d'une syllabe encore
// sous le seuil au moment où l'enveloppe grimpe, et supprimerait
// entièrement une voix faible plutôt que de simplement réduire le bruit
// autour. Coût : quelques multiplications/comparaisons par échantillon,
// déjà sur le thread audio dédié — négligeable à côté du travail existant.
const GATE_THRESHOLD = 0.015; // amplitude d'enveloppe en dessous de laquelle on atténue
const GATE_FLOOR = 0.12; // gain appliqué quand fermé (jamais 0 — pas de coupure brutale)
const GATE_ATTACK_S = 0.003; // ouverture rapide : ne pas manger le début d'un mot
const GATE_RELEASE_S = 0.2; // fermeture lente : ne pas couper entre deux syllabes d'un même mot
const GAIN_SMOOTH_S = 0.005; // lissage du gain appliqué, évite les clics/zipper noise

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Même taille de batch que l'ancien createScriptProcessor(4096, 1, 1),
    // pour garder une cadence d'envoi IPC comparable (ni trop de petits
    // messages, ni une latence supplémentaire notable).
    this._batchSize = 4096;
    this._accum = new Float32Array(this._batchSize);
    this._accumLength = 0;

    // Coefficients calculés depuis le sampleRate RÉEL du périphérique (44.1k/
    // 48k selon le micro) plutôt que codés en dur, sinon le comportement du
    // gate varierait d'un poste à l'autre pour le même réglage en secondes.
    this._envelope = 0;
    this._gain = 1;
    this._gateEnabled = true;
    this._attackCoeff = 1 - Math.exp(-1 / (GATE_ATTACK_S * sampleRate));
    this._releaseCoeff = 1 - Math.exp(-1 / (GATE_RELEASE_S * sampleRate));
    this._gainSmoothCoeff = 1 - Math.exp(-1 / (GAIN_SMOOTH_S * sampleRate));

    // Activation/désactivation depuis dashboard.js (voir toggleNoiseGate()) —
    // utile si un micro déjà propre/pré-traité n'en a pas besoin.
    this.port.onmessage = (event) => {
      if (event.data && typeof event.data.gateEnabled === 'boolean') {
        this._gateEnabled = event.data.gateEnabled;
      }
    };
  }

  _applyNoiseGate(channelData) {
    if (!this._gateEnabled) return channelData;
    const out = new Float32Array(channelData.length);
    for (let i = 0; i < channelData.length; i++) {
      const sample = channelData[i];
      const absSample = Math.abs(sample);

      // Enveloppe : attaque rapide (suit les pics qui montent), relâchement
      // lent (redescend doucement après un pic, ne "papillonne" pas entre
      // chaque syllabe).
      const coeff = absSample > this._envelope ? this._attackCoeff : this._releaseCoeff;
      this._envelope += (absSample - this._envelope) * coeff;

      const targetGain = this._envelope >= GATE_THRESHOLD ? 1 : GATE_FLOOR;
      this._gain += (targetGain - this._gain) * this._gainSmoothCoeff;

      out[i] = sample * this._gain;
    }
    return out;
  }

  _downsampleAndSend(buffer) {
    const outSampleRate = 16000; // attendu par audio-capture.js côté serveur (Whisper)
    const inSampleRate = sampleRate; // global AudioWorkletGlobalScope = audioContext.sampleRate

    let downsampled;
    if (outSampleRate === inSampleRate) {
      downsampled = buffer;
    } else {
      const ratio = inSampleRate / outSampleRate;
      const newLength = Math.round(buffer.length / ratio);
      downsampled = new Float32Array(newLength);
      let offsetResult = 0;
      let offsetBuffer = 0;
      while (offsetResult < newLength) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
        let accum = 0;
        let count = 0;
        for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
          accum += buffer[i];
          count++;
        }
        downsampled[offsetResult] = count > 0 ? accum / count : 0;
        offsetResult++;
        offsetBuffer = nextOffsetBuffer;
      }
    }

    const pcm16 = new Int16Array(downsampled.length);
    for (let i = 0; i < downsampled.length; i++) {
      const s = Math.max(-1, Math.min(1, downsampled[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    // Transfert (pas de copie) : le buffer change de propriétaire, ce qui
    // est sans risque ici puisqu'il vient d'être créé pour cet envoi.
    this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true; // pas encore de flux micro connecté

    const channelData = this._applyNoiseGate(input[0]); // mono : un seul canal, comme l'ancien getChannelData(0)

    let i = 0;
    while (i < channelData.length) {
      const spaceLeft = this._batchSize - this._accumLength;
      const chunkLen = Math.min(spaceLeft, channelData.length - i);
      this._accum.set(channelData.subarray(i, i + chunkLen), this._accumLength);
      this._accumLength += chunkLen;
      i += chunkLen;

      if (this._accumLength >= this._batchSize) {
        this._downsampleAndSend(this._accum);
        this._accumLength = 0;
      }
    }

    return true; // renvoyer false arrêterait définitivement le processor
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
