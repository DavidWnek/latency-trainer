// Netcode timing model for a single peek.
//
// All times are in ms on one shared "true" clock, measured from the start of the
// round. The model is a standard lag-compensated, tick-based server:
//
//   peeker client --(bot link)--> server ticks --(your link)--> your client
//                                                              (+ interp buffer)
//
// Each client sends one input packet per tick and the server sends one snapshot per
// tick. Every packet on a link takes that link's one-way time plus 0..jitter ms, and
// may be lost. Inputs and events are resent in following packets, so a loss only
// delays them; a lost snapshot leaves a gap that the receiving client has to bridge.
//
// Shots are lag-compensated: each shot is judged against what its shooter saw, and
// the server applies whichever shot it processes on the earlier tick.

export const LATENCY_PRESETS = [10, 50, 100, 250, 500];

// Scene layout in metres. You stand at the origin looking down +z.
// The far cover box occupies x in [wallX, wallX + 6], z in [wallFrontZ, wallBackZ];
// the peeker runs along z = botZ from botStartX (hidden) to botStopX (in the open).
// Your own cover is a wall on your left ending at coverEdgeX; dodging moves you to youHideX.
export const GEOMETRY = {
  eyeHeight: 1.6,
  wallX: 1.0,
  wallFrontZ: 8,
  wallBackZ: 12,
  botZ: 13.5,
  botRadius: 0.35,
  botStartX: 3.0,
  botStopX: 0.6,
  coverEdgeX: -0.35,
  coverFrontZ: 1.5,
  coverBackZ: 2.5,
  youRadius: 0.3,
  youHideX: -1.3,
};

// Bot centre-x at which his leading edge clears the far corner of the cover,
// as seen from where you hold.
export const EXPOSE_X = (GEOMETRY.wallX * GEOMETRY.botZ) / GEOMETRY.wallBackZ + GEOMETRY.botRadius;

export function isExposed(x) {
  return x <= EXPOSE_X;
}

// True when no part of you (at youX) is in the bot's line of sight (bot at botX):
// the line from him to your right edge passes behind your cover's edge.
export function defenderHidden(youX, botX) {
  const g = GEOMETRY;
  const edge = youX + g.youRadius;
  return edge + ((botX - edge) * g.coverFrontZ) / g.botZ <= g.coverEdgeX;
}

export function tickIndexAtOrAfter(r, t) {
  return Math.ceil((t - r.tickPhase) / r.dt);
}

export function tickTime(r, k) {
  return k * r.dt + r.tickPhase;
}

// First server tick at or after time t.
export function nextTick(r, t) {
  return tickTime(r, tickIndexAtOrAfter(r, t));
}

// One direction of one connection: a packet every dt starting at `phase`.
function makeLink(r, phase, oneWay, jitter, loss, rng) {
  const n = Math.ceil(r.horizon / r.dt) + 1;
  const sent = new Float64Array(n);
  const arrive = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    sent[i] = phase + i * r.dt;
    arrive[i] = rng() < loss ? Infinity : sent[i] + oneWay + rng() * jitter;
  }
  // For "newest data received by T": arrivals in order, with a running max of send time
  // (jitter can reorder packets).
  const order = [...sent.keys()].filter((i) => arrive[i] < Infinity).sort((a, b) => arrive[a] - arrive[b]);
  const byArrival = Float64Array.from(order, (i) => arrive[i]);
  const newestSent = new Float64Array(order.length);
  order.reduce((m, i, j) => (newestSent[j] = Math.max(m, sent[i])), -Infinity);
  // For "when does data from t first get through": earliest arrival of any packet sent at or after it.
  const firstArrival = new Float64Array(n);
  for (let i = n - 1, a = Infinity; i >= 0; i--) firstArrival[i] = a = Math.min(a, arrive[i]);
  return { phase, dt: r.dt, n, sent, arrive, byArrival, newestSent, firstArrival };
}

// Send time of the newest packet that has arrived by T, or -Infinity.
function newestReceived(link, T) {
  let lo = 0;
  let hi = link.byArrival.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (link.byArrival[mid] <= T) lo = mid + 1;
    else hi = mid;
  }
  return lo ? link.newestSent[lo - 1] : -Infinity;
}

