export async function readDiscordReply(response, operation, errorPrefix) {
  const details = { operation, requestUrl: response.url(), httpStatus: response.status() };
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw Object.assign(new Error(`${errorPrefix}_RESPONSE_READ_FAILED`, { cause }), details);
  }
  if (!response.ok()) throw Object.assign(new Error(`${errorPrefix}_HTTP_REFUSED: HTTP ${response.status()}: ${text}`), details);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw Object.assign(new Error(`${errorPrefix}_RESPONSE_INVALID`, { cause }), details, { responseBody: text });
  }
}
