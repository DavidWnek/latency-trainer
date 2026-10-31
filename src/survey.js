// Questionnaire about what the player runs into in real matches, and how each
// answer holds up against what the test measured.
import { median, isWon } from './ui.js';

const MIN_ROUNDS = 5; // rounds before a rate is worth comparing
const MIN_PER_SIDE = 3; // rounds at each end of a near-vs-far comparison

const fmtPct = (p) => `${Math.round(p)}%`;
const fmtMs = (v) => `${Math.round(v)} ms`;
const pct = (num, den) => (100 * num) / den;

// Each scale turns a measured value into the answer it corresponds to, so an answer
// and a measurement can be compared by index.
const SCALES = {
  frequency: {
    options: [['never', 'Never'], ['rarely', 'Rarely'], ['sometimes', 'Sometimes'], ['often', 'Often'], ['always', 'Almost always']],
    band: (p) => {
      const i = [5, 20, 50, 80].findIndex((t) => p < t);
      return i < 0 ? 4 : i;
    },
    higher: 'The test shows it more often',
    lower: 'The test shows it less often',
  },
  // Measured as the drop in won % (percentage points) from low ping to high ping.
  change: {
    options: [['much-worse', 'Much worse'], ['worse', 'A bit worse'], ['same', 'No different'], ['better', 'Better']],
    band: (drop) => (drop >= 25 ? 0 : drop >= 8 ? 1 : drop > -8 ? 2 : 3),
    higher: 'The test shows less of a difference',
    lower: 'The test shows a bigger difference',
  },
  reaction: {
    options: [['lt200', 'Under 200 ms'], ['200', '200–250 ms'], ['250', '250–300 ms'], ['gt300', 'Over 300 ms']],
    band: (v) => (v < 200 ? 0 : v < 250 ? 1 : v < 300 ? 2 : 3),
    higher: 'You are slower than you think',
    lower: 'You are faster than you think',
  },
};

// Settings patches for the "Set up" buttons. The answered ping becomes your base ping.
const withPing = (ctx, patch) =>
  ctx.answers.ping && patch.target === 'bot' ? { ...patch, yourPing: ctx.answers.ping } : patch;
const SHOOT_SWEEP = { scenario: 'shoot', mode: 'sweep', target: 'bot' };
const DODGE_SWEEP = { scenario: 'dodge', mode: 'sweep', target: 'bot', botAim: 350 };
const FAST_PEEKER = { ...SHOOT_SWEEP, botReaction: 150, botAim: 50 };

const timeToFire = (recs) => median(recs.map((r) => (r.botReaction ?? 0) + (r.botAim ?? 0)));

// Won % at low and high ping of the varied side, per scenario, when both ends have data.
function nearFar(results, varied) {
  const out = [];
  for (const [scenario, name, verb] of [['shoot', 'Holding', 'won'], ['dodge', 'Dodging', 'escaped']]) {
    const recs = results.filter((r) => (r.scenario ?? 'shoot') === scenario && r.varied === varied);
    const near = recs.filter((r) => r.value <= 50);
    const far = recs.filter((r) => r.value >= 250);
    if (near.length < MIN_PER_SIDE || far.length < MIN_PER_SIDE) continue;
    const a = pct(near.filter(isWon).length, near.length);
    const b = pct(far.filter(isWon).length, far.length);
    out.push({ scenario, drop: a - b, n: near.length + far.length, text: `${name} ${fmtPct(a)} → ${fmtPct(b)} ${verb}` });
  }
  return out;
}

function nearFarMeasure(ctx, varied) {
  const sides = nearFar(ctx.results, varied);
  if (!sides.length) return null;
  const worst = sides.reduce((a, b) => (b.drop > a.drop ? b : a));
  return {
    value: worst.drop,
    text: sides.map((s) => s.text).join(' · '),
    n: sides.reduce((a, s) => a + s.n, 0),
    scenarios: sides.map((s) => s.scenario),
  };
}

