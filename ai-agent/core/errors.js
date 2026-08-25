'use strict';

class AgentError extends Error {
  constructor(message, code = 'AGENT_ERROR', options = {}) {
    super(message, options);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

class BudgetExceededError extends AgentError {
  constructor(message) {
    super(message, 'BUDGET_EXCEEDED', { retryable: false });
    this.name = 'BudgetExceededError';
  }
}

class ToolPolicyError extends AgentError {
  constructor(message) {
    super(message, 'TOOL_POLICY_DENIED', { retryable: false });
    this.name = 'ToolPolicyError';
  }
}

module.exports = { AgentError, BudgetExceededError, ToolPolicyError };
