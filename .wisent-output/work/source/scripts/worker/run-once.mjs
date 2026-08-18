#!/usr/bin/env node
import { pollOnce } from '../../dist/worker/poll.js';
const outcome = await pollOnce();
process.stdout.write(`${outcome}\n`);
process.exit(outcome === 'error' ? 1 : 0);
