import { verifyEntraPassword } from './microsoft/entra_password_lifecycle.mjs';

let operation = '';
try {
  const constraints = JSON.parse(process.env.WELES_CREDENTIAL_CONSTRAINTS ?? '{}');
  operation = typeof constraints.operation === 'string' ? constraints.operation : '';
} catch {
  operation = '';
}
if (operation !== 'verify') {
  throw new Error('microsoft_entra_verify_password requires an exact verify contract');
}
process.env.WELES_CREDENTIAL_EXPECTED_OPERATION = operation;
const result = await verifyEntraPassword();
if (result.status === 'operation_failed') {
  console.error(`FAIL: microsoft_entra_verify_password ${result.code ?? 'operation_failed'} at ${result.phase ?? 'unknown'}`);
  process.exitCode = 'x'.length;
} else {
  console.log(`PASS: Entra password ${operation} ${result.status}`);
}