export const QUESTIONS = [
  {
    id: 'instantDeath',
    scale: 'frequency',
    short: 'Dying before you could react',
    text: 'When someone peeks you while you hold an angle, how often do you die before you could possibly have reacted?',
    measure(ctx) {
      if (ctx.shoot.length < MIN_ROUNDS || ctx.rt == null) return null;
      const fast = ctx.shoot.filter((r) => r.deathShown != null && r.deathShown - r.seen < ctx.rt);
      return {
        value: pct(fast.length, ctx.shoot.length),
        text: `${fmtPct(pct(fast.length, ctx.shoot.length))} of rounds killed you within your ${fmtMs(ctx.rt)} reaction`,
        n: ctx.shoot.length,
        fire: timeToFire(ctx.shoot),
      };
    },
    explain(verdict, m, ctx) {
      if (verdict === 'lower')
        return {
          note: `Here he fires ${fmtMs(m.fire)} after clearing the corner, so the kill rarely lands inside your reaction time. The gap between seeing him and dying is roughly his time-to-fire minus your interp buffer; neither player's ping changes it much. Players who pre-aim the angle and shoot on sight are far quicker.`,
          setup: withPing(ctx, FAST_PEEKER),
        };
      if (verdict === 'higher')
        return { note: 'The bot may be quicker than the players you usually face. Raise Bot reaction or Bot aim time to match them.' };
      return null;
    },
    setup: (ctx) => withPing(ctx, SHOOT_SWEEP),
  },
  {
    id: 'loseHeld',
    scale: 'frequency',
    short: 'Losing while holding an angle',
    text: 'When you hold an angle and someone swings it, how often do you lose the fight?',
    measure(ctx) {
      if (ctx.shoot.length < MIN_ROUNDS) return null;
      const lost = ctx.shoot.filter((r) => !isWon(r)).length;
      return {
        value: pct(lost, ctx.shoot.length),
        text: `${fmtPct(pct(lost, ctx.shoot.length))} of duels lost`,
        n: ctx.shoot.length,
        fire: timeToFire(ctx.shoot),
      };
    },
    explain(verdict, m, ctx) {
      if (verdict === 'lower')
        return {
          note: `The bot always swings the same way and needs ${fmtMs(m.fire)} to fire. Real opponents vary their timing and shoot sooner; try a faster peeker to see what that costs you.`,
          setup: withPing(ctx, FAST_PEEKER),
        };
      if (verdict === 'higher')
        return { note: 'The bot may be faster than the players you usually face. Raise Bot reaction to match them.' };
      return null;
    },
    setup: (ctx) => withPing(ctx, SHOOT_SWEEP),
  },
  {
    id: 'behindCover',
    scale: 'frequency',
    short: 'Dying behind cover',
    text: 'How often do you die after you have already made it behind cover on your screen?',
    measure(ctx) {
      if (ctx.dodge.length < MIN_ROUNDS) return null;
      const behind = ctx.dodge.filter((r) => r.outcome === 'killed-behind-cover').length;
      return {
        value: pct(behind, ctx.dodge.length),
        text: `${fmtPct(pct(behind, ctx.dodge.length))} of dodges killed behind cover`,
        n: ctx.dodge.length,
        fire: timeToFire(ctx.dodge),
      };
    },
    explain(verdict, m, ctx) {
      if (verdict !== 'lower') return null;
      if (m.fire < 500)
        return {
          note: `He fires ${fmtMs(m.fire)} after the corner, before you can reach cover, so you die in the open instead. Give him a slower aim and sweep his ping.`,
          setup: withPing(ctx, DODGE_SWEEP),
        };
      return {
        note: 'This happens against high-ping peekers: his screen still shows you in the open. Sweep the bot’s ping in Dodge.',
        setup: withPing(ctx, DODGE_SWEEP),
      };
    },
    setup: (ctx) => withPing(ctx, DODGE_SWEEP),
  },
  {
    id: 'farWorse',
    scale: 'change',
    short: 'Far-away opponents',
    text: 'Against opponents far away (another country, high ping), fights feel…',
    measure: (ctx) => nearFarMeasure(ctx, 'bot'),
    explain(verdict, m, ctx) {
      if (!m.scenarios.includes('dodge'))
        return {
          note: 'Holding still, his ping cancels out: he shows up late, and his shot lands late by the same amount. It bites when you move, so run the Dodge sweep.',
          setup: withPing(ctx, DODGE_SWEEP),
        };
      if (verdict === 'higher')
        return { note: 'Far-away players often have unstable connections too. Add bot jitter and packet loss and test again.' };
      return { note: 'The difference comes from moving: the server judges his shot against his delayed view of you, so you can be hit after reaching cover.' };
    },
    setup: (ctx) => withPing(ctx, ctx.dodge.length ? SHOOT_SWEEP : DODGE_SWEEP),
  },
  {
    id: 'ownLagWorse',
    scale: 'change',
    short: 'Your own bad connection',
    text: 'When your own connection is bad (high ping), fights feel…',
    measure: (ctx) => nearFarMeasure(ctx, 'you'),
    explain: () => ({
      note: 'Your own ping counts about twice: you see him late, and your shot takes longer to reach the server.',
    }),
    setup: () => ({ scenario: 'shoot', mode: 'sweep', target: 'you' }),
  },
  {
    id: 'reaction',
    scale: 'reaction',
    short: 'Your reaction time',
    text: 'Roughly how fast do you think your reaction time is?',
    measure(ctx) {
      if (ctx.rt == null) return null;
      return { value: ctx.rt, text: `${fmtMs(ctx.rt)} median`, n: ctx.rts.length };
    },
    explain: () => ({
      note: 'Measured from the first frame he is drawn. In a real game your monitor and mouse add roughly 10–30 ms on top.',
    }),
    setup: (ctx) => withPing(ctx, SHOOT_SWEEP),
  },
];

