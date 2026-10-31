import {
  Engine, Scene, Camera, UniversalCamera, Vector3, HemisphericLight, DirectionalLight, MeshBuilder,
  StandardMaterial, DynamicTexture, Color3, Color4, TransformNode,
} from '@babylonjs/core';
import {
  GEOMETRY, EXPOSE_X, LATENCY_PRESETS, createRound, renderedBotX, renderedBotAim, isExposed,
  resolveShot, resolveDodge, winWindow, escapeWindow, yourClientX, botSeesYou, hiddenOnYourScreen,
  firstTime,
} from './sim.js';
import { renderStats, renderTimeline, toCSV } from './ui.js';
import { compare, renderComparison, renderSurveyForm, readSurveyForm } from './survey.js';
import { probeRtt } from './probe.js';

const $ = (sel) => document.querySelector(sel);
const canvas = $('#view');
const crosshair = $('#crosshair');
const vignette = $('#vignette');
const hud = $('#hud');
const banner = $('#banner');
const timeline = $('#timeline');
const form = $('#settings');
const startBtn = $('#start');
const statsBody = $('#stats tbody');
const coverNote = $('#cover-note');
const compareEl = $('#compare');
const surveyDialog = $('#survey');
const surveyForm = $('#survey-form');
const surveyOpen = $('#survey-open');

// ---------------------------------------------------------------- scene

const engine = new Engine(canvas, true, { stencil: false }, true);
const scene = new Scene(engine);
scene.clearColor = new Color4(0.6, 0.72, 0.85, 1);
scene.skipPointerMovePicking = true;

const g = GEOMETRY;
const camera = new UniversalCamera('cam', new Vector3(0, g.eyeHeight, 0), scene);
camera.minZ = 0.05;
// Landscape keeps a fixed vertical field of view. On a portrait phone that would leave
// a sliver of the scene, so fix the horizontal one instead.
function fitFov() {
  const portrait = engine.getAspectRatio(camera) < 1;
  camera.fovMode = portrait ? Camera.FOVMODE_HORIZONTAL_FIXED : Camera.FOVMODE_VERTICAL_FIXED;
  camera.fov = portrait ? 1.1 : 0.8;
}
fitFov();
// Pre-aim just inside the corner, at chest height, where his edge will appear.
camera.setTarget(new Vector3(EXPOSE_X - g.botRadius - 0.05, 1.3, g.botZ));

const hemi = new HemisphericLight('hemi', new Vector3(0.2, 1, -0.3), scene);
hemi.intensity = 0.75;
hemi.groundColor = new Color3(0.35, 0.3, 0.25);
const sun = new DirectionalLight('sun', new Vector3(-0.4, -1, 0.6), scene);
sun.intensity = 0.55;
// No shadows on purpose: a shadow would give the peek away before his body clears the corner.

function mat(name, r, gr, b) {
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = new Color3(r, gr, b);
  m.specularColor = new Color3(0.05, 0.05, 0.05);
  return m;
}

function box(name, material, x0, x1, y0, y1, z0, z1) {
  const m = MeshBuilder.CreateBox(name, { width: x1 - x0, height: y1 - y0, depth: z1 - z0 }, scene);
  m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  m.material = material;
  return m;
}

const groundTex = new DynamicTexture('groundTex', { width: 512, height: 512 }, scene);
{
  const ctx = groundTex.getContext();
  ctx.fillStyle = '#b8a58a';
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = '#ab977b';
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if ((i + j) % 2) ctx.fillRect(i * 64, j * 64, 64, 64);
  groundTex.update();
  groundTex.uScale = groundTex.vScale = 5;
}
const groundMat = mat('groundMat', 1, 1, 1);
groundMat.diffuseTexture = groundTex;
const ground = MeshBuilder.CreateGround('ground', { width: 40, height: 40 }, scene);
ground.position.z = 10;
ground.material = groundMat;

