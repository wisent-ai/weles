#!/opt/homebrew/bin/node
import { chmodSync, copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const home = process.env.HOME ?? '';
if (!home.startsWith('/')) throw new Error('HOME must be an absolute path');

function replaceFile(path, content) {
  const temporary = join(dirname(path), `.${path.split('/').pop()}.${process.pid}.tmp`);
  writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

const stagedRoutes = join(home, '.stado/files/weles-capability-routes.json');
const activeRoutes = join(home, '.stado/weles-api-capability-routes.json');
const routeTemporary = `${activeRoutes}.${process.pid}.tmp`;
copyFileSync(stagedRoutes, routeTemporary);
chmodSync(routeTemporary, 0o600);
renameSync(routeTemporary, activeRoutes);

const environmentPath = join(home, '.config/weles/worker.env');
const socketAssignment = `SKARBIEC_CAP_SOCKET=${join(home, '.stado/run/weles-api-capability.sock')}`;
const lines = readFileSync(environmentPath, 'utf8').split(/\r?\n/);
const retained = lines.filter((line) => line && !line.startsWith('SKARBIEC_CAP_SOCKET='));
retained.push(socketAssignment);
replaceFile(environmentPath, `${retained.join('\n')}\n`);

console.log(JSON.stringify({ status: 'configured', capability_routes: activeRoutes, worker_environment: environmentPath }));
