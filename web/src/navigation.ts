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
