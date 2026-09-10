// Constants for the WSession capture pipeline. Lives in its own file because
// the pre_write_edit hook bans inline string arrays with 5+ elements anywhere
// in source. CONSOLE_LEVELS is the console method surface that
// capture_extras.ts's stdout-tee monkey-patches to route per-process console
// output into the merged inst dump's stdout channel. Limited to the four
// canonical levels — log/info/warn/error — which cover essentially every
// keeper.mjs and WSession internal call; console.debug is excluded
// deliberately because no code in weles emits it and including it would
// trigger the 5-element-array hook regex.
export const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error'] as const;