// When something that happened at time t first reaches the other end. It rides every
// packet sent from then on, so a lost packet just hands it to the next one.
function deliveredAt(link, t) {
  const i = Math.max(0, Math.ceil((t - link.phase) / link.dt));
  return i < link.n ? link.firstArrival[i] : Infinity;
}

export function createRound(s, rng = Math.random) {
  const dt = 1000 / s.tickRate;
  const r = {
    scenario: s.scenario ?? 'shoot',
    botPing: s.botPing,
    yourPing: s.yourPing,
    botJitter: s.botJitter ?? 0,
    botLoss: s.botLoss ?? 0,
    yourJitter: s.yourJitter ?? 0,
    yourLoss: s.yourLoss ?? 0,
    tickRate: s.tickRate,
    dt,
    interp: s.interpTicks * dt,
    botReaction: s.botReaction,
    botAim: s.botAim,
    speed: s.peekSpeed,
    tickPhase: rng() * dt,
    peekStart: s.minDelay + rng() * (s.maxDelay - s.minDelay),
    tMove: null, // when you started dodging, in dodge rounds
  };
  r.horizon = r.peekStart + 8000;
  const botOW = r.botPing / 2;
  const yourOW = r.yourPing / 2;
  const botLoss = r.botLoss / 100;
  const yourLoss = r.yourLoss / 100;
  r.botUp = makeLink(r, rng() * dt, botOW, r.botJitter, botLoss, rng);
  r.botDown = makeLink(r, r.tickPhase, botOW, r.botJitter, botLoss, rng);
  r.youUp = makeLink(r, rng() * dt, yourOW, r.yourJitter, yourLoss, rng);
  r.youDown = makeLink(r, r.tickPhase, yourOW, r.yourJitter, yourLoss, rng);
  // Each client renders interp behind its estimate of server time, which tracks the
  // average snapshot arrival.
  r.yourLag = yourOW + r.yourJitter / 2 + r.interp;
  r.botLag = botOW + r.botJitter / 2 + r.interp;

  const g = GEOMETRY;
  // On the peeker's own screen: he clears the corner, and (since you hold still)
  // he can see you from that same instant.
  r.tExpose = r.peekStart + ((g.botStartX - EXPOSE_X) / r.speed) * 1000;
  // First server tick whose state has him exposed.
  r.serverSaw = nextTick(r, deliveredAt(r.botUp, r.tExpose));

  // He notices you after his reaction time, then spends botAim turning onto you,
  // and fires. The shot reaches the server with his next packet that gets through.
  r.botAimStart = r.tExpose + r.botReaction;
  r.botFire = r.botAimStart + r.botAim;
  r.botShotTick = tickIndexAtOrAfter(r, deliveredAt(r.botUp, r.botFire));
  r.botShotServer = tickTime(r, r.botShotTick);
  // If his shot lands, you learn about it from the first snapshot that gets through.
  r.deathShown = deliveredAt(r.youDown, r.botShotServer);
  // His muzzle flash is part of the rendered world, so it also waits out the interp buffer.
  r.botFireVisible = r.deathShown + r.interp;
  return r;
}

// Where the peeker really is, on his own client.
export function botClientX(r, t) {
  const g = GEOMETRY;
  if (t <= r.peekStart) return g.botStartX;
  return Math.max(g.botStopX, g.botStartX - ((t - r.peekStart) * r.speed) / 1000);
}

// How far he has turned onto you, 0 (still running) to 1 (on target), on his own client.
export function botClientAim(r, t) {
  if (t <= r.botAimStart) return 0;
  if (r.botAim <= 0) return 1;
  const p = Math.min(1, (t - r.botAimStart) / r.botAim);
  return p * p * (3 - 2 * p); // ease in and out, like a flick that settles
}

// Where you really are, on your own client. In a dodge you sidestep into cover from tMove.
export function yourClientX(r, t, tMove = r.tMove) {
  if (tMove == null || t <= tMove) return 0;
  return Math.max(GEOMETRY.youHideX, -((t - tMove) * r.speed) / 1000);
}

