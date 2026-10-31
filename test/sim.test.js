import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPOSE_X, GEOMETRY, createRound, renderedBotX, renderedBotAim, botClientX, botClientAim,
  isExposed, resolveShot, resolveDodge, winWindow, escapeWindow, nextTick, defenderHidden,
  botViewOfYouX, firstTime,
} from '../src/sim.js';

const base = {
  botPing: 100, yourPing: 20, tickRate: 128, interpTicks: 2,
  botReaction: 250, botAim: 150, peekSpeed: 5.5, minDelay: 1000, maxDelay: 1000,
};
const fixedRng = () => 0.37;
const dt = 1000 / base.tickRate;

// Small seeded PRNG so jitter/loss tests are repeatable.
function seeded(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// Scan frames the way the renderer does and return the first time he is drawn exposed.
function firstSeen(r) {
  return firstTime(0, r.horizon, (t) => isExposed(renderedBotX(r, t)));
}

test('peeker is exposed on his own client exactly at tExpose', () => {
  const r = createRound(base, fixedRng);
  assert.ok(!isExposed(botClientX(r, r.tExpose - 0.01)));
  assert.ok(isExposed(botClientX(r, r.tExpose + 0.01)));
});

test('nextTick lands on the tick grid at or after t', () => {
  const r = createRound(base, fixedRng);
  for (const t of [0, 3.3, 100, 1234.5]) {
    const k = nextTick(r, t);
    assert.ok(k >= t - 1e-9 && k - t < r.dt);
  }
});

test('you see the peek about botOW + yourOW + interp (+ up to two ticks of send/tick wait) after it happens', () => {
  const r = createRound(base, fixedRng);
  const delay = firstSeen(r) - r.tExpose;
  const min = 50 + 10 + r.interp - dt;
  const max = 50 + 10 + r.interp + 2 * dt;
  assert.ok(delay > min && delay < max, `delay ${delay} not in (${min}, ${max})`);
});

test('higher peeker ping delays when you see him', () => {
  const lo = createRound({ ...base, botPing: 10 }, fixedRng);
  const hi = createRound({ ...base, botPing: 500 }, fixedRng);
  const diff = firstSeen(hi) - hi.tExpose - (firstSeen(lo) - lo.tExpose);
  assert.ok(Math.abs(diff - 245) < 2 * dt, `diff ${diff}`);
});

test('reacting inside the window wins; just after it does not', () => {
  for (const botPing of [10, 50, 100, 250, 500]) {
    const r = createRound({ ...base, botPing }, fixedRng);
    const seen = firstSeen(r);
    const w = winWindow(r, seen);
    assert.equal(resolveShot(r, seen + w).outcome, 'win');
    assert.notEqual(resolveShot(r, seen + w + 0.5).outcome, 'win');
  }
});

test('peeker ping cancels out of the win window (up to tick rounding)', () => {
  const windows = [10, 500].map((botPing) => {
    const r = createRound({ ...base, botPing }, fixedRng);
    return winWindow(r, firstSeen(r));
  });
  assert.ok(Math.abs(windows[0] - windows[1]) <= 2 * dt, `${windows}`);
});

test('your own ping counts roughly twice against you', () => {
  const lo = createRound({ ...base, yourPing: 10 }, fixedRng);
  const hi = createRound({ ...base, yourPing: 210 }, fixedRng);
  const diff = winWindow(lo, firstSeen(lo)) - winWindow(hi, firstSeen(hi));
  assert.ok(Math.abs(diff - 200) <= 2 * dt, `diff ${diff}`);
});

test('aim time delays his shot and widens your window by the same amount', () => {
  const quick = createRound({ ...base, botAim: 0 }, fixedRng);
  const slow = createRound({ ...base, botAim: 200 }, fixedRng);
  assert.equal(slow.botFire - quick.botFire, 200);
  const diff = winWindow(slow, firstSeen(slow)) - winWindow(quick, firstSeen(quick));
  assert.ok(Math.abs(diff - 200) <= 2 * dt, `diff ${diff}`);
});

test('he is fully on target exactly when he fires, on his own client', () => {
  const r = createRound(base, fixedRng);
  assert.equal(botClientAim(r, r.botAimStart), 0);
  assert.ok(botClientAim(r, r.botAimStart + r.botAim / 2) > 0.4);
  assert.equal(botClientAim(r, r.botFire), 1);
});

test('you see him turn as late as you see him move', () => {
  const r = createRound(base, fixedRng);
  const delay = firstTime(0, r.horizon, (t) => renderedBotAim(r, t) > 0) - r.botAimStart;
  const seenDelay = firstSeen(r) - r.tExpose;
  assert.ok(Math.abs(delay - seenDelay) <= 2 * dt, `${delay} vs ${seenDelay}`);
});

test('jitter and loss make him show up later and less smoothly', () => {
  const clean = [];
  const rough = [];
  for (let seed = 1; seed <= 40; seed++) {
    const c = createRound(base, seeded(seed));
    clean.push(firstSeen(c) - c.tExpose);
    const r = createRound({ ...base, botJitter: 80, botLoss: 20, yourJitter: 40, yourLoss: 10 }, seeded(seed));
    rough.push(firstSeen(r) - r.tExpose);
  }
  const avg = (xs) => xs.reduce((a, b) => a + b) / xs.length;
  assert.ok(avg(rough) > avg(clean) + 30, `${avg(rough)} vs ${avg(clean)}`);
});

test('a lost snapshot freezes him, then he jumps ahead', () => {
  // Drop every snapshot to you for a stretch while he is running in the open.
  const r = createRound({ ...base, botReaction: 2000 }, fixedRng);
  const seen = firstSeen(r);
  const from = Math.ceil((seen - r.tickPhase) / r.dt);
  for (let k = from; k < from + 8; k++) r.youDown.arrive[k] = Infinity;
  const frozen = renderedBotX(r, seen + 30);
  assert.equal(renderedBotX(r, seen + 50), frozen);
  assert.ok(renderedBotX(r, seen + 90) < frozen - 0.2, 'he should pop forward once snapshots resume');
});

test('your cover hides you once you are far enough behind it', () => {
  assert.ok(!defenderHidden(0, GEOMETRY.botStopX));
  assert.ok(defenderHidden(GEOMETRY.youHideX, GEOMETRY.botStopX));
});

test('he keeps seeing you in the open for a while after you dodge', () => {
  const r = createRound({ ...base, scenario: 'dodge' }, fixedRng);
  const tMove = r.tExpose + 100;
  const hiddenForYou = firstTime(tMove, r.horizon, (t) => defenderHidden(-((t - tMove) * r.speed) / 1000, GEOMETRY.botStopX));
  const hiddenForHim = firstTime(tMove, r.horizon, (t) => defenderHidden(botViewOfYouX(r, t, tMove), GEOMETRY.botStopX));
  // His screen trails yours by your trip up, a tick, his trip down and his buffer.
  const lag = hiddenForHim - hiddenForYou;
  assert.ok(lag > 10 + 50 + r.interp - dt && lag < 10 + 50 + r.interp + 2 * dt, `lag ${lag}`);
});

test('a high-ping peeker kills you behind cover that a low-ping one would miss', () => {
  const escapes = (botPing) => {
    const r = createRound({ ...base, scenario: 'dodge', botPing }, fixedRng);
    return escapeWindow(r, firstSeen(r));
  };
  assert.ok(escapes(10) - escapes(500) > 200, `${escapes(10)} vs ${escapes(500)}`);
  const r = createRound({ ...base, scenario: 'dodge', botPing: 500 }, fixedRng);
  const seen = firstSeen(r);
  const late = seen + escapeWindow(r, seen) + 20;
  assert.equal(resolveDodge(r, late).outcome, 'killed-behind-cover');
});

test('exposure threshold sits just past the cover corner', () => {
  assert.ok(EXPOSE_X > 1 && EXPOSE_X < 3);
});
