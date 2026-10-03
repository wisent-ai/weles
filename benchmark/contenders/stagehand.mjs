#!/usr/bin/env node
// Stagehand as a benchmark rival: its DOM agent drives a headless local
// browser on the benchmark host, and its model calls go through Brama's
// OpenAI-compatible endpoint with a workload-scoped bearer. The packages are
// resolved from STAGEHAND_MODULES, the node_modules directory the benchmark
// host installed them into, so Weles itself carries no rival's code.

import { createRequire } from "node:module";
import path from "node:path";
import { answerObject, contend, required } from "./task.mjs";

await contend(async ({ input, prompt }) => {
  const load = createRequire(path.join(required("STAGEHAND_MODULES"), "index.js"));
  const { AISdkClient, Stagehand } = load("@browserbasehq/stagehand");
  const { createOpenAI } = load("@ai-sdk/openai");
  const model = createOpenAI({
    apiKey: required("BRAMA_API_KEY"),
    baseURL: required("BRAMA_BASE_URL"),
  }).chat(required("BRAMA_MODEL"));
  const llmClient = Object.assign(new AISdkClient({ model }), { getLanguageModel: () => model });
  const stagehand = new Stagehand({
    env: "LOCAL",
    llmClient,
    localBrowserLaunchOptions: { headless: true, executablePath: required("BROWSER_EXECUTABLE_PATH") },
    disableAPI: true,
    experimental: true,
    disablePino: true,
    verbose: 0,
  });
  try {
    await stagehand.init();
    const page = await stagehand.context.awaitActivePage();
    await page.goto(input.url, { waitUntil: "load" });
    const result = await stagehand.agent({ mode: "dom" }).execute({ instruction: prompt, page });
    if (!result.success || !result.completed) {
      throw new Error(`Stagehand did not complete the task: ${result.message}`);
    }
    return {
      output: answerObject(result.message),
      steps: result.actions.length,
      ...(result.usage ? { tokens: result.usage.input_tokens + result.usage.output_tokens } : {}),
    };
  } finally {
    await stagehand.close({ force: true });
  }
});
