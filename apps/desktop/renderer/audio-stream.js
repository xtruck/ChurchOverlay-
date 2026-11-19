;(function () {
  const DEFAULT_MAX_BUFFERED_BYTES = 64 * 1024

  function createAudioFrameSender(maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES) {
    if (!Number.isInteger(maxBufferedBytes) || maxBufferedBytes < 1) {
      throw new Error("maxBufferedBytes must be a positive integer")
    }

    let framesReceived = 0
    let framesSent = 0
    let droppedDisconnected = 0
    let droppedBackpressure = 0
    let sendFailures = 0
    let captureGaps = 0
    let lastSequence = null
    let lastOutcome = "idle"

    return Object.freeze({
      send(socket, samples, sequence, encodeFrame) {
        framesReceived++

        if (lastSequence !== null) {
          const distance = (sequence - lastSequence) >>> 0
          if (distance > 1 && distance < 0x80000000) captureGaps += distance - 1
        }
        lastSequence = sequence >>> 0

        if (!socket || socket.readyState !== 1) {
          droppedDisconnected++
          lastOutcome = "disconnected"
          return false
        }
        if (socket.bufferedAmount >= maxBufferedBytes) {
          droppedBackpressure++
          lastOutcome = "backpressure"
          return false
        }

        try {
          socket.send(encodeFrame(samples, sequence))
          framesSent++
          lastOutcome = "sent"
          return true
        } catch {
          sendFailures++
          lastOutcome = "send-failed"
          return false
        }
      },
      snapshot() {
        return {
          framesReceived,
          framesSent,
          droppedDisconnected,
          droppedBackpressure,
          sendFailures,
          captureGaps,
          lastOutcome,
        }
      },
      reset() {
        framesReceived = 0
        framesSent = 0
        droppedDisconnected = 0
        droppedBackpressure = 0
        sendFailures = 0
        captureGaps = 0
        lastSequence = null
        lastOutcome = "idle"
      },
    })
  }

  globalThis.ChurchOverlayAudioStream = Object.freeze({ createAudioFrameSender })
})()
