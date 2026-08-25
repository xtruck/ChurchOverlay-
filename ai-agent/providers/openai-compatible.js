'use strict';

const { ModelProvider } = require('./provider');

class OpenAICompatibleProvider extends ModelProvider {
  constructor({
    apiKey,
    model,
    baseUrl = 'https://api.groq.com/openai/v1',
    timeoutMs = 30000,
  } = {}) {
    super();
    this.apiKey = apiKey || process.env.AGENT_API_KEY || process.env.GROQ_API_KEY || '';
    this.model = model || process.env.AGENT_MODEL || 'openai/gpt-oss-20b';
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  async generate(request) {
    if (!this.apiKey) throw new Error('No agent model API key configured.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: normalizeMessages(request.messages),
          tools: toProviderTools(request.tools),
          tool_choice: 'auto',
        }),
        signal: request.signal || controller.signal,
      });
      if (!response.ok) throw new Error(`Agent provider returned HTTP ${response.status}.`);
      const data = await response.json();
      const message = data.choices?.[0]?.message || {};
      return {
        text: typeof message.content === 'string' ? message.content : '',
        toolCalls: (message.tool_calls || []).map((call) => ({
          id: call.id,
          name: call.function?.name,
          arguments: parseArguments(call.function?.arguments),
        })),
        usage: data.usage || {},
        model: data.model || this.model,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function toProviderTools(tools = []) {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}
function normalizeMessages(messages = []) {
  const normalized = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
      normalized.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) },
        })),
      });
      continue;
    }
    if (message.role === 'tool' && Array.isArray(message.results)) {
      for (const result of message.results) {
        normalized.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: JSON.stringify(
            result.error === undefined ? result.result : { error: result.error }
          ),
        });
      }
      continue;
    }
    normalized.push(message);
  }
  return normalized;
}
function parseArguments(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error('Model returned malformed tool arguments.', { cause: error });
  }
}

module.exports = { OpenAICompatibleProvider, normalizeMessages };
