'use strict';

const crypto = require('crypto');
const { Budget } = require('./budgets');
const { createEvent } = require('./events');
const { BudgetExceededError } = require('./errors');
const { ToolRegistry } = require('../tools/registry');

class ChurchOverlayAgent {
  constructor({ model, tools = [], memory, agentId = 'church-overlay-agent', budget = {} }) {
    if (!model || (typeof model.generate !== 'function' && typeof model.stream !== 'function'))
      throw new Error('An agent model provider is required.');
    if (!memory) throw new Error('An agent memory store is required.');
    this.model = model;
    this.registry = tools instanceof ToolRegistry ? tools : new ToolRegistry(tools);
    this.memory = memory;
    this.agentId = agentId;
    this.defaultBudget = budget;
  }

  async *run({
    sessionId,
    input,
    signal,
    approvedToolCallIds = [],
    budget: budgetOptions = {},
    runId: requestedRunId = null,
  }) {
    const existingRun = requestedRunId ? await this.memory.getRun(requestedRunId) : null;
    const runId = existingRun ? existingRun.id : crypto.randomUUID();
    const budget = new Budget({ ...this.defaultBudget, ...budgetOptions });
    const started = { id: runId, runId, sessionId, agentId: this.agentId, status: 'running' };
    await this.ensureSession(sessionId);
    if (!existingRun) {
      await this.memory.createRun({ ...started, createdAt: Date.now() });
      await this.memory.appendMessage(sessionId, {
        role: 'user',
        content: String(input || ''),
        runId,
        createdAt: Date.now(),
      });
    } else if (existingRun.status !== 'paused') {
      throw new Error('Only paused agent runs can be resumed.');
    }
    yield createEvent('run_started', { runId, sessionId, agentId: this.agentId });

    const messages = await this.memory.listMessages(sessionId);
    const conversation = [...messages];
    let request = { messages: conversation, tools: this.registry.definitions(), signal };
    let finalText = '';
    try {
      for (;;) {
        budget.checkTime();
        throwIfAborted(signal);
        yield createEvent('thinking_started', { runId });
        const response = await this.generate(request, signal);
        budget.recordUsage(response.usage);
        if (response.text) {
          finalText += response.text;
          yield createEvent('message_delta', { runId, text: response.text });
        }
        const calls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
        if (calls.length === 0) break;
        conversation.push({ role: 'assistant', toolCalls: calls, content: response.text || '' });
        const results = [];
        for (const call of calls) {
          budget.recordToolCall();
          const tool = this.registry.get(call.name);
          const toolCallId = call.id || crypto.randomUUID();
          yield createEvent('tool_requested', {
            runId,
            toolCallId,
            name: call.name,
            arguments: call.arguments || {},
          });
          if (!tool) {
            results.push({ toolCallId, name: call.name, error: 'Unknown tool.' });
            yield createEvent('tool_failed', {
              runId,
              toolCallId,
              name: call.name,
              error: 'Unknown tool.',
            });
            continue;
          }
          if (tool.policy === 'confirm' && !approvedToolCallIds.includes(toolCallId)) {
            await this.memory.appendMessage(sessionId, {
              role: 'assistant',
              toolCalls: calls,
              content: response.text || '',
              runId,
              createdAt: Date.now(),
            });
            await this.memory.saveToolCall({
              runId,
              toolCallId,
              name: call.name,
              arguments: call.arguments || {},
              status: 'pending',
              idempotencyKey: `${runId}:${toolCallId}`,
              createdAt: Date.now(),
            });
            await this.memory.updateRun(runId, { status: 'paused', pausedToolCallId: toolCallId });
            yield createEvent('run_paused', {
              runId,
              reason: 'confirmation_required',
              toolCallId,
              name: call.name,
            });
            return;
          }
          const previous = await this.memory.getToolCall(runId, toolCallId);
          if (previous && previous.status === 'completed') {
            results.push({ toolCallId, name: call.name, result: previous.result, reused: true });
            yield createEvent('tool_completed', {
              runId,
              toolCallId,
              name: call.name,
              result: previous.result,
              reused: true,
            });
            continue;
          }
          await this.memory.saveToolCall({
            runId,
            toolCallId,
            name: call.name,
            arguments: call.arguments || {},
            status: 'running',
            idempotencyKey: `${runId}:${toolCallId}`,
            createdAt: Date.now(),
          });
          yield createEvent('tool_started', { runId, toolCallId, name: call.name });
          try {
            const result = await executeWithRetry(
              tool,
              call.arguments || {},
              { runId, sessionId, signal },
              tool.maxRetries,
              budget
            );
            await this.memory.saveToolCall({
              runId,
              toolCallId,
              name: call.name,
              arguments: call.arguments || {},
              status: 'completed',
              result,
              idempotencyKey: `${runId}:${toolCallId}`,
              completedAt: Date.now(),
            });
            results.push({ toolCallId, name: call.name, result });
            yield createEvent('tool_completed', { runId, toolCallId, name: call.name, result });
          } catch (error) {
            await this.memory.saveToolCall({
              runId,
              toolCallId,
              name: call.name,
              arguments: call.arguments || {},
              status: 'failed',
              error: safeError(error),
              idempotencyKey: `${runId}:${toolCallId}`,
              completedAt: Date.now(),
            });
            results.push({ toolCallId, name: call.name, error: safeError(error) });
            yield createEvent('tool_failed', {
              runId,
              toolCallId,
              name: call.name,
              error: safeError(error),
            });
          }
        }
        conversation.push({ role: 'tool', results });
        request = {
          messages: conversation,
          tools: this.registry.definitions(),
          signal,
        };
      }
      await this.memory.appendMessage(sessionId, {
        role: 'assistant',
        content: finalText,
        runId,
        createdAt: Date.now(),
      });
      const usage = budget.snapshot();
      await this.memory.updateRun(runId, { status: 'completed', usage, completedAt: Date.now() });
      yield createEvent('run_completed', { runId, sessionId, text: finalText, usage });
    } catch (error) {
      const usage = budget.snapshot();
      await this.memory.updateRun(runId, {
        status: error instanceof BudgetExceededError ? 'failed' : 'failed',
        error: safeError(error),
        usage,
        completedAt: Date.now(),
      });
      yield createEvent('run_failed', {
        runId,
        sessionId,
        error: safeError(error),
        code: error.code,
        usage,
      });
    }
  }

