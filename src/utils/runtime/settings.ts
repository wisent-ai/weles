// The settings a Weles process reads by name: each one stated, or refused with
// the name of the setting and what is wrong with the value it holds. Every
// bound below is read from the standard that sets it, not written down.
import { createHash } from 'node:crypto';

/**
 * The shortest secret a setting accepts: as many bytes as a SHA-256 digest.
 * Weles signs and compares its tokens with HMAC-SHA256, and RFC 2104
 * section 3 strongly discourages a key shorter than the hash output
 * (https://www.rfc-editor.org/rfc/rfc2104#section-3).
 */
export const MIN_SECRET_BYTES = createHash('sha256').digest().length;

/** The value of `name`, trimmed, or the refusal naming it when it is unset or blank. */
export function requiredSetting(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing required ${name}`);
  return value;
}

/** The value of `name`, trimmed, or null when the setting is unset or blank. */
export function optionalSetting(
  env: NodeJS.ProcessEnv,
  name: string,
): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/** The secret `name` holds, refused when it is shorter than {@link MIN_SECRET_BYTES}. */
export function secretSetting(env: NodeJS.ProcessEnv, name: string): string {
  const secret = requiredSetting(env, name);
  const bytes = Buffer.byteLength(secret);
  if (bytes < MIN_SECRET_BYTES) {
    throw new Error(
      `${name} holds ${bytes} bytes; a secret needs at least ${MIN_SECRET_BYTES}, the length of a SHA-256 digest (RFC 2104 section 3)`,
    );
  }
  return secret;
}

/**
 * The TCP port `name` holds. A port is a 16-bit field of the TCP header
 * (RFC 9293 section 3.1, https://www.rfc-editor.org/rfc/rfc9293#section-3.1),
 * so a value is a port exactly when the 16-bit array keeps it unchanged; port
 * zero is reserved (RFC 6335 section 6) and names no port to listen on.
 */
export function tcpPortSetting(env: NodeJS.ProcessEnv, name: string): number {
  const raw = requiredSetting(env, name);
  const port = Number(raw);
  const [field] = Uint16Array.of(port);
  if (field !== port || !port) {
    throw new Error(
      `${name} is ${JSON.stringify(raw)}, not a TCP port (a whole number a 16-bit port field holds, zero excepted)`,
    );
  }
  return port;
}

/** A whole number of `unit` above zero that `name` holds. */
export function positiveWholeSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  unit: string,
): number {
  const raw = requiredSetting(env, name);
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count !== Math.abs(count) || !count) {
    throw new Error(
      `${name} is ${JSON.stringify(raw)}, not a whole number of ${unit} above zero`,
    );
  }
  return count;
}
