import { isIP } from 'node:net';

// The plain-text address service is declared by the process that consumes it.
// Resolve at use so missing configuration becomes that operation's diagnostic,
// not a module-import failure that prevents unrelated operations.
export function publicAddressService(): URL {
  const raw = process.env.WELES_PUBLIC_ADDRESS_URL?.trim();
  if (!raw)
    throw new Error(
      'WELES_PUBLIC_ADDRESS_URL is required: declare the HTTPS service that returns the caller address as plain text',
    );
  if (!URL.canParse(raw))
    throw new Error('WELES_PUBLIC_ADDRESS_URL must be an absolute HTTPS URL');
  const service = new URL(raw);
  if (
    service.protocol !== 'https:' ||
    service.username ||
    service.password ||
    service.hash
  )
    throw new Error(
      'WELES_PUBLIC_ADDRESS_URL must use HTTPS without credentials or a fragment',
    );
  return service;
}

/** Both direct and tunneled consumers require a plain-text IP, not a success page. */
export function parsePublicAddress(body: string, service: URL): string {
  const address = body.trim();
  if (!isIP(address))
    throw new Error(
      `${service} answered no IP address: ${JSON.stringify(body)}`,
    );
  return address;
}