  async generate(request, _signal) {
    if (typeof this.model.generate === 'function') return this.model.generate(request);
    let result = { text: '', toolCalls: [], usage: {} };
    for await (const event of this.model.stream(request)) {
      if (event && event.type === 'message_delta') result.text += event.text || '';
      if (event && event.type === 'response') result = { ...result, ...event.response };
    }
    return result;
  }

  async ensureSession(sessionId) {
    if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 120)
      throw new Error('A valid sessionId is required.');
    if (!(await this.memory.getSession(sessionId)))
      await this.memory.createSession({
        id: sessionId,
        agentId: this.agentId,
        createdAt: Date.now(),
      });
  }

  close() {
    if (this.memory && typeof this.memory.close === 'function') this.memory.close();
  }
}

async function executeWithRetry(tool, args, context, maxRetries, budget) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    budget.checkTime();
    try {
      return await withTimeout(tool.run(args, context), tool.timeoutMs, context.signal);
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !error.retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
  throw lastError;
}

function withTimeout(promise, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Tool timeout after ${timeoutMs}ms.`)),
      timeoutMs
    );
    const abort = () => {
      clearTimeout(timer);
      reject(new Error('Agent execution cancelled.'));
    };
    if (signal) {
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
    }
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
function throwIfAborted(signal) {
  if (signal && signal.aborted) throw new Error('Agent execution cancelled.');
}
function safeError(error) {
  return String((error && error.message) || error || 'Unknown error').slice(0, 1000);
}

module.exports = { ChurchOverlayAgent, executeWithRetry };
