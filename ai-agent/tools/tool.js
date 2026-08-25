'use strict';

const { ToolPolicyError } = require('../core/errors');

const POLICIES = Object.freeze(['auto', 'confirm', 'deny']);

class Tool {
  constructor(config, execute) {
    if (!config || typeof config.name !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(config.name)) {
      throw new Error('Tool name must be a lowercase identifier.');
    }
    if (typeof execute !== 'function') throw new Error(`Tool ${config.name} needs an executor.`);
    this.name = config.name;
    this.description = String(config.description || '');
    this.inputSchema = config.inputSchema || { type: 'object', properties: {} };
    this.policy = POLICIES.includes(config.policy) ? config.policy : 'confirm';
    this.timeoutMs = positive(config.timeoutMs, 10000);
    this.maxRetries = nonNegative(config.maxRetries, 0);
    this.idempotent = config.idempotent === true;
    this.execute = execute;
  }

  validateArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error(`Invalid arguments for tool ${this.name}.`);
    }
    const required = this.inputSchema.required || [];
    for (const key of required) {
      if (!(key in args)) throw new Error(`Missing required argument: ${key}.`);
    }
    for (const [key, schema] of Object.entries(this.inputSchema.properties || {})) {
      if (!(key in args)) continue;
      if (schema.type === 'string' && typeof args[key] !== 'string')
        throw new Error(`Argument ${key} must be a string.`);
      if (
        schema.type === 'number' &&
        (typeof args[key] !== 'number' || !Number.isFinite(args[key]))
      )
        throw new Error(`Argument ${key} must be a number.`);
      if (schema.type === 'boolean' && typeof args[key] !== 'boolean')
        throw new Error(`Argument ${key} must be a boolean.`);
    }
    return args;
  }

  async run(args, context = {}) {
    if (this.policy === 'deny') throw new ToolPolicyError(`Tool ${this.name} is denied by policy.`);
    this.validateArgs(args);
    return this.execute(args, context);
  }
}

function positive(value, fallback) {
  return typeof value === 'number' && value > 0 ? value : fallback;
}
function nonNegative(value, fallback) {
  return typeof value === 'number' && value >= 0 ? value : fallback;
}

module.exports = { Tool, POLICIES };