const wallMat = mat('wallMat', 0.82, 0.72, 0.56);
const coverMat = mat('coverMat', 0.62, 0.55, 0.47);
const crateMat = mat('crateMat', 0.55, 0.4, 0.24);
box('cover', coverMat, g.wallX, g.wallX + 6, 0, 3.2, g.wallFrontZ, g.wallBackZ);
box('leftWall', wallMat, -4.5, -4, 0, 4, -2, 18);
box('backWall', wallMat, -4.5, 10, 0, 4, 17, 17.5);
box('rightWall', wallMat, 9.5, 10, 0, 4, -2, 17.5);
// Your own cover, right at your left shoulder: the wall you dodge behind.
box('yourCover', wallMat, -3.5, g.coverEdgeX, 0, 3, g.coverFrontZ, g.coverBackZ);
box('crate1', crateMat, -3.2, -2, 0, 1.2, 5, 6.2);
box('crate2', crateMat, -3.6, -2.6, 0, 1, 14.5, 15.5);

// The peeker: root at his feet so he can fall over around it.
const bot = new TransformNode('bot', scene);
const botMat = mat('botMat', 0.9, 0.22, 0.15);
botMat.emissiveColor = new Color3(0.2, 0.03, 0.02);
const deadMat = mat('deadMat', 0.35, 0.35, 0.35);
const body = MeshBuilder.CreateCapsule('body', { height: 1.5, radius: g.botRadius }, scene);
body.position.y = 0.75;
const head = MeshBuilder.CreateSphere('head', { diameter: 0.36 }, scene);
head.position.y = 1.68;
for (const m of [body, head]) m.parent = bot;
const darkMat = mat('darkMat', 0.08, 0.08, 0.08);

// Gun hangs from a shoulder pivot: pointed at the floor while he runs, raised onto you as he aims.
// Both stay inside his body's silhouette, so neither can give the peek away early.
const LOW_READY = -1.1;
const arms = new TransformNode('arms', scene);
arms.parent = bot;
arms.position.set(-0.12, 1.25, -0.15);
const gun = MeshBuilder.CreateBox('gun', { width: 0.08, height: 0.1, depth: 0.6 }, scene);
gun.position.z = -0.3;
gun.material = darkMat;
gun.parent = arms;
const flash = MeshBuilder.CreateSphere('flash', { diameter: 0.3 }, scene);
flash.position.z = -0.7;
const flashMat = mat('flashMat', 1, 0.9, 0.3);
flashMat.emissiveColor = new Color3(1, 0.85, 0.3);
flash.material = flashMat;
flash.isVisible = false;
flash.parent = arms;

// Visor shows where he is looking: along his run, then at you.
const face = new TransformNode('face', scene);
face.parent = bot;
face.position.y = 1.68;
const visor = MeshBuilder.CreateBox('visor', { width: 0.22, height: 0.07, depth: 0.06 }, scene);
visor.position.z = -0.16;
visor.material = darkMat;
visor.parent = face;

// aim: 0 = running, looking along his path; 1 = on target.
function poseBot(aim) {
  arms.rotation.x = LOW_READY * (1 - aim);
  face.rotation.y = (Math.PI / 2) * (1 - aim);
}

function resetBot() {
  bot.position.set(g.botStartX, 0, g.botZ);
  bot.rotation.x = 0;
  body.material = head.material = botMat;
  flash.isVisible = false;
  poseBot(0);
}
resetBot();

// ---------------------------------------------------------------- settings & results

const latencySelect = form.elements.fixedLatency;
latencySelect.innerHTML = LATENCY_PRESETS.map((v) => `<option value="${v}">${v} ms</option>`).join('');
latencySelect.value = '100';

const STORE_KEY = 'peek-latency-results';
const SETTINGS_KEY = 'peek-latency-settings';
const SURVEY_KEY = 'peek-latency-survey';

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable (private mode etc.) — results just won't persist.
  }
}

for (const [k, v] of Object.entries(load(SETTINGS_KEY, {}))) if (form.elements[k]) form.elements[k].value = v;

function readSettings() {
  const f = form.elements;
  const num = (name) => Number(f[name].value);
  return {
    scenario: f.scenario.value,
    mode: f.mode.value,
    target: f.target.value,
    fixedLatency: num('fixedLatency'),
    roundsPer: Math.max(1, num('roundsPer')),
    botPing: num('botPing'),
    yourPing: num('yourPing'),
    botJitter: num('botJitter'),
    botLoss: num('botLoss'),
    yourJitter: num('yourJitter'),
    yourLoss: num('yourLoss'),
    tickRate: num('tickRate'),
    interpTicks: num('interpTicks'),
    botReaction: num('botReaction'),
    botAim: num('botAim'),
    peekSpeed: num('peekSpeed'),
    minDelay: 900,
    maxDelay: 3500,
  };
}

