/**
 * Weles agent layer — tool-use loop + declarative task API.
 */

// Authenticated Stado-routed tool-use loop (screenshot → model → dispatch → repeat)
export { execute, AgentFailure, parseJsonFrom } from './loop.js';
export type { ToolCall, LoopResult } from './loop.js';
export { dispatch } from './tools.js';

// Declarative task API
export { FetchAccountValue, Trajectory } from './tasks.js';

// Vision extractors
export * as vision from './vision.js';
export * as login from './login.js';
export * as discover from './discover.js';
