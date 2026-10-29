// Run the real process-owned machine capture to network settlement. The parent
// journey supplies the service environment and retains this process's output.
import { machinePublicAddress } from '../../dist/diagnostics/versions/machine.js';
import { captureFailures } from '../../dist/diagnostics/versions/failures.js';

// Machine capture is intentionally asynchronous and started once at module load.
// beforeExit observes its final state after real network work, without polling,
// timers, replacing fetch or exposing a new production control surface.
process.once('beforeExit', () => {
  console.log(
    JSON.stringify({
      public_ip: machinePublicAddress(),
      failures: captureFailures.filter(
        (failure) => failure.field === 'machine.public_ip',
      ),
    }),
  );
});