// What a client draws at local time t: it renders `lag` behind, interpolating between
// the received snapshots either side of that moment. If the next snapshot is late or
// lost it holds the last one, then catches up when a newer one arrives.
function viewThrough(r, link, lag, t, stateAtTick) {
  const rs = t - lag;
  const k0 = Math.min(link.n - 1, Math.floor((rs - r.tickPhase) / r.dt));
  // Newest received snapshot at or before rs. Negative ticks stand for the
  // pre-round state, which every client already has.
  let ka = k0;
  while (ka >= 0 && link.arrive[ka] > t) ka--;
  // Oldest received snapshot after rs.
  let kb = Math.max(k0 + 1, 0);
  while (kb < link.n && tickTime(r, kb) <= t && link.arrive[kb] > t) kb++;
  const va = stateAtTick(ka);
  if (kb >= link.n || link.arrive[kb] > t) return va;
  const a = (rs - tickTime(r, ka)) / (tickTime(r, kb) - tickTime(r, ka));
  return va + (stateAtTick(kb) - va) * a;
}

// Server state at tick k is whatever the newest input it has received says.
const botStateAt = (r, f) => (k) => f(r, newestReceived(r.botUp, tickTime(r, k)));

export function renderedBotX(r, t) {
  return viewThrough(r, r.youDown, r.yourLag, t, botStateAt(r, botClientX));
}

export function renderedBotAim(r, t) {
  return viewThrough(r, r.youDown, r.yourLag, t, botStateAt(r, botClientAim));
}

// Where the peeker's screen shows you at his local time t.
export function botViewOfYouX(r, t, tMove = r.tMove) {
  return viewThrough(r, r.botDown, r.botLag, t, (k) =>
    yourClientX(r, newestReceived(r.youUp, tickTime(r, k)), tMove),
  );
}

export function botSeesYou(r, t, tMove = r.tMove) {
  return !defenderHidden(botViewOfYouX(r, t, tMove), botClientX(r, t));
}

// He only pulls the trigger if his screen still shows you when his aim settles;
// lag compensation then accepts the hit, because that is what he saw.
export function botFires(r, tMove = r.tMove) {
  return botSeesYou(r, r.botFire, tMove);
}

export function hiddenOnYourScreen(r, t, tMove = r.tMove) {
  return defenderHidden(yourClientX(r, t, tMove), renderedBotX(r, t));
}

export function resolveShot(r, tClick) {
  const tick = tickIndexAtOrAfter(r, deliveredAt(r.youUp, tClick));
  const yourShotServer = tickTime(r, tick);
  const outcome = tick < r.botShotTick ? 'win' : tick === r.botShotTick ? 'trade' : 'loss';
  return { yourShotServer, outcome, killConfirmed: deliveredAt(r.youDown, yourShotServer) };
}

export function resolveDodge(r, tMove) {
  const moveServer = nextTick(r, deliveredAt(r.youUp, tMove));
  if (!botFires(r, tMove)) return { moveServer, outcome: 'escaped' };
  const outcome = hiddenOnYourScreen(r, r.deathShown, tMove) ? 'killed-behind-cover' : 'killed-in-open';
  return { moveServer, outcome };
}

// First moment after `from` that `pred` holds, in 0.5 ms steps, or null.
export function firstTime(from, to, pred) {
  for (let t = from; t <= to; t += 0.5) if (pred(t)) return t;
  return null;
}

// Longest reaction (ms after he was drawn on your screen) that still succeeds,
// found by trying every click time. Negative: you would have had to act before
// you could see him. null: nothing works.
function latestSuccess(tSeen, succeeds) {
  let best = null;
  for (let d = -1000; d <= 1500; d += 0.5) if (succeeds(tSeen + d)) best = d;
  return best;
}

export function winWindow(r, tSeen) {
  return latestSuccess(tSeen, (t) => resolveShot(r, t).outcome === 'win');
}

export function escapeWindow(r, tSeen) {
  return latestSuccess(tSeen, (t) => !botFires(r, t));
}