function syncModeFields() {
  const mode = form.elements.mode.value;
  for (const el of form.querySelectorAll('[data-mode]')) el.hidden = el.dataset.mode !== mode;
}
form.addEventListener('change', () => {
  syncModeFields();
  save(SETTINGS_KEY, Object.fromEntries(new FormData(form)));
});
syncModeFields();

let results = load(STORE_KEY, []);
let answers = load(SURVEY_KEY, null);
let comparison = [];

function renderResults() {
  renderStats(statsBody, coverNote, results);
  comparison = compare(answers ?? {}, results);
  renderComparison(compareEl, comparison, answers != null);
  surveyOpen.textContent = answers ? 'Edit questionnaire answers' : 'Take the questionnaire';
}
renderResults();
if (results.length) renderTimeline(timeline, results[results.length - 1]);

// ---------------------------------------------------------------- game state

const game = {
  phase: 'idle', // idle | between | live
  settings: null,
  queue: null, // array of latency values for a sweep, null for endless
  idx: 0,
  round: null,
  nextAt: 0,
};
if (import.meta.env.DEV) window.__dev = { game, bot, poseBot };

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function showBanner(html, cls = '') {
  banner.className = cls;
  banner.innerHTML = html;
}

function setPhase(phase) {
  game.phase = phase;
  document.body.classList.toggle('live', phase !== 'idle');
  startBtn.textContent = phase === 'idle' ? 'Start test' : 'Stop';
  for (const el of form.elements) el.disabled = phase !== 'idle';
  for (const el of [surveyOpen, ...compareEl.querySelectorAll('button')]) el.disabled = phase !== 'idle';
}

function startTest() {
  const s = readSettings();
  game.settings = s;
  game.queue = s.mode === 'sweep' ? shuffle(LATENCY_PRESETS.flatMap((v) => Array(s.roundsPer).fill(v))) : null;
  game.idx = 0;
  setPhase('between');
  // On a phone the view sits above the settings, so bring it back on screen.
  $('#stage').scrollIntoView({ behavior: 'smooth', block: 'start' });
  game.nextAt = performance.now() + 800;
  showBanner('Eyes on the crosshair…');
}

function stopTest(message = 'Stopped') {
  setPhase('idle');
  game.round = null;
  vignette.classList.remove('on');
  resetBot();
  camera.position.x = 0;
  hud.textContent = '';
  showBanner(message);
}

function currentValue() {
  return game.queue ? game.queue[game.idx] : game.settings.fixedLatency;
}

function beginRound() {
  const s = game.settings;
  const value = currentValue();
  const r = createRound({
    ...s,
    botPing: s.target === 'bot' ? value : s.botPing,
    yourPing: s.target === 'you' ? value : s.yourPing,
  });
  r.value = value;
  r.t0 = performance.now();
  r.tSeen = null;
  r.tClick = null;
  r.shot = null;
  r.dodge = null;
  r.falseStartAt = null;
  r.deathDisplayed = false;
  game.round = r;

  resetBot();
  camera.position.x = 0;
  vignette.classList.remove('on');
  crosshair.classList.remove('hit');
  showBanner(r.scenario === 'dodge' ? '<small>Dodge mode: click or tap to step behind your cover</small>' : '');
  const progress = game.queue ? `Round ${game.idx + 1}/${game.queue.length} · ` : '';
  const link = (ping, jitter, loss) =>
    `${ping} ms${jitter ? ` ±${jitter}` : ''}${loss ? ` · ${loss}% loss` : ''}`;
  hud.textContent =
    `${progress}Bot ${link(r.botPing, r.botJitter, r.botLoss)} · ` +
    `You ${link(r.yourPing, r.yourJitter, r.yourLoss)} · ${r.tickRate} tick`;
  setPhase('live');
}

// Whether his shot gets fired and lands. Once your screen reaches deathShown this
// can no longer change: anything you do from then on reaches him too late.
function botFired(r) {
  if (r.scenario === 'dodge') return !r.dodge || r.dodge.outcome !== 'escaped';
  return !r.shot || r.shot.outcome !== 'win';
}

