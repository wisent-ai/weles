// The shape every Weles MCP tool declaration takes, and the one JSON schema
// builder they share: an object of named properties, closed to others.

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
