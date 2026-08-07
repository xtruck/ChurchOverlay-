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

class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Même taille de batch que l'ancien createScriptProcessor(4096, 1, 1),
    // pour garder une cadence d'envoi IPC comparable (ni trop de petits
    // messages, ni une latence supplémentaire notable).
    this._batchSize = 4096;
    this._accum = new Float32Array(this._batchSize);
    this._accumLength = 0;
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

    const channelData = input[0]; // mono : un seul canal, comme l'ancien getChannelData(0)

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
