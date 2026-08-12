#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSecretAcquisitionPlan } from '../../dist/secrets/acquire.js';

const accountEmail = process.env.FIGMA_ACCOUNT_EMAIL?.trim().toLowerCase();
if (!accountEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(accountEmail)) {
  throw new Error('FIGMA_ACCOUNT_EMAIL must be one exact account email');
}

const requestId = randomBytes(32).toString('hex');
const plan = buildSecretAcquisitionPlan({
  operation: 'acquire',
  secret: 'figma.personal_access_token',
  purpose: 'design-assets-export',
  accountEmail,
  requestId,
  headless: process.env.HEADLESS === '1',
  autoPromoteTrajectory: false,
});
if (plan.status !== 'operation_plan' || !plan.params || !plan.url || !plan.objective) {
  throw new Error(`Figma token acquisition plan is unavailable: ${plan.status}`);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const trajectory = join(scriptDir, '..', 'trajectories', 'generic', 'browser_task.mjs');
const result = spawnSync(process.execPath, [trajectory], {
  env: {
    ...process.env,
    GENERIC_TASK_URL: plan.url,
    GENERIC_TASK_OBJECTIVE: plan.objective,
    GENERIC_TASK_CONSTRAINTS: JSON.stringify(plan.params.constraints),
    GENERIC_TASK_FLOW_NAME: String(plan.params.flow_name),
    GENERIC_TASK_KEEPER_FIRST: '1',
    GENERIC_TASK_SKIP_SAVED_FLOW_REPLAY: '1',
    GENERIC_TASK_LABEL: 'figma_personal_access_token',
    GENERIC_TASK_HEADLESS: plan.params.headless ? '1' : '0',
    GENERIC_TASK_PROXY: String(plan.params.proxy ?? 'none'),
  },
  stdio: 'inherit',
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Figma token acquisition failed with exit ${result.status}`);
