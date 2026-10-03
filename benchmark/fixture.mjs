#!/usr/bin/env node
// The deterministic site the web-agent-v1 cases run against. Run it on the
// Stado-selected benchmark host, beside the contenders, and give its origin
// to them as WELES_BENCHMARK_FIXTURE_ORIGIN:
//
//   benchmark/fixture.mjs --host <loopback address> --port <port>
//
// It prints one JSON line with the address it bound and serves until SIGINT
// or SIGTERM. Never expose the plain HTTP fixture to the internet.

import { createServer } from "node:http";
import { parseArgs } from "node:util";

const BODY_LIMIT = 16 * 1024;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function write(response, status, body, contentType) {
  response.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": contentType });
  response.end(body);
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;max-width:60rem;margin:3rem auto;padding:0 1rem}nav{display:flex;gap:1rem}table{border-collapse:collapse}th,td{border:1px solid #aaa;padding:.35rem}</style></head><body>${body}</body></html>`;
}

function html(response, body) {
  write(response, 200, body, "text/html; charset=utf-8");
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

async function requestBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new Error("fixture request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The dynamic page renders "pending" and replaces it once a second request to
// this server answers, so an agent must wait for client-side rendering.
const dynamicScript = 'fetch("/dynamic/message").then((reply) => reply.text()).then((text) => { document.getElementById("message").textContent = text; document.body.dataset.ready = "true"; });';

const pages = {
  "GET /": () => page("Weles Benchmark Fixture", '<h1>Weles Benchmark Fixture</h1><nav><a href="/static">Static</a><a href="/navigation">Navigation</a><a href="/form">Form</a><a href="/dynamic">Dynamic</a><a href="/table">Table</a></nav>'),
  "GET /static": () => page("Static content", '<main data-benchmark="static" data-checksum="alpha-beta-gamma"><h1>Static content</h1><ul><li>alpha</li><li>beta</li><li>gamma</li></ul><p>Deterministic fixture</p></main>'),
  "GET /navigation": () => page("Navigation", '<main><h1>Record index</h1><a href="/detail?id=record-42" data-record-id="record-42">Open canonical record</a></main>'),
  "GET /form": () => page("Form", '<main><h1>Deterministic form</h1><form method="post" action="/form"><label>Benchmark value <input name="value" autocomplete="off" required></label><button type="submit">Submit</button></form></main>'),
  "GET /dynamic": () => page("Dynamic render", `<main><h1>Dynamic render</h1><output id="message" aria-live="polite">pending</output><script>${dynamicScript}</script></main>`),
  "GET /table": () => {
    const rows = Array.from({ length: 100 }, (_, index) => `<tr><th scope="row">${index + 1}</th><td>value-${String(index + 1).padStart(3, "0")}</td></tr>`).join("");
    return page("Table scan", `<main><h1>Table scan</h1><table><thead><tr><th>Index</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></main>`);
  },
};

async function route(request, response) {
  const url = new URL(request.url, "http://fixture.invalid");
  const key = `${request.method} ${url.pathname}`;
  if (key === "GET /dynamic/message") {
    return write(response, 200, "rendered-after-delay", "text/plain; charset=utf-8");
  }
  if (key === "GET /detail" && url.searchParams.get("id") === "record-42") {
    return html(response, page("Record 42", '<main data-record-id="record-42"><h1>Record 42</h1><output name="value">deterministic-detail</output></main>'));
  }
  if (key === "POST /form") {
    const value = new URLSearchParams(await requestBody(request)).get("value");
    if (value === null) return write(response, 400, "the form carries no value field", "text/plain; charset=utf-8");
    return html(response, page("Submitted", `<main data-submitted="true"><h1>Submitted</h1><output name="value">${escapeHtml(value)}</output></main>`));
  }
  const render = pages[key];
  if (render) return html(response, render());
  return write(response, 404, `no fixture route ${key}`, "text/plain; charset=utf-8");
}

const { values } = parseArgs({ options: { host: { type: "string" }, port: { type: "string" } } });
if (!values.host || !values.port || !/^\d+$/.test(values.port)) {
  process.stderr.write("usage: benchmark/fixture.mjs --host <address> --port <port>\n");
  process.exit(2);
}
const server = createServer((request, response) => {
  route(request, response).catch((error) => {
    if (response.headersSent) response.destroy(error);
    else write(response, 500, `fixture error: ${error.message}`, "text/plain; charset=utf-8");
  });
});
server.on("error", (error) => {
  process.stderr.write(`fixture could not listen on ${values.host}:${values.port}: ${error.message}\n`);
  process.exit(1);
});
server.listen(Number(values.port), values.host, () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ schema: "weles.benchmark.fixture.v1", host: values.host, port: address.port })}\n`);
});
process.once("SIGINT", () => server.close());
process.once("SIGTERM", () => server.close());
