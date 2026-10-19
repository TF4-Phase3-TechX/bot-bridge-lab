import test from 'node:test';
import assert from 'node:assert/strict';
import { mainSyncDecision, pairDecision } from '../scripts/pr-bridge-policy.mjs';

test('only fast-forward accepted B history into A', () => {
  assert.equal(mainSyncDecision({ equal: true, aIsAncestor: true }), 'current');
  assert.equal(mainSyncDecision({ equal: false, aIsAncestor: true }), 'fast-forward');
  assert.equal(mainSyncDecision({ equal: false, aIsAncestor: false }), 'stop');
});
test('a B merge does not accept newer unmerged A commits', () => {
  assert.equal(pairDecision({ merged: true, headIncluded: true }), 'accepted');
  assert.equal(pairDecision({ merged: true, headIncluded: false }), 'new-commits-pending');
});
test('B rejection stays rejected instead of recreating a PR', () => {
  assert.equal(pairDecision({ merged: false, closed: true }), 'rejected');
});
test('withdrawal is distinct from acceptance', () => {
  assert.equal(pairDecision({ sourceClosed: true }), 'withdrawn');
  assert.equal(pairDecision({}), 'pending');
});