// When the round is over, given what has happened so far.
function roundEnd(r) {
  if (r.falseStartAt != null) return r.falseStartAt + 900;
  if (r.scenario === 'dodge') return r.tClick == null ? r.deathShown + 1200 : Math.max(r.deathShown, r.tClick) + 900;
  if (!r.shot) return r.deathShown + 1200; // leave time for a late click so the reaction still gets logged
  if (r.shot.outcome === 'win') return r.shot.killConfirmed + 900;
  if (r.shot.outcome === 'trade') return Math.max(r.shot.killConfirmed, r.deathShown) + 900;
  return Math.max(r.deathShown, r.tClick) + 900;
}

function fire(timeStamp) {
  const r = game.round;
  if (game.phase !== 'live' || r.tClick != null || r.falseStartAt != null) return;
  const t = timeStamp - r.t0;
  if (r.tSeen == null || t < r.tSeen) {
    r.falseStartAt = t;
    showBanner('Too early — round voided<small>Wait until you actually see him.</small>', 'warn');
    return;
  }
  r.tClick = t;
  if (r.scenario === 'dodge') {
    r.tMove = t;
    r.dodge = resolveDodge(r, t);
    return;
  }
  r.shot = resolveShot(r, t);
  crosshair.classList.add('hit');
  setTimeout(() => crosshair.classList.remove('hit'), 120);
}

function finishRound() {
  const r = game.round;
  const voided = r.falseStartAt != null || r.tSeen == null;

  if (!voided) {
    const rel = (t) => (t == null ? null : t - r.tExpose);
    const dodge = r.scenario === 'dodge';
    const result = dodge ? r.dodge : r.shot;
    const outcome = result ? result.outcome : 'no-reaction';
    const fired = botFired(r);
    const rec = {
      n: results.length + 1,
      time: new Date().toISOString(),
      scenario: r.scenario,
      varied: game.settings.target,
      value: r.value,
      botPing: r.botPing,
      yourPing: r.yourPing,
      botJitter: r.botJitter,
      botLoss: r.botLoss,
      yourJitter: r.yourJitter,
      yourLoss: r.yourLoss,
      tickRate: r.tickRate,
      interpMs: r.interp,
      botReaction: r.botReaction,
      botAim: r.botAim,
      serverSaw: rel(r.serverSaw),
      botAimStart: rel(r.botAimStart),
      seen: rel(r.tSeen),
      botFire: rel(r.botFire),
      botFired: fired,
      botShotServer: rel(r.botShotServer),
      click: rel(r.tClick),
      reaction: r.tClick == null ? null : r.tClick - r.tSeen,
      yourShotServer: rel(r.shot?.yourShotServer),
      moveServer: rel(r.dodge?.moveServer),
      // When your hitbox was fully behind cover on your screen, and on his.
      hiddenForYou: dodge && r.tMove != null
        ? rel(firstTime(r.tMove, r.tMove + 3000, (t) => hiddenOnYourScreen(r, t)))
        : null,
      hiddenForHim: dodge && r.tMove != null
        ? rel(firstTime(r.tMove, r.tMove + 3000, (t) => !botSeesYou(r, t)))
        : null,
      deathShown: fired ? rel(r.deathShown) : null,
      window: dodge ? escapeWindow(r, r.tSeen) : winWindow(r, r.tSeen),
      outcome,
    };
    results.push(rec);
    save(STORE_KEY, results);
    renderResults();
    renderTimeline(timeline, rec);

    const verb = dodge ? 'moved' : 'reacted';
    const rt = rec.reaction != null ? `You ${verb} in ${Math.round(rec.reaction)} ms` : `You never ${dodge ? 'moved' : 'fired'}`;
    const need = rec.window == null ? 'nothing would have worked' : `you needed ≤ ${Math.round(rec.window)} ms`;
    const detail = `<small>${rt} · ${need} · he saw you ${Math.round(rec.seen)} ms before you saw him</small>`;
    const BANNERS = {
      win: ['You won the duel', 'win'],
      trade: ['Trade', 'warn'],
      loss: ['Peeked and killed', 'loss'],
      escaped: ['Escaped — you left his screen before he fired', 'win'],
      'killed-behind-cover': ['Killed behind cover — your screen already had you safe', 'loss'],
      'killed-in-open': ['Killed in the open', 'loss'],
      'no-reaction': ['Peeked and killed', 'loss'],
    };
    const [title, cls] = BANNERS[outcome];
    showBanner(`${title}${detail}`, cls);
    game.idx++;
  }
  // A voided round is replayed at the same latency.

  if (game.queue && game.idx >= game.queue.length) {
    stopTest('Test complete — see Results');
    return;
  }
  setPhase('between');
  game.nextAt = performance.now() + (voided ? 900 : 1600);
}

