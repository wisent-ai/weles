// One launcher startup step, run through the launcher's own `run`, so the
// lines it writes around a step can be read by a test from the outside: the
// program it runs is this very Node asked for its version, and the step's
// answer is printed last, after the launcher's own began/ended lines. The
// step's label is the one the caller names in WELES_TEST_STEP_LABEL.
import { run } from '../../src/worker/weles-api-launcher/running.mjs';

const label = process.env.WELES_TEST_STEP_LABEL;
if (!label) throw new Error('WELES_TEST_STEP_LABEL must name the step');
const answer = run(process.execPath, ['--version'], label);
process.stdout.write(`answer ${answer}\n`);
