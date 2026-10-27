// Solvecha grid solver against a mocked fetch: an answer in the create
// response, an answer from the waiting read, the 4xx error message, and
// transport failure. Needs the built tree (npm run build).
import assert from 'node:assert/strict';
import { solvechaGridSolve } from '../../dist/captcha/grid/solvecha.js';

const reply = (body, status = 200) => ({ json: async () => body, status });

// 1) The create request already carries the answer.
{
  const calls = [];
  const fetchMock = async (url, init) => {
    calls.push({ url, init });
    return reply({ data: [false, true, false, true, false, false, false, false, true] });
  };
  const got = await solvechaGridSolve('k', 'Select all images with buses', 'B64', 3, fetchMock);
  assert.deepEqual(got, [2, 4, 9]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.solvecha.com/v1/recognition/recaptcha?wait=15');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    task: 'Select all images with buses',
    image_data: ['B64'],
    grid: '3x3',
  });
}

// 2) The job is still open: one waiting read returns the answer.
{
  const calls = [];
  const fetchMock = async (url) => {
    calls.push(url);
    return calls.length === 1 ? reply({ data: 'job-1' }) : reply({ data: [true, false, false, false] });
  };
  const got = await solvechaGridSolve('k', 'x', 'B64', 2, fetchMock);
  assert.deepEqual(got, [1]);
  assert.equal(calls[1], 'https://api.solvecha.com/v1/recognition/recaptcha?id=job-1&wait=20');
}

// 3) A 4xx body is logged and reads as no answer; so does a thrown fetch.
{
  const lines = [];
  const log = console.log;
  console.log = (line) => lines.push(line);
  try {
    const refused = await solvechaGridSolve('k', 'x', 'B64', 3, async () =>
      reply({ errorId: 1, errorCode: 'ERROR_KEY_DENIED', errorDescription: 'Key denied' }, 401),
    );
    assert.equal(refused, null);
    const down = await solvechaGridSolve('k', 'x', 'B64', 3, async () => {
      throw new Error('fetch failed');
    });
    assert.equal(down, null);
  } finally {
    console.log = log;
  }
  assert.match(lines[0], /captcha_solvecha_failed: Key denied/);
  assert.match(lines[1], /captcha_solvecha_failed: fetch failed/);
}
console.log('solvecha-grid: ok');
