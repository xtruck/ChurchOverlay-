'use strict';

class MemoryStore {
  async createSession(_session) {
    throw new Error('MemoryStore.createSession() is not implemented.');
  }
  async getSession(_sessionId) {
    throw new Error('MemoryStore.getSession() is not implemented.');
  }
  async appendMessage(_sessionId, _message) {
    throw new Error('MemoryStore.appendMessage() is not implemented.');
  }
  async listMessages(_sessionId) {
    throw new Error('MemoryStore.listMessages() is not implemented.');
  }
  async createRun(_run) {
    throw new Error('MemoryStore.createRun() is not implemented.');
  }
  async updateRun(_runId, _patch) {
    throw new Error('MemoryStore.updateRun() is not implemented.');
  }
  async getRun(_runId) {
    throw new Error('MemoryStore.getRun() is not implemented.');
  }
  async saveToolCall(_toolCall) {
    throw new Error('MemoryStore.saveToolCall() is not implemented.');
  }
  async getToolCall(_runId, _toolCallId) {
    throw new Error('MemoryStore.getToolCall() is not implemented.');
  }
}

class InMemoryStore extends MemoryStore {
  constructor() {
    super();
    this.sessions = new Map();
    this.messages = new Map();
    this.runs = new Map();
    this.toolCalls = new Map();
  }
  async createSession(session) {
    this.sessions.set(session.id, { ...session });
    return this.sessions.get(session.id);
  }
  async getSession(id) {
    return this.sessions.get(id) || null;
  }
  async appendMessage(id, message) {
    const list = this.messages.get(id) || [];
    list.push({ ...message });
    this.messages.set(id, list);
    return message;
  }
  async listMessages(id) {
    return [...(this.messages.get(id) || [])];
  }
  async createRun(run) {
    this.runs.set(run.id, { ...run });
    return this.runs.get(run.id);
  }
  async updateRun(id, patch) {
    const run = this.runs.get(id);
    if (!run) return null;
    Object.assign(run, patch);
    return { ...run };
  }
  async getRun(id) {
    const run = this.runs.get(id);
    return run ? { ...run } : null;
  }
  async saveToolCall(call) {
    this.toolCalls.set(`${call.runId}:${call.toolCallId}`, { ...call });
    return call;
  }
  async getToolCall(runId, callId) {
    return this.toolCalls.get(`${runId}:${callId}`) || null;
  }
}

module.exports = { MemoryStore, InMemoryStore };
