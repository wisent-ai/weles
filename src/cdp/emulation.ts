import { CDPConnection } from './connection.js';

/**
 * Set the browser user-agent override via Emulation.setUserAgentOverride.
 */
export async function setUserAgent(
  conn: CDPConnection,
  sessionId: string,
  userAgent: string,
  platform?: string,
  acceptLanguage?: string,
): Promise<void> {
  const params: Record<string, any> = { userAgent };
  if (platform !== undefined) params.platform = platform;
  if (acceptLanguage !== undefined) params.acceptLanguage = acceptLanguage;
  await conn.send('Emulation.setUserAgentOverride', params, sessionId);
}

/**
 * Set the device viewport via Emulation.setDeviceMetricsOverride.
 */
export async function setViewport(
  conn: CDPConnection,
  sessionId: string,
  width: number,
  height: number,
  deviceScaleFactor?: number,
  mobile?: boolean,
): Promise<void> {
  await conn.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width,
      height,
      deviceScaleFactor: deviceScaleFactor ?? 1,
      mobile: mobile ?? false,
    },
    sessionId,
  );
}
