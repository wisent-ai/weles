import { CDPConnection } from './connection.js';

/**
 * Set the browser user-agent override via Emulation.setUserAgentOverride.
 * The platform and Accept-Language are overridden only when given.
 */
export async function setUserAgent(
  conn: CDPConnection,
  sessionId: string,
  userAgent: string,
  platform?: string,
  acceptLanguage?: string,
): Promise<void> {
  const params: {
    userAgent: string;
    platform?: string;
    acceptLanguage?: string;
  } = { userAgent };
  if (platform !== undefined) params.platform = platform;
  if (acceptLanguage !== undefined) params.acceptLanguage = acceptLanguage;
  await conn.send('Emulation.setUserAgentOverride', params, sessionId);
}

/**
 * Set the device viewport via Emulation.setDeviceMetricsOverride. The scale
 * factor and whether the device is mobile come from the device being
 * presented: a default would present a device nobody chose, and a scale
 * factor that disagrees with the user agent is itself a fingerprint.
 */
export async function setViewport(
  conn: CDPConnection,
  sessionId: string,
  width: number,
  height: number,
  deviceScaleFactor: number,
  mobile: boolean,
): Promise<void> {
  await conn.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor, mobile },
    sessionId,
  );
}
