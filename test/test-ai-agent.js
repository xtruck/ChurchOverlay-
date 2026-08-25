'use strict';

const assert = require('assert');
const { ChurchOverlayAgent } = require('../ai-agent/core/agent');
const { Tool } = require('../ai-agent/tools/tool');
const { InMemoryStore } = require('../ai-agent/memory/memory-store');
const { normalizeMessages } = require('../ai-agent/providers/openai-compatible');

class FakeProvider {
  constructor() {
    this.calls = 0;
  }
  async generate(request) {
    this.calls++;
    const hasToolResult = request.messages.some((message) => message.role === 'tool');
    if (!hasToolResult)
      return {
        text: '',
        toolCalls: [{ id: 'call-1', name: 'show_test', arguments: { value: 'ready' } }],
        usage: { total_tokens: 3 },
      };
    return { text: 'Termine.', toolCalls: [], usage: { total_tokens: 2 } };
  }
}

(async () => {
  const providerMessages = normalizeMessages([
    { role: 'user', content: 'show it' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call-1', name: 'show_test', arguments: { value: 'ready' } }],
    },
    { role: 'tool', results: [{ toolCallId: 'call-1', result: { ok: true } }] },
  ]);
  assert.strictEqual(providerMessages[1].tool_calls[0].function.name, 'show_test');
  assert.strictEqual(providerMessages[2].tool_call_id, 'call-1');

  const store = new InMemoryStore();
  const provider = new FakeProvider();
  let executed = 0;
  const tool = new Tool(
    {
      name: 'show_test',
      description: 'Test tool',
      inputSchema: {
        type: 'object',
        required: ['value'],
        properties: { value: { type: 'string' } },
      },
      policy: 'confirm',
      idempotent: true,
    },
    async ({ value }) => {
      executed++;
      return { value };
    }
  );
  const agent = new ChurchOverlayAgent({ model: provider, tools: [tool], memory: store });

  const firstEvents = [];
  for await (const event of agent.run({ sessionId: 'test-session', input: 'Do the thing.' }))
    firstEvents.push(event);
  assert.ok(firstEvents.some((event) => event.type === 'run_paused'));
  assert.strictEqual(executed, 0);
  const paused = [...store.runs.values()][0];
  assert.strictEqual(paused.status, 'paused');

  const resumedEvents = [];
  for await (const event of agent.run({
    sessionId: 'test-session',
    runId: paused.id,
    approvedToolCallIds: ['call-1'],
  }))
    resumedEvents.push(event);
  assert.ok(resumedEvents.some((event) => event.type === 'tool_completed'));
  assert.ok(resumedEvents.some((event) => event.type === 'run_completed'));
  assert.strictEqual(executed, 1);
  assert.strictEqual((await store.getRun(paused.id)).status, 'completed');
  console.log('=== AI agent tests passed ===');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
