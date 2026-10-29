// `weles pointer`: the recorded pointer travel every move replays.
//
//   weles pointer harvest <run>.inst.json... [--json]
//       harvest the travel between presses and the wheel steps from the named
//       instrumentation dumps of runs a person drove, into
//       $WELES_RECORDINGS_ROOT/pointer-trace.json
//   weles pointer show [--json]
//       what the trace holds and where it came from
import type { ParsedCli } from '../cli.js';
import { harvestPointerTrace } from '../human/pointer/harvest.js';
import {
  pointerTracePath,
  readPointerTrace,
  writePointerTrace,
} from '../human/pointer/trace-file.js';
import { printAnswer, UsageError } from './usage.js';

const USAGE =
  'pointer takes: harvest <run>.inst.json... [--json] | show [--json]';

export async function runPointer(parsed: ParsedCli): Promise<void> {
  const [verb, ...sources] = parsed.positional;
  if (verb !== 'harvest' && verb !== 'show')
    throw new UsageError(`weles pointer takes harvest, show, not ${verb}`);
  if (Object.keys(parsed.options).some((key) => key !== 'json'))
    throw new UsageError(USAGE);
  const json = parsed.options.json === true;
  if (verb === 'harvest') {
    if (!sources.length) throw new UsageError(USAGE);
    const trace = harvestPointerTrace(sources);
    const path = writePointerTrace(trace);
    printAnswer(
      {
        path,
        sources: trace.sources,
        segments: trace.segments.length,
        wheel_steps: trace.wheel.length,
      },
      json,
    );
    return;
  }
  if (verb === 'show' && !sources.length) {
    const trace = readPointerTrace();
    printAnswer(
      {
        path: pointerTracePath(),
        sources: trace.sources,
        segments: trace.segments.length,
        wheel_steps: trace.wheel.length,
      },
      json,
    );
    return;
  }
  throw new UsageError(USAGE);
}
