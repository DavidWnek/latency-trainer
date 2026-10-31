// Results table, per-round timeline and CSV export. Records store every time
// relative to the moment the peeker cleared the corner on his own client.

const ms = (v) => (v == null ? '—' : `${Math.round(v)} ms`);

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export const isWon = (rec) => rec.outcome === 'win' || rec.outcome === 'escaped';

function connection(rec) {
  const { botJitter: bj = 0, botLoss: bl = 0, yourJitter: yj = 0, yourLoss: yl = 0 } = rec;
  if (!bj && !bl && !yj && !yl) return null;
  return `bot ±${bj} ms ${bl}% loss, you ±${yj} ms ${yl}% loss`;
}

export function summarize(results) {
  const groups = new Map();
  for (const rec of results) {
    const scenario = rec.scenario ?? 'shoot';
    const conn = connection(rec);
    const key = `${scenario}:${rec.varied}:${rec.value}:${conn}`;
    if (!groups.has(key)) groups.set(key, { scenario, varied: rec.varied, value: rec.value, conn, recs: [] });
    groups.get(key).recs.push(rec);
  }
  return [...groups.values()]
    .sort((a, b) =>
      a.scenario.localeCompare(b.scenario) || a.varied.localeCompare(b.varied) ||
      String(a.conn).localeCompare(String(b.conn)) || a.value - b.value)
    .map(({ scenario, varied, value, conn, recs }) => ({
      label: `${varied === 'bot' ? 'Bot' : 'You'} ${value}${scenario === 'dodge' ? ' · dodge' : ''}${conn ? ' · unstable' : ''}`,
      conn,
      scenario,
      n: recs.length,
      medianRT: median(recs.filter((r) => r.reaction != null).map((r) => r.reaction)),
      peekAdv: mean(recs.map((r) => r.seen)),
      window: mean(recs.filter((r) => r.window != null).map((r) => r.window)),
      wonPct: (100 * recs.filter(isWon).length) / recs.length,
      behindCover: recs.filter((r) => r.outcome === 'killed-behind-cover').length,
    }));
}

export function renderStats(tbody, note, results) {
  const rows = summarize(results);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No rounds yet</td></tr>';
    note.textContent = '';
    return;
  }
  tbody.innerHTML = rows
    .map(
      (r) => `<tr${r.conn ? ` title="${r.conn}"` : ''}>
        <td>${r.label}</td><td>${r.n}</td><td>${ms(r.medianRT)}</td>
        <td>${ms(r.peekAdv)}</td><td>${ms(r.window)}</td><td>${Math.round(r.wonPct)}%</td>
      </tr>`,
    )
    .join('');
  const dodges = rows.filter((r) => r.scenario === 'dodge');
  note.innerHTML = dodges.length
    ? `Killed behind cover (your screen had you safe): ${dodges
        .map((r) => `<b>${r.label}</b> ${r.behindCover}/${r.n}`)
        .join(', ')}`
    : '';
}

const OUTCOME_TEXT = {
  win: 'You won the duel',
  trade: 'Trade — both shots landed on the same tick',
  loss: 'He killed you first',
  'no-reaction': 'No reaction',
  escaped: 'Escaped',
  'killed-behind-cover': 'Killed behind cover',
  'killed-in-open': 'Killed in the open',
};

export function renderTimeline(el, rec) {
  const dodge = rec.scenario === 'dodge';
  const botLanded = rec.botFired ?? rec.outcome !== 'win';
  const acted = rec.click != null;
  const events = [
    ['He clears the corner (and sees you)', 0, 'bot', true],
    ['Server receives his peek', rec.serverSaw, 'srv', true],
    ['He is drawn on your screen', rec.seen, 'you', true],
    ['He spots you and starts aiming', rec.botAimStart, 'bot', true],
    ...(dodge
      ? [
          ['You start moving', rec.click, 'you', acted],
          ['Server receives your move', rec.moveServer, 'srv', acted],
          ['You are behind cover on your screen', rec.hiddenForYou, 'you', acted],
          ['You are behind cover on his screen', rec.hiddenForHim, 'bot', acted],
        ]
      : []),
    ['He fires (on his screen)', rec.botFire, 'bot', botLanded],
    ['Server registers his shot', rec.botShotServer, 'srv', botLanded],
    ...(dodge
      ? []
      : [
          ['You click', rec.click, 'you', acted],
          ['Server registers your shot', rec.yourShotServer, 'srv', acted],
        ]),
    ['Your screen shows you died', rec.deathShown, 'you', botLanded],
  ].filter(([, t]) => t != null);

  const span = Math.max(...events.map(([, t]) => t), rec.seen + Math.max(rec.window ?? 0, 0)) * 1.08 || 1;
  const pct = (t) => `${(100 * t) / span}%`;
  const band =
    rec.window > 0
      ? `<div class="tl-band" style="left:${pct(rec.seen)};width:${pct(rec.window)}"></div>`
      : '';
  const reacted = rec.reaction != null ? ` · you ${dodge ? 'moved' : 'reacted'} in ${ms(rec.reaction)}` : '';

  el.innerHTML = `
    <h3>Round ${rec.n}${dodge ? ' (dodge)' : ''} · ${rec.varied === 'bot' ? 'bot' : 'your'} ping ${rec.value} ms —
      ${OUTCOME_TEXT[rec.outcome]}${reacted} · window ${ms(rec.window)}</h3>
    ${events
      .map(
        ([label, t, cls, active]) => `<div class="tl-row${active ? '' : ' dim'}">
          <span class="tl-label">${label}</span>
          <div class="tl-track">${band}
            <div class="tl-dot ${cls}" style="left:${pct(t)}"></div>
            <span class="tl-val${t / span > 0.8 ? ' flip' : ''}" style="left:${pct(t)}">${ms(t)}</span>
          </div>
        </div>`,
      )
      .join('')}`;
  el.hidden = false;
}

const CSV_COLUMNS = [
  'n', 'time', 'scenario', 'varied', 'value', 'botPing', 'yourPing', 'botJitter', 'botLoss',
  'yourJitter', 'yourLoss', 'tickRate', 'interpMs', 'botReaction', 'botAim', 'serverSaw', 'seen',
  'botAimStart', 'botFire', 'botFired', 'botShotServer', 'click', 'reaction', 'yourShotServer',
  'moveServer', 'hiddenForYou', 'hiddenForHim', 'deathShown', 'window', 'outcome',
];

export function toCSV(results) {
  const fmt = (v) => (typeof v === 'number' ? v.toFixed(1) : v ?? '');
  return [CSV_COLUMNS.join(','), ...results.map((r) => CSV_COLUMNS.map((c) => fmt(r[c])).join(','))].join('\n');
}
