import net from 'node:net';
import { createInterface } from 'node:readline';

export function keeperControl(
  socket: string,
  session: string,
  action: 'status' | 'stop',
): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const connection = net.createConnection(socket);
  const lines = createInterface({ input: connection });
  let answered = false;
  connection.on('connect', () =>
    connection.write(`${JSON.stringify({ action })}\n`),
  );
  lines.once('line', (line) => {
    answered = true;
    try {
      const answer = JSON.parse(line);
      if (!answer || typeof answer !== 'object' || answer.ok !== true)
        throw new Error(`keeper ${session} ${action} refused: ${line}`);
      if (answer.session !== session)
        throw new Error(
          `keeper ${action} at ${socket} answered for another session`,
        );
      resolve(answer);
    } catch (error) {
      reject(error);
    } finally {
      connection.destroy();
    }
  });
  connection.on('error', (error) => {
    answered = true;
    reject(
      new Error(`keeper ${session} ${action} at ${socket}: ${error.message}`),
    );
  });
  connection.on('close', () => {
    lines.close();
    if (!answered)
      reject(
        new Error(
          `keeper ${session} ${action} at ${socket}: connection closed without a result`,
        ),
      );
  });
  return promise;
}
