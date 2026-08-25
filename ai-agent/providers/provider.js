'use strict';

/**
 * Provider contract. Providers return assistant messages containing optional
 * tool calls and may stream text/tool events without exposing private reasoning.
 */
class ModelProvider {
  async generate(_request) {
    throw new Error('ModelProvider.generate() is not implemented.');
  }

  async *stream(request) {
    yield await this.generate(request);
  }
}

module.exports = { ModelProvider };
