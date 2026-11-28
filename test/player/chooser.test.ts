import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFor } from '../../src/player/brain/builds.ts';
import { DEFAULT_TUNING } from '../../src/player/brain/tuning.ts';
import { choose } from '../../src/player/chooser.ts';
import type { ChooserContext } from '../../src/player/chooser.ts';
import { PLAN } from '../../src/player/plan.ts';
import { kitOf, loadValuationKnowledge } from '../../src/player/values.ts';
import type { Snapshot } from '../../src/observations/snapshot.ts';
import { choiceActionProblem } from '../../src/environment/GameEnvironment.ts';
import { validChoices } from '../../src/environment/policies.ts';
import type { ChoiceAction, ChoiceMask, Decision, DecisionKind, DecisionOption, Observation } from '../../src/environment/types.ts';
import { quiet, recorded, vary } from '../helpers.ts';

// The dialogs the plan has no setting for: each has one fixed answer. No game is loaded here; the decisions are
// stand-ins with the shape src/environment/dialogs.ts gives them.

const k = loadValuationKnowledge('mwsewi0r');
const CTX: ChooserContext = { build: buildFor(150), tuning: DEFAULT_TUNING, plan: PLAN, knowledge: k, kit: kitOf(k, 150) };
const base = quiet(recorded('farm-zone1').snap);
const observe = (decision: Decision, mask: ChoiceMask, patch: (s: Snapshot) => void = () => {}): Observation =>
  ({ schema: 3, phase: 'choice', step: 10, simStep: 30, snapshot: vary(base, (s) => { s.state = 'modal'; patch(s); }), decision, mask } as unknown as Observation);
function standIn(kind: DecisionKind, options: { id: string; data?: Record<string, unknown>; ok?: boolean }[], extras: Record<string, boolean>, context: Record<string, unknown> = {}): { decision: Decision; mask: ChoiceMask } {
  const opts: DecisionOption[] = options.map((o) => ({ id: o.id, label: o.id, data: o.data ?? {} }));
  return {
    decision: { kind, method: 'standIn', title: kind, options: opts, extras: Object.fromEntries(Object.keys(extras).map((e) => [e, { needsTarget: false, effect: '' }])), context, serial: 1 },
    mask: { phase: 'choice', options: options.map((o) => o.ok !== false), extras },
  };
}
const answer = (d: { decision: Decision; mask: ChoiceMask }, ctx = CTX) => choose(observe(d.decision, d.mask), ctx);
const picked = (d: { decision: Decision }, a: ChoiceAction): string => ('option' in a ? d.decision.options[a.option].id : `extra:${a.extra}`);

test('the sanctuary and Overtime: the classic path, then Overtime, and only the plan\'s offerings', () => {
  const path = standIn('sanctuaryPath', [{ id: 'sanct' }, { id: 'direct' }], { decline: true });
  assert.equal(picked(path, answer(path).action), 'sanct');
  const leave = standIn('leaveSanctuary', [{ id: 'ot' }, { id: 'leave' }], { decline: true });
  assert.equal(picked(leave, answer(leave).action), 'ot');
  const start = standIn('overtimeStart', [{ id: 'start' }], { decline: true });
  assert.equal(picked(start, answer(start).action), 'start');
  const offer = standIn('overtimeOffer', [{ id: 'rompeolas' }, { id: 'pleamar' }, { id: 'manantial' }], { decline: true }, { round: 2, held: [] });
  assert.equal(picked(offer, answer(offer).action), 'manantial', 'in the plan\'s order of preference');
  const risk = standIn('overtimeOffer', [{ id: 'pleamar' }, { id: 'cebo' }, { id: 'corriente' }], { decline: true }, { round: 4 });
  assert.deepEqual(answer(risk).action, { type: 'choice', extra: 'decline' });
});

