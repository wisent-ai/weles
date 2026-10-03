#!/usr/bin/env node
// Weles as a benchmark contender: the task's prompt goes to the authenticated
// /weles-builder endpoint, which runs it synchronously on the Weles worker and
// answers the extracted value and the trajectory it drafted.

import { answerObject, contend, required } from "./task.mjs";

await contend(async ({ prompt }) => {
  const endpoint = new URL("/weles-builder", required("WELES_API_BASE"));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${required("WELES_TOKEN")}`,
    },
    body: JSON.stringify({ instructions: prompt }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${endpoint} answered HTTP ${response.status} with a body that is not JSON: ${text.slice(0, 400)}`);
  }
  if (!response.ok) {
    throw new Error(`${endpoint} answered HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  if (payload.ok !== true) {
    throw new Error(`Weles run ${payload.run_id ?? "(no run id)"} did not succeed: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  const steps = payload.trajectory_draft?.steps;
  return {
    output: answerObject(payload.value),
    ...(Array.isArray(steps) ? { steps: steps.length } : {}),
  };
});
