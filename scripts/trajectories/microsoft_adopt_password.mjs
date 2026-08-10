import { adoptMicrosoftPassword } from './microsoft/password_lifecycle.mjs';

let operation = '';
try {
  const constraints = JSON.parse(process.env.WELES_CREDENTIAL_CONSTRAINTS ?? '{}');
  operation = typeof constraints.operation === 'string' ? constraints.operation : '';
} catch {
  operation = '';
}
if (operation !== 'adopt') {
  throw new Error('microsoft_adopt_password requires an exact adopt contract');
}
process.env.WELES_CREDENTIAL_EXPECTED_OPERATION = operation;
const result = await adoptMicrosoftPassword();
console.log(`PASS: Microsoft password operation ${result.status}`);
