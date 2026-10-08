// Complete one OAuth authorization a coding-agent harness started for a
// Claude account the pool holds, and print the redirect for that harness.
import { authorizeForHarness } from '../../_shared/subscription-auth/run.mjs';

await authorizeForHarness('claude');
