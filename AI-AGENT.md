# Church Overlay AI Agent

The agent is an operator-side layer around the existing Church Overlay server. It does not replace audio capture, VAD, ASR, deterministic Bible detection, or overlay rendering.

## Configuration

The default provider is an OpenAI-compatible endpoint using Groq-compatible credentials:

```bash
export AGENT_API_KEY=gsk_your_key
export AGENT_MODEL=openai/gpt-oss-20b
export CHURCHOVERLAY_DATA_DIR="$HOME/.churchoverlay"
```

`GROQ_API_KEY` is accepted as a fallback for `AGENT_API_KEY`. Agent sessions and checkpoints are stored in `data/agent.db` below `CHURCHOVERLAY_DATA_DIR`.

## CLI

```bash
node bin/church-agent.js setup
node bin/church-agent.js config
node bin/church-agent.js ask "Find John 3:16 and prepare it for display"
node bin/church-agent.js chat
node bin/church-agent.js chat service-2026-08-25
node bin/church-agent.js run RUN_ID
```

After a write tool is requested, the run pauses for confirmation. The current WebSocket integration exposes the same lifecycle through `agentEvent`; confirmation UI and `agentResume` calls should be added to the dashboard before enabling automatic live actions.

## Runtime Contract

`ChurchOverlayAgent.run()` is an async generator. It emits `run_started`, `thinking_started`, `tool_requested`, `tool_started`, `tool_completed`, `tool_failed`, `message_delta`, `run_paused`, `run_completed`, and `run_failed`. It never emits private chain-of-thought.

Tools are explicitly registered and have schemas, policies, timeouts, retry limits, and idempotency metadata. Read-only tools are automatic. Public display actions require confirmation by default. Delete, shell, filesystem, and unrestricted database tools are not registered.

## WebSocket

Authenticated operator clients can send:

```json
{
  "action": "agentRun",
  "sessionId": "service-2026-08-25",
  "input": "Find John 3:16"
}
```

The server returns lifecycle messages as `{ "action": "agentEvent", ... }`. A future confirmation control resumes a paused run with `agentResume`, supplying the original `runId` and approved tool-call IDs.

## Development

```bash
npm run test:agent
npm test
npm run type-check
npm run lint
npm run format:check
```

The agent uses the repository's Node.js/CommonJS backend conventions and `better-sqlite3`; no separate Python runtime or agent framework is required.
