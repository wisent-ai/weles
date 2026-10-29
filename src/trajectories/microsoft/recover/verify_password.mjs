import { verifyMicrosoftPassword } from '../password_lifecycle.mjs';

const result = await verifyMicrosoftPassword();
if (result.status === 'operation_failed')
  throw new Error(
    `microsoft_verify_password failed: ${JSON.stringify(result)}`,
  );
console.log(`PASS: Microsoft password ${result.status}`);
