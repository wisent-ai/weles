import { verifyMicrosoftPassword } from './microsoft/password_lifecycle.mjs';

const result = await verifyMicrosoftPassword();
console.log(`PASS: Microsoft password operation ${result.status}`);
