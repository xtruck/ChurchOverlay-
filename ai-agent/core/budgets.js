'use strict';

const { BudgetExceededError } = require('./errors');

class Budget {
  constructor(options = {}) {
    this.maxTokens = positiveLimit(options.maxTokens, 8000);
    this.maxCostUsd = positiveLimit(options.maxCostUsd, 1);
    this.maxToolCalls = positiveLimit(options.maxToolCalls, 30);
    this.timeoutSeconds = positiveLimit(options.timeoutSeconds, 120);
    this.maxRetries = nonNegativeLimit(options.maxRetries, 2);
    this.startedAt = Date.now();
    this.tokens = 0;
    this.costUsd = 0;
    this.toolCalls = 0;
  }

  checkTime() {
    if (Date.now() - this.startedAt > this.timeoutSeconds * 1000) {
      throw new BudgetExceededError('Agent execution timeout exceeded.');
    }
  }

  recordToolCall() {
    this.checkTime();
    this.toolCalls++;
    if (this.toolCalls > this.maxToolCalls) {
      throw new BudgetExceededError('Maximum tool calls exceeded.');
    }
  }

  recordUsage(usage = {}) {
    this.tokens += numberOrZero(usage.totalTokens || usage.total_tokens);
    this.costUsd += numberOrZero(usage.costUsd || usage.cost_usd);
    if (this.tokens > this.maxTokens) throw new BudgetExceededError('Maximum tokens exceeded.');
    if (this.costUsd > this.maxCostUsd) throw new BudgetExceededError('Maximum cost exceeded.');
  }

  snapshot() {
    return {
      tokens: this.tokens,
      toolCalls: this.toolCalls,
      durationMs: Date.now() - this.startedAt,
      estimatedCostUsd: this.costUsd,
    };
  }
}

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
function positiveLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
function nonNegativeLimit(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

module.exports = { Budget };
