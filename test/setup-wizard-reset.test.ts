import test from 'node:test';
import assert from 'node:assert/strict';
import { resetSetupWizardState, type SetupWizardResetters } from '../web/src/views/setupWizardReset.ts';

test('setup wizard reset clears every transient selection and result', () => {
  const calls = new Map<string, unknown[]>();
  const setter = (name: string) => (value: unknown) => {
    calls.set(name, [...(calls.get(name) ?? []), value]);
  };
  const state = Object.fromEntries([
    'setStep', 'setBusy', 'setError', 'setUniverse', 'setCandidates', 'setWiki', 'setWish',
    'setPlan', 'setPreview', 'setRefined', 'setPageBudget', 'setPassBBudget', 'setJob',
    'setCustomDesc', 'setCast', 'setCastSketch', 'setOpening', 'setPacks', 'setPack',
    'setDismissedOffer',
  ].map((name) => [name, setter(name)])) as unknown as SetupWizardResetters;

  resetSetupWizardState(state);

  assert.deepEqual(Object.fromEntries(calls), {
    setStep: ['source'],
    setBusy: [false],
    setError: [null],
    setUniverse: [''],
    setCandidates: [[]],
    setWiki: [null],
    setWish: [''],
    setPlan: [null],
    setPreview: [null],
    setRefined: [false],
    setPageBudget: [''],
    setPassBBudget: [''],
    setJob: [null],
    setCustomDesc: [''],
    setCast: [[]],
    setCastSketch: [null],
    setOpening: [''],
    setPacks: [null],
    setPack: [null],
    setDismissedOffer: [false],
  });
});
