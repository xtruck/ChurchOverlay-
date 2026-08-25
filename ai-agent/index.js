'use strict';

const { ChurchOverlayAgent } = require('./core/agent');
const { OpenAICompatibleProvider } = require('./providers/openai-compatible');
const { SQLiteMemoryStore } = require('./memory/sqlite');
const { createChurchOverlayTools } = require('./tools/church-overlay');

function createChurchOverlayAgent({ userDataDir, services, provider } = {}) {
  const memory = new SQLiteMemoryStore(userDataDir);
  const model =
    provider ||
    new OpenAICompatibleProvider({
      baseUrl: process.env.AGENT_BASE_URL || 'https://api.groq.com/openai/v1',
    });
  const tools = createChurchOverlayTools(services);
  return new ChurchOverlayAgent({
    model,
    tools,
    memory,
    budget: { maxTokens: 8000, maxCostUsd: 1, maxToolCalls: 30, timeoutSeconds: 120 },
  });
}

module.exports = { createChurchOverlayAgent };
