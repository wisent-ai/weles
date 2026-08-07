import { resetEntraPassword } from './microsoft/entra_password_lifecycle.mjs';

let operation = '';
try {
  const constraints = JSON.parse(process.env.WELES_CREDENTIAL_CONSTRAINTS ?? '{}');
  operation = typeof constraints.operation === 'string' ? constraints.operation : '';
} catch {
  operation = '';
}
if (operation !== 'rotate' && operation !== 'reset') {
  throw new Error('microsoft_entra_reset_password requires an exact rotate or reset contract');
}
process.env.WELES_CREDENTIAL_EXPECTED_OPERATION = operation;
const result = await resetEntraPassword();
if (result.status === 'operation_failed') {
  console.error(`FAIL: microsoft_entra_reset_password ${result.code ?? 'operation_failed'} at ${result.phase ?? 'unknown'}`);
  process.exitCode = 'x'.length;
} else {
  console.log(`PASS: Entra password ${operation} ${result.status}`);
}
