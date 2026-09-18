import type { Sheet } from '../api.ts';

export type SheetPatchBuilder = (sheet: Sheet) => Partial<Sheet>;

export function createSheetSaveQueue(
  initialSheet: Sheet,
  persist: (entityId: string, patch: Partial<Sheet>) => Promise<Sheet>,
  onSaved: (sheet: Sheet) => void,
) {
  let latest = initialSheet;
  let queue = Promise.resolve();

  return {
    updateBase(sheet: Sheet) {
      latest = sheet;
    },
    save(buildPatch: SheetPatchBuilder): Promise<void> {
      const run = async () => {
        const updated = await persist(latest.entityId, buildPatch(latest));
        latest = updated;
        onSaved(updated);
      };
      queue = queue.then(run, run);
      return queue;
    },
  };
}
