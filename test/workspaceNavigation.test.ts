import assert from 'node:assert/strict';
import test from 'node:test';
import { modeFeatures, startsPan, toggleMapFocus } from '../src/state/workspace.ts';

test('the explicit pan tool makes an ordinary primary drag pan', () => {
  assert.equal(startsPan('pan', { button: 0, altKey: false, spaceHeld: false }), true);
  assert.equal(startsPan('select', { button: 0, altKey: false, spaceHeld: false }), false);
});

test('the existing temporary pan gestures work in either tool', () => {
  assert.equal(startsPan('select', { button: 0, altKey: false, spaceHeld: true }), true);
  assert.equal(startsPan('select', { button: 0, altKey: true, spaceHeld: false }), true);
  assert.equal(startsPan('select', { button: 1, altKey: false, spaceHeld: false }), true);
  assert.equal(startsPan('select', { button: 2, altKey: false, spaceHeld: false }), true);
});

test('map focus restores exactly the panels that were open', () => {
  const focused = toggleMapFocus(
    { layers: true, inspector: false },
    { layers: true, inspector: true },
  );
  assert.deepEqual(focused, {
    panels: { layers: false, inspector: false },
    previous: { layers: true, inspector: false },
  });
  assert.deepEqual(toggleMapFocus(focused.panels, focused.previous).panels, {
    layers: true,
    inspector: false,
  });
});

test('map focus has a safe restore state when no previous panel was open', () => {
  assert.deepEqual(
    toggleMapFocus(
      { layers: false, inspector: false },
      { layers: false, inspector: false },
    ).panels,
    { layers: true, inspector: true },
  );
});

test('each mode shows exactly one family of tools', () => {
  assert.deepEqual(modeFeatures('ai'), { ai: true, manual: false });
  assert.deepEqual(modeFeatures('manual'), { ai: false, manual: true });
});