function update(now) {
  if (game.phase === 'between') {
    if (now >= game.nextAt) beginRound();
    return;
  }
  if (game.phase !== 'live') return;

  const r = game.round;
  const t = now - r.t0;
  camera.position.x = yourClientX(r, t);
  const x = renderedBotX(r, t);
  bot.position.x = x;
  // Timestamp of the first frame that draws him past the corner.
  if (r.tSeen == null && r.falseStartAt == null && isExposed(x)) r.tSeen = t;

  const botDown = r.shot && r.shot.outcome !== 'loss' && t >= r.shot.killConfirmed;
  if (!botDown) poseBot(renderedBotAim(r, t));

  const fired = botFired(r);
  flash.isVisible = fired && t >= r.botFireVisible && t < r.botFireVisible + 50;

  if (fired && !r.deathDisplayed && t >= r.deathShown && r.falseStartAt == null) {
    r.deathDisplayed = true;
    vignette.classList.add('on');
    showBanner('ELIMINATED', 'loss');
  }

  if (botDown) {
    body.material = head.material = deadMat;
    bot.rotation.x = Math.min(1, (t - r.shot.killConfirmed) / 250) * (Math.PI / 2);
  }

  if (t >= roundEnd(r)) finishRound();
}

scene.onBeforeRenderObservable.add(() => update(performance.now()));
engine.runRenderLoop(() => scene.render());
window.addEventListener('resize', () => {
  engine.resize();
  fitFov();
});

// ---------------------------------------------------------------- input

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 0) fire(e.timeStamp);
});
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat || surveyDialog.open) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  e.preventDefault();
  fire(e.timeStamp);
});

startBtn.addEventListener('click', (e) => {
  e.currentTarget.blur(); // so Space fires instead of re-pressing the button
  if (game.phase === 'idle') startTest();
  else stopTest();
});

$('#clear').addEventListener('click', () => {
  if (!results.length || !confirm('Delete all recorded rounds?')) return;
  results = [];
  save(STORE_KEY, results);
  renderResults();
  timeline.hidden = true;
});

$('#csv').addEventListener('click', () => {
  const blob = new Blob([toCSV(results)], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `peek-latency-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------------------------------------------------------- questionnaire

function applySettings(patch) {
  for (const [k, v] of Object.entries(patch)) if (form.elements[k]) form.elements[k].value = v;
  syncModeFields();
  save(SETTINGS_KEY, Object.fromEntries(new FormData(form)));
}

surveyOpen.addEventListener('click', () => {
  renderSurveyForm($('#survey-questions'), answers ?? {});
  surveyDialog.showModal();
});

surveyDialog.addEventListener('close', () => {
  if (surveyDialog.returnValue !== 'save') return;
  answers = readSurveyForm(surveyForm);
  save(SURVEY_KEY, answers);
  if (answers.ping != null) applySettings({ yourPing: answers.ping });
  renderResults();
  compareEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

compareEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-row]');
  if (!btn || game.phase !== 'idle') return;
  applySettings(comparison[Number(btn.dataset.row)].setup);
  startBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
  startBtn.classList.add('pulse');
  setTimeout(() => startBtn.classList.remove('pulse'), 1600);
});

// ---------------------------------------------------------------- real connection

$('#probe').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const out = $('#probe-result');
  btn.disabled = true;
  out.textContent = 'Measuring…';
  const r = await probeRtt();
  btn.disabled = game.phase !== 'idle';
  if (!r) {
    out.textContent = 'Could not reach the host — are you offline?';
    return;
  }
  applySettings({ yourJitter: Math.round(r.jitter) });
  const lost = r.lost ? `, ${r.lost} of ${r.n} timed out` : '';
  out.textContent =
    `Round trip to this site: ${Math.round(r.median)} ms median, up to +${Math.round(r.jitter)} ms jitter${lost}. ` +
    'Copied the jitter to Your jitter.';
});
