// The Probierz benchmark contract every Weles benchmark contender speaks: one
// ai.wisent.probierz.benchmark.task.v1 document on stdin, one
// ai.wisent.probierz.benchmark.result.v1 document on stdout. The fixture
// origin is substituted from WELES_BENCHMARK_FIXTURE_ORIGIN, so the suite
// names no host.

const TASK_SCHEMA = "ai.wisent.probierz.benchmark.task.v1";
const RESULT_SCHEMA = "ai.wisent.probierz.benchmark.result.v1";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is not set; declare it in benchmark.contenders.<id>.env and set it on the host that runs the benchmark`);
  }
  return value.trim();
}

function substitute(value, origin) {
  if (typeof value === "string") return value.replaceAll("${FIXTURE_ORIGIN}", origin);
  if (Array.isArray(value)) return value.map((item) => substitute(item, origin));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, origin)]));
  }
  return value;
}

/// The task, with the fixture origin filled in and the prompt an agent reads.
export async function readTask() {
  const task = JSON.parse(await readStdin());
  if (task.schema !== TASK_SCHEMA) throw new Error(`stdin schema is ${task.schema}, expected ${TASK_SCHEMA}`);
  const origin = required("WELES_BENCHMARK_FIXTURE_ORIGIN");
  const input = substitute(task.case.input, origin);
  const prompt = [
    task.case.instruction,
    `Start at ${input.url}.`,
    `Task input: ${JSON.stringify(input)}`,
    "Answer only with the JSON object the instruction asks for.",
  ].join("\n");
  return { task, input, prompt };
}

/// The first JSON object an agent's answer holds: the whole text, a fenced
/// block, or the first balanced object in it.
export function answerObject(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") throw new Error("the agent returned no answer");
  const candidates = [value.trim()];
  for (const match of value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  const start = value.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let index = start; index < value.length; index += 1) {
      if (value[index] === "{") depth += 1;
      if (value[index] === "}") depth -= 1;
      if (depth === 0) {
        candidates.push(value.slice(start, index + 1));
        break;
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // the next candidate is tried; the refusal below names the answer
    }
  }
  throw new Error(`the agent's answer holds no JSON object: ${value.slice(0, 400)}`);
}

export function answer(result) {
  process.stdout.write(JSON.stringify({ schema: RESULT_SCHEMA, ...result }));
}

/// Run one contender body; a refusal becomes a failed result with its reason,
/// so the run records why instead of a bare exit status.
export async function contend(body) {
  try {
    answer({ status: "completed", ...(await body(await readTask())) });
  } catch (error) {
    answer({ status: "failed", error: String(error?.stack || error) });
  }
}
