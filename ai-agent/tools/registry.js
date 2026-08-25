'use strict';

class ToolRegistry {
  constructor(tools = []) {
    this.tools = new Map();
    for (const tool of tools) this.register(tool);
  }

  register(tool) {
    if (!tool || typeof tool.name !== 'string' || typeof tool.run !== 'function')
      throw new Error('Invalid tool.');
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return tool;
  }

  get(name) {
    return this.tools.get(name) || null;
  }
  list() {
    return Array.from(this.tools.values());
  }
  definitions() {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }
}

module.exports = { ToolRegistry };
