import { rotateMicrosoftPassword } from './microsoft/password_lifecycle.mjs';

let operation = '';
try {
  const constraints = JSON.parse(process.env.WELES_CREDENTIAL_CONSTRAINTS ?? '{}');
  operation = typeof constraints.operation === 'string' ? constraints.operation : '';
} catch {
  operation = '';
}
if (operation !== 'rotate') {
  throw new Error('microsoft_reset_password requires an exact rotate contract');
}
process.env.WELES_CREDENTIAL_EXPECTED_OPERATION = operation;
const result = await rotateMicrosoftPassword();
console.log(`PASS: Microsoft password operation ${result.status}`);
