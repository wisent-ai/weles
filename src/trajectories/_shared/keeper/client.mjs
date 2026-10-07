// One request to a running keeper session over its unix socket, answered by
// the keeper's single JSON line. There is no clock: a request ends when the
// keeper answers, closes the connection, or the socket fails, and that is the
// outcome the caller gets.
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function keeperSocket(session) {
  return join(homedir(), '.weles', 'keeper', session, 'socket');
}

// The keeper's answer as it sent it, `ok` flag included; the caller decides
// what a refusal means for it.
export function keeperRequest(socket, cmd) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const conn = net.createConnection(socket);
  let buf = '';
  let done = false;
  conn.on('connect', () => conn.write(`${JSON.stringify(cmd)}\n`));
  conn.on('data', (chunk) => {
    buf += chunk.toString();
    const nl = buf.indexOf('\n');
    if (nl < 0 || done) return;
    done = true;
    conn.end();
    try {
      resolve(JSON.parse(buf.slice(0, nl)));
    } catch (error) {
      reject(
        new Error(
          `keeper answered ${cmd.action} with unreadable JSON: ${error.message}`,
        ),
      );
    }
  });
  conn.on('end', () => {
    if (done) return;
    done = true;
    reject(
      new Error(
        `keeper at ${socket} closed the connection before answering ${cmd.action}`,
      ),
    );
  });
  conn.on('error', (error) => {
    if (done) return;
    done = true;
    reject(
      new Error(
        `keeper at ${socket} could not be asked ${cmd.action}: ${error.message}`,
      ),
    );
  });
  return promise;
}
