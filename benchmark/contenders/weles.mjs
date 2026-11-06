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
  } catch (error) {
    throw new Error(`${endpoint} answered HTTP ${response.status} with a body that is not JSON (${error.message}): ${text}`);
  }
  if (!response.ok) {
    throw new Error(`${endpoint} answered HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  if (payload.ok !== true) {
    const run = "run_id" in payload ? `run ${payload.run_id}` : "a run whose answer names no run_id";
    throw new Error(`${endpoint} ended ${run} without its value (ok is ${JSON.stringify(payload.ok)}), so the task has no answer to score; the run's own answer says why: ${JSON.stringify(payload)}`);
  }
  const steps = payload.trajectory_draft?.steps;
  return {
    output: answerObject(payload.value),
    ...(Array.isArray(steps) ? { steps: steps.length } : {}),
  };
});
