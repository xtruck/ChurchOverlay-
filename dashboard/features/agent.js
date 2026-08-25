import { state, ws } from '../state.js';
import { requireWsOrWarn, showToast } from '../utils.js';

let pending = null;

export function runAgent() {
  if (!requireWsOrWarn()) return;
  const input = document.getElementById('agentInput');
  const request = input ? input.value.trim() : '';
  if (!request) return showToast('Décrivez la tâche à préparer.', 'error');
  render('Exécution en cours...');
  ws.send(
    JSON.stringify({
      action: 'agentRun',
      sessionId: `service-${new Date().toISOString().slice(0, 10)}`,
      input: request,
    })
  );
}

export function approveAgentTool() {
  if (!pending || !requireWsOrWarn()) return;
  ws.send(
    JSON.stringify({
      action: 'agentResume',
      sessionId: pending.sessionId,
      runId: pending.runId,
      approvedToolCallIds: [pending.toolCallId],
    })
  );
  pending = null;
  render('Reprise après confirmation...');
}

export function renderAgentEvent(event) {
  if (!event) return;
  state.agentRunId = event.runId || state.agentRunId;
  if (event.type === 'message_delta') append(event.text || '');
  if (event.type === 'tool_requested') append(`\nOutil demandé : ${event.name}`);
  if (event.type === 'tool_started') append(`\nOutil en cours : ${event.name}`);
  if (event.type === 'tool_completed') append(`\nOutil terminé : ${event.name}`);
  if (event.type === 'tool_failed') append(`\nOutil échoué : ${event.name} - ${event.error}`);
  if (event.type === 'run_paused') {
    pending = {
      runId: event.runId,
      sessionId: event.sessionId || `service-${new Date().toISOString().slice(0, 10)}`,
      toolCallId: event.toolCallId,
    };
    const button = document.getElementById('agentApproveBtn');
    if (button) button.style.display = 'inline-flex';
    append(`\nConfirmation requise pour : ${event.name}`);
  }
  if (event.type === 'run_completed' || event.type === 'run_failed') {
    const button = document.getElementById('agentApproveBtn');
    if (button) button.style.display = 'none';
  }
}

function append(text) {
  const output = document.getElementById('agentOutput');
  if (!output) return;
  if (output.dataset.streaming !== 'true') output.textContent = '';
  output.dataset.streaming = 'true';
  output.textContent += text;
}

function render(text) {
  const output = document.getElementById('agentOutput');
  if (output) {
    output.dataset.streaming = 'false';
    output.textContent = text;
  }
}

window.runAgent = runAgent;
window.approveAgentTool = approveAgentTool;