const VERDICT_TEXT = { match: 'Matches what you feel', untested: 'Not tested yet', unanswered: 'No answer' };

export function compare(answers, results) {
  const shoot = results.filter((r) => (r.scenario ?? 'shoot') === 'shoot');
  const dodge = results.filter((r) => r.scenario === 'dodge');
  const rts = results.filter((r) => r.reaction != null).map((r) => r.reaction);
  const ctx = { answers, results, shoot, dodge, rts, rt: rts.length >= MIN_ROUNDS ? median(rts) : null };

  return QUESTIONS.map((q) => {
    const scale = SCALES[q.scale];
    const answer = answers[q.id] || null;
    const said = answer ? scale.options.findIndex(([v]) => v === answer) : -1;
    const m = q.measure(ctx);
    let verdict;
    if (!m) verdict = 'untested';
    else if (said < 0) verdict = 'unanswered';
    else {
      const d = scale.band(m.value) - said;
      verdict = d === 0 ? 'match' : d > 0 ? 'higher' : 'lower';
    }
    const extra = m && said >= 0 ? q.explain(verdict, m, ctx) : null;
    return {
      id: q.id,
      label: q.short,
      said: said >= 0 ? scale.options[said][1] : null,
      measured: m && { text: m.text, n: m.n, as: scale.options[scale.band(m.value)][1] },
      verdict,
      verdictText: VERDICT_TEXT[verdict] ?? scale[verdict],
      note: extra?.note ?? null,
      setup: verdict === 'untested' ? q.setup(ctx) : extra?.setup ?? null,
    };
  });
}

export function describeSetup(patch) {
  const parts = [
    patch.scenario === 'dodge' ? 'Dodge' : 'Hold & shoot',
    `sweep ${patch.target === 'bot' ? 'peeker' : 'your'} ping`,
  ];
  if (patch.botReaction != null) parts.push(`bot reaction ${patch.botReaction} ms`);
  if (patch.botAim != null) parts.push(`aim ${patch.botAim} ms`);
  if (patch.yourPing != null) parts.push(`your ping ${patch.yourPing} ms`);
  return `Set up: ${parts.join(', ')}`;
}

// ---------------------------------------------------------------- DOM

export function renderSurveyForm(el, answers) {
  el.innerHTML = QUESTIONS.map((q) => {
    const opts = [...SCALES[q.scale].options, ['', 'Not sure']];
    const current = answers[q.id] ?? '';
    return `<fieldset>
      <legend>${q.text}</legend>
      ${opts
        .map(([v, label]) => `<label><input type="radio" name="${q.id}" value="${v}"${v === current ? ' checked' : ''} /><span>${label}</span></label>`)
        .join('')}
    </fieldset>`;
  }).join('') + `<fieldset>
      <legend>Your usual in-game ping (ms), if you know it. Used as Your base ping.</legend>
      <input name="ping" type="number" min="0" max="1000" placeholder="e.g. 35" value="${answers.ping ?? ''}" />
    </fieldset>`;
}

export function readSurveyForm(el) {
  const data = new FormData(el);
  const answers = {};
  for (const q of QUESTIONS) answers[q.id] = data.get(q.id) || null;
  const ping = Number(data.get('ping'));
  answers.ping = data.get('ping') !== '' && Number.isFinite(ping) ? ping : null;
  return answers;
}

export function renderComparison(el, rows, answered) {
  if (!answered) {
    el.innerHTML = '<p class="hint">Tell us what you run into in real matches, then play the suggested tests to see whether latency explains it.</p>';
    return;
  }
  el.innerHTML = rows
    .map(
      (r, i) => `<div class="cmp ${r.verdict}">
        <div class="cmp-head"><span>${r.label}</span><span class="cmp-verdict">${r.verdictText}</span></div>
        <div class="cmp-vals">
          <span>You said <b>${r.said ?? '—'}</b></span>
          <span>Test <b>${r.measured ? `${r.measured.as}` : '—'}</b></span>
        </div>
        ${r.measured ? `<div class="cmp-detail">${r.measured.text} · ${r.measured.n} rounds</div>` : ''}
        ${r.note ? `<p class="cmp-note">${r.note}</p>` : ''}
        ${r.setup ? `<button type="button" class="cmp-setup" data-row="${i}">${describeSetup(r.setup)}</button>` : ''}
      </div>`,
    )
    .join('');
}
