'use strict';

const EVENT_TYPES = Object.freeze([
  'run_started',
  'thinking_started',
  'tool_requested',
  'tool_started',
  'tool_completed',
  'tool_failed',
  'message_delta',
  'run_completed',
  'run_failed',
  'run_paused',
  'run_resumed',
]);

function createEvent(type, data = {}) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`Unknown agent event: ${type}`);
  return Object.freeze({
    type,
    timestamp: Date.now(),
    ...data,
  });
}

module.exports = { EVENT_TYPES, createEvent };
