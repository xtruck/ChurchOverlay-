#!/usr/bin/env node
'use strict';

const readline = require('readline');
const path = require('path');
const os = require('os');
const { createChurchOverlayAgent } = require('../ai-agent');
const bibleLookup = require('../bible-lookup-with-api');
const detector = require('../detector-compat');
const sessionState = require('../session-state');
const songLibrary = require('../song-library');
const mediaLibrary = require('../media-library');
const sceneStore = require('../scene-store');
const { SQLiteMemoryStore } = require('../ai-agent/memory/sqlite');

const userDataDir = process.env.CHURCHOVERLAY_DATA_DIR || path.join(os.homedir(), '.churchoverlay');
for (const store of [songLibrary, mediaLibrary, sceneStore]) store.setUserDataDir(userDataDir);
const services = {
  bibleLookup,
  detector,
  songLibrary,
  mediaLibrary,
  sceneStore,
  sessionState,
  broadcast: (payload) => console.log(JSON.stringify({ action: payload.action, ...payload })),
};

function createAgent() {
  return createChurchOverlayAgent({ userDataDir, services });
}

async function streamRun(agent, options) {
  let runId = null;
  for await (const event of agent.run(options)) {
    runId = event.runId || runId;
    if (event.type === 'message_delta') process.stdout.write(event.text);
    else if (event.type === 'tool_requested') console.log(`\nTool requested: ${event.name}`);
    else if (event.type === 'run_paused')
      console.log(
        `\nRun paused for confirmation. Resume with run ${event.runId} and tool call ${event.toolCallId}.`
      );
    else if (event.type === 'run_completed')
      console.log(
        `\nCompleted (${event.usage.toolCalls} tool calls, ${event.usage.durationMs}ms).`
      );
    else if (event.type === 'run_failed') console.error(`\nFailed: ${event.error}`);
  }
  return runId;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'ask')
    return streamRun(createAgent(), {
      sessionId: `cli-${new Date().toISOString().slice(0, 10)}`,
      input: args.join(' '),
    });
  if (command === 'chat') return chat(args[0]);
  if (command === 'run') {
    const store = new SQLiteMemoryStore(userDataDir);
    console.log(JSON.stringify(await store.getRun(args[0]), null, 2));
    store.close();
    return;
  }
  if (command === 'config')
    return console.log(
      JSON.stringify(
        {
          dataDir: userDataDir,
          provider: process.env.AGENT_PROVIDER || 'groq-compatible',
          model: process.env.AGENT_MODEL || 'openai/gpt-oss-20b',
          apiKeyConfigured: !!(process.env.AGENT_API_KEY || process.env.GROQ_API_KEY),
        },
        null,
        2
      )
    );
  if (command === 'setup')
    return console.log(
      'Set AGENT_API_KEY (or GROQ_API_KEY), AGENT_MODEL, and CHURCHOVERLAY_DATA_DIR in the environment.'
    );
  console.log(
    'Usage: church-agent ask <request> | chat [session-id] | run <run-id> | config | setup'
  );
}

async function chat(sessionId = `cli-${new Date().toISOString().slice(0, 10)}`) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'church-agent> ',
  });
  const agent = createAgent();
  console.log(`Session: ${sessionId}`);
  rl.prompt();
  for await (const line of rl) {
    if (line.trim() === '/exit') break;
    if (line.trim()) await streamRun(agent, { sessionId, input: line.trim() });
    rl.prompt();
  }
  rl.close();
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
