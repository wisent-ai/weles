import { adoptEntraPassword } from './microsoft/entra_password_lifecycle.mjs';

let operation = '';
try {
  const constraints = JSON.parse(process.env.WELES_CREDENTIAL_CONSTRAINTS ?? '{}');
  operation = typeof constraints.operation === 'string' ? constraints.operation : '';
} catch {
  operation = '';
}
if (operation !== 'adopt') {
  throw new Error('microsoft_entra_adopt_password requires an exact adopt contract');
}
process.env.WELES_CREDENTIAL_EXPECTED_OPERATION = operation;
const result = await adoptEntraPassword();
if (result.status === 'operation_failed') {
  console.error(`FAIL: microsoft_entra_adopt_password ${result.code ?? 'operation_failed'} at ${result.phase ?? 'unknown'}`);
  process.exitCode = 'x'.length;
} else {
  console.log(`PASS: Entra password ${operation} ${result.status}`);
}
