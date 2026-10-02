function responseDetails(response, operation) {
  return { operation, requestUrl: response.url(), httpStatus: response.status() };
}

export async function readDiscordText(response, operation, errorPrefix) {
  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw Object.assign(new Error(`${errorPrefix}_RESPONSE_READ_FAILED`, { cause }), responseDetails(response, operation));
  }
  if (!response.ok()) {
    throw Object.assign(new Error(`${errorPrefix}_HTTP_REFUSED: HTTP ${response.status()}: ${text}`),
      responseDetails(response, operation), { responseBody: text });
  }
  return text;
}

export async function readDiscordReply(response, operation, errorPrefix) {
  const text = await readDiscordText(response, operation, errorPrefix);
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw Object.assign(new Error(`${errorPrefix}_RESPONSE_INVALID`, { cause }),
      responseDetails(response, operation), { responseBody: text });
  }
}

export async function readDiscordNoContent(response, operation, errorPrefix) {
  const text = await readDiscordText(response, operation, errorPrefix);
  if (response.status() !== 204 || text !== '') {
    throw Object.assign(new Error(`${errorPrefix}_UNCONFIRMED: expected an empty HTTP 204 acknowledgement; reconcile before another attempt`),
      responseDetails(response, operation), { responseBody: text });
  }
}