test('trade, party, shiny swap, relic, evolution, the dojo and selling: one fixed answer each', () => {
  const trade = standIn('trade', [{ id: 'fossil-a', data: { key: 'fossil-a' } }, { id: 'fossil-b', data: { key: 'fossil-b', off: true }, ok: false }], { decline: true }, { species: 138, help: '' });
  assert.deepEqual(answer(trade).action, { type: 'choice', extra: 'decline' });

  const party = (incoming: number) => standIn('party', [{ id: '0', data: { species: 59, bst: 555, shiny: false } }, { id: '1', data: { species: 19, bst: 253, shiny: true }, ok: false }, { id: '2', data: { species: 16, bst: 251, shiny: false } }], { decline: true }, { incoming: { species: 130, bst: incoming } });
  assert.equal(picked(party(540), answer(party(540)).action), '2', 'the weakest ally that may be released makes room');
  assert.deepEqual(answer(party(200)).action, { type: 'choice', extra: 'decline' }, 'a weaker newcomer leaves');

  const swap = standIn('shinySwap', [{ id: 'swap' }], { decline: true });
  assert.deepEqual(answer(swap).action, { type: 'choice', extra: 'decline' });

  const relic = standIn('relic', [{ id: 'r-a', data: { key: 'r-a' } }, { id: 'r-b', data: { key: 'r-b' } }], { decline: true }, { held: ['x'] });
  assert.equal(picked(relic, answer(relic).action), 'r-a');
  const relicFull = standIn('relic', [{ id: 'r-a@0' }, { id: 'r-a@1' }, { id: 'r-a@2' }], { decline: true }, { held: ['x', 'y', 'z'] });
  assert.deepEqual(answer(relicFull).action, { type: 'choice', extra: 'decline' });

  const evolve = standIn('evolution', [{ id: '134', data: { species: 134 } }, { id: '135', data: { species: 135 } }], { decline: true }, { from: 133 });
  assert.equal(picked(evolve, answer(evolve).action), '134');

  assert.deepEqual(answer(standIn('shopSell', [{ id: 'x' }], { leave: true })).action, { type: 'choice', extra: 'leave' });
  for (const kind of ['dojo', 'dojoPrize'] as const) assert.deepEqual(answer(standIn(kind, [{ id: 'x' }], { decline: true })).action, { type: 'choice', extra: 'decline' });
});

test('a blessing: the one whose text scores best for the build, never one that makes the horde harder', () => {
  const b = standIn('blessing', [{ id: '+25% damage' }, { id: 'more and stronger enemies' }, { id: '+31% experience' }], {});
  const got = picked(b, answer(b).action);
  assert.notEqual(got, 'more and stronger enemies');
  const only = standIn('blessing', [{ id: '+25% damage', ok: false }, { id: '+31% experience' }], {});
  assert.equal(picked(only, answer(only).action), '+31% experience', 'what the mask forbids is not picked');
});

test('every decision kind has a rule; what a rule wants but the mask forbids falls back to a valid action, said so', () => {
  const kinds: DecisionKind[] = ['levelup', 'evolution', 'item', 'itemChoice', 'blessing', 'seals', 'sanctuaryPath', 'leaveSanctuary', 'overtimeStart', 'overtimeOffer', 'trade', 'shop', 'ditto', 'party', 'shinySwap', 'relic', 'dojo', 'dojoPrize', 'slots', 'forget', 'lesson', 'fusion', 'shopSell'];
  for (const kind of kinds) {
    // One odd option and one odd extra that no rule asks for: whatever the rule wanted is not there.
    const d = standIn(kind, [{ id: 'odd', data: { key: 'odd' } }], { confirm: true });
    assert.equal(choiceActionProblem(answer(d).action, d.mask), null, kind);
    // Only the extra is valid.
    const e = standIn(kind, [{ id: 'odd', data: { key: 'odd' }, ok: false }], { confirm: true });
    const ce = answer(e);
    assert.deepEqual(ce.action, validChoices(e.mask)[0], kind);
    assert.match(ce.reason, /first valid action/, kind);
  }
  assert.throws(() => answer(standIn('riddle' as DecisionKind, [{ id: 'a' }], {})), /no rule for decision kind "riddle"/);
  assert.throws(() => answer(standIn('levelup', [{ id: 'a', ok: false }], { refresh: false })), /has no valid action/);
  assert.throws(() => choose({ ...observe(standIn('item', [{ id: 'a' }], {}).decision, { phase: 'choice', options: [true], extras: {} }), phase: 'play' } as Observation, CTX), /outside the choice phase/);
});
