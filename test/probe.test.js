import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRtt } from '../src/probe.js';

test('round-trip summary: median, jitter over the fastest trip, timeouts as lost', () => {
  const samples = [12, 10, 11, 30, 13, 10, 14, 12, 11, Infinity, 50];
  const r = summarizeRtt(samples);
  assert.equal(r.median, 12);
  assert.equal(r.jitter, 30 - 10);
  assert.equal(r.lost, 1);
  assert.equal(r.n, 11);
});

test('no successful trips means no summary', () => {
  assert.equal(summarizeRtt([Infinity, Infinity]), null);
});
