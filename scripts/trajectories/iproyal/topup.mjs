// IPRoyal topup. Inherits the login blocker from iproyal/balance.mjs —
// Google GSI storagerelay popup completes but main page never authenticates.
console.log('FAIL: IPRoyal topup blocked at login. Google GSI storagerelay popup completes login but the postMessage handshake to the opener page is being blocked in our Chromium context, so the main dashboard never authenticates. Resolve iproyal/balance.mjs first; this trajectory inherits the same blocker.');
process.exit(1);
