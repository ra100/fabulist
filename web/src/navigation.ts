export const appTabs = [
  'book',
  'timeline',
  'graph',
  'cast',
  'threads',
  'causality',
  'facts',
  'library',
  'settings',
] as const;

export type AppTab = (typeof appTabs)[number];

const tabByPath: Record<string, AppTab> = Object.fromEntries(appTabs.map((tab) => [`/${tab}`, tab])) as Record<
  string,
  AppTab
>;

/** Maps the app shell's browser URL to a tab, while keeping `/` as the book's legacy home. */
export function tabForPath(pathname: string): AppTab {
  const normalised = pathname.replace(/\/+$/, '') || '/';
  return tabByPath[normalised] ?? 'book';
}

export function pathForTab(tab: AppTab): string {
  return `/${tab}`;
}

/**
 * The phone layout's bottom bar holds four destinations plus "more", the
 * three-to-five range both Material's navigation bar and Apple's tab bar
 * settle on: past five, labels shrink below legibility and targets below a
 * thumb. These four are the ones a reader returns to mid-story — the book,
 * where it branched, who is in it, which book it is. The rest are tools,
 * one tap further away in the "more" sheet.
 */
export const primaryMobileTabs = ['book', 'timeline', 'cast', 'library'] as const satisfies readonly AppTab[];

export const secondaryMobileTabs: readonly AppTab[] = appTabs.filter(
  (tab) => !(primaryMobileTabs as readonly AppTab[]).includes(tab),
);
