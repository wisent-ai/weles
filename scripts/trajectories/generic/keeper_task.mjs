process.env.GENERIC_TASK_LABEL = process.env.GENERIC_TASK_LABEL || 'generic_keeper_task';
process.env.GENERIC_TASK_KEEPER_FIRST = '1';
await import('./browser_task.mjs');
