import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, describeSetup } from '../src/survey.js';

// Minimal round records: only the fields the comparison reads.
const rec = (o) => ({
  scenario: 'shoot', varied: 'bot', value: 100, seen: 80, reaction: 280,
  botReaction: 250, botAim: 150, deathShown: null, outcome: 'win', ...o,
});
const many = (n, o) => Array.from({ length: n }, () => rec(o));
const row = (rows, id) => rows.find((r) => r.id === id);

test('nothing measured yet: every row offers a test to set up', () => {
  const rows = compare({ loseHeld: 'often' }, []);
  for (const r of rows) {
    assert.equal(r.verdict, 'untested');
    assert.ok(r.setup, r.id);
  }
  assert.equal(row(rows, 'behindCover').setup.scenario, 'dodge');
  assert.equal(row(rows, 'ownLagWorse').setup.target, 'you');
});

test('your answered ping becomes your base ping in suggested tests', () => {
  const rows = compare({ ping: 35 }, []);
  assert.equal(row(rows, 'loseHeld').setup.yourPing, 35);
  assert.match(describeSetup(row(rows, 'loseHeld').setup), /your ping 35 ms/);
});

test('a matching rate is reported as a match', () => {
  const results = [...many(7, { outcome: 'loss', deathShown: 400 }), ...many(3, {})];
  const r = row(compare({ loseHeld: 'often' }, results), 'loseHeld');
  assert.equal(r.verdict, 'match');
  assert.equal(r.measured.as, 'Often');
  assert.equal(r.measured.n, 10);
});

test('feeling instant deaths the slow bot never produces points at a faster peeker', () => {
  const results = many(10, { outcome: 'loss', deathShown: 80 + 385 });
  const r = row(compare({ instantDeath: 'often' }, results), 'instantDeath');
  assert.equal(r.verdict, 'lower');
  assert.equal(r.setup.botReaction, 150);
  assert.match(r.note, /400 ms/);
});

test('an instant death is one that lands inside your median reaction', () => {
  const results = many(10, { outcome: 'loss', deathShown: 80 + 200 });
  const r = row(compare({ instantDeath: 'always' }, results), 'instantDeath');
  assert.equal(r.verdict, 'match');
});

test('far peekers: holding-only results send you to the Dodge test', () => {
  const results = [...many(5, { value: 10 }), ...many(5, { value: 500 })];
  const r = row(compare({ farWorse: 'much-worse' }, results), 'farWorse');
  assert.equal(r.verdict, 'higher');
  assert.equal(r.setup.scenario, 'dodge');
});

test('far peekers: dying behind cover against them matches "much worse"', () => {
  const dodge = { scenario: 'dodge' };
  const results = [
    ...many(5, { ...dodge, value: 10, outcome: 'escaped' }),
    ...many(5, { ...dodge, value: 500, outcome: 'killed-behind-cover', deathShown: 700 }),
  ];
  const rows = compare({ farWorse: 'much-worse', behindCover: 'sometimes' }, results);
  assert.equal(row(rows, 'farWorse').verdict, 'match');
  assert.match(row(rows, 'farWorse').measured.text, /Dodging 100% → 0% escaped/);
  assert.equal(row(rows, 'behindCover').measured.as, 'Often'); // 5 of 10
});

test('reaction guess is compared with your median reaction', () => {
  const r = row(compare({ reaction: 'lt200' }, many(6, { reaction: 310 })), 'reaction');
  assert.equal(r.verdict, 'higher');
  assert.equal(r.verdictText, 'You are slower than you think');
});

test('measured but unanswered rows say so', () => {
  const r = row(compare({}, many(6, {})), 'loseHeld');
  assert.equal(r.verdict, 'unanswered');
  assert.equal(r.measured.as, 'Never');
});
