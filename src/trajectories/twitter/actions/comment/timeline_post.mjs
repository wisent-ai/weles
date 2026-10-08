// One tweet, picked at random from every tweet a captured timeline response
// holds, whole. The tweets are read from the response's structure (each
// object's `full_text`), not by a pattern with invented length bounds over its
// first few matches. A missing response or one without tweets is refused with
// what was looked for; runAction logs a pickPost refusal and carries on.
export function pickTimelinePost(capturedResponses, urlPattern) {
  const response = capturedResponses.find((r) => urlPattern.test(r.url));
  if (!response)
    throw new Error(
      `no captured response matched ${urlPattern}, so there is no post to answer`,
    );
  const texts = [];
  const visit = (node) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (typeof node.full_text === 'string') texts.push(node.full_text);
    Object.values(node).forEach(visit);
  };
  visit(JSON.parse(response.body));
  if (!texts.length)
    throw new Error(`the captured ${response.url} holds no tweet text`);
  return {
    postTitle: texts[Math.floor(Math.random() * texts.length)],
    postBody: '',
  };
}
