import type {
  CandidateCharacter,
  CharacterSketch,
  IngestPlan,
  Job,
  PackSummary,
  PreviewResult,
  WikiCandidate,
} from '../api.ts';

type Setter<T> = (value: T) => void;

export interface SetupWizardResetters {
  setStep: Setter<'source'>;
  setBusy: Setter<boolean>;
  setError: Setter<string | null>;
  setUniverse: Setter<string>;
  setCandidates: Setter<WikiCandidate[]>;
  setWiki: Setter<WikiCandidate | null>;
  setWish: Setter<string>;
  setPlan: Setter<IngestPlan | null>;
  setPreview: Setter<PreviewResult | null>;
  setRefined: Setter<boolean>;
  setPageBudget: Setter<string>;
  setPassBBudget: Setter<string>;
  setJob: Setter<Job | null>;
  setCustomDesc: Setter<string>;
  setCast: Setter<CandidateCharacter[]>;
  setCastSketch: Setter<CharacterSketch | null>;
  setOpening: Setter<string>;
  setPacks: Setter<PackSummary[] | null>;
  setPack: Setter<PackSummary | null>;
  setSwitchingProfile: Setter<boolean>;
  setDismissedOffer: Setter<boolean>;
}

/** Return every transient wizard field to the state of a new wizard. */
export function resetSetupWizardState(state: SetupWizardResetters): void {
  state.setStep('source');
  state.setBusy(false);
  state.setError(null);
  state.setUniverse('');
  state.setCandidates([]);
  state.setWiki(null);
  state.setWish('');
  state.setPlan(null);
  state.setPreview(null);
  state.setRefined(false);
  state.setPageBudget('');
  state.setPassBBudget('');
  state.setJob(null);
  state.setCustomDesc('');
  state.setCast([]);
  state.setCastSketch(null);
  state.setOpening('');
  state.setPacks(null);
  state.setPack(null);
  state.setSwitchingProfile(false);
  state.setDismissedOffer(false);
}
