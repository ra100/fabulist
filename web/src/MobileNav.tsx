import { useEffect, useState } from 'react';
import { type AppTab, primaryMobileTabs, secondaryMobileTabs } from './navigation.ts';

/*
  The phone layout's navigation. Hidden by CSS above 960px, where the topbar's
  own tab row still fits; below it the topbar keeps only the masthead and
  this bar takes over at the bottom edge, inside the thumb's reach rather
  than across the top of a tall screen.

  Line icons drawn on a 24px grid in `currentColor`, not glyphs or emoji —
  every label stays visible beside its icon, since an unlabelled icon row
  is a guessing game for anything less universal than "home".
*/

const iconPaths: Record<AppTab | 'more', string> = {
  book: 'M3.5 5.5c2.8-1.2 5.6-1 8.5 1 2.9-2 5.7-2.2 8.5-1v13c-2.8-1.2-5.6-1-8.5 1-2.9-2-5.7-2.2-8.5-1zM12 6.5v13',
  timeline: 'M6 3.5v17M6 8c0 3 3 4 7 4h5M6 8a1.8 1.8 0 1 0 0-.01M18 12a1.8 1.8 0 1 0 0-.01',
  cast: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19.5c.7-3.3 2.8-5.5 5.5-5.5s4.8 2.2 5.5 5.5M16 10.5a2.4 2.4 0 1 0 0-4.8M17 14c2 .4 3.3 2.2 3.8 5',
  library: 'M4.5 4.5h3.5v15H4.5zM10 4.5h3.5v15H10zM15.6 5.4l3-.8 3.4 14.2-3 .8z',
  graph: 'M6 7a2 2 0 1 0 0-.01M18 6a2 2 0 1 0 0-.01M12 18a2 2 0 1 0 0-.01M7.8 7.8l3 8.4M16.4 7.6l-3.2 8.6M8 6.8l8-.6',
  threads: 'M4 7c4 0 4 10 8 10s4-10 8-10M4 17c4 0 4-10 8-10s4 10 8 10',
  causality: 'M4 6h5v4H4zM15 14h5v4h-5zM9 8h3a2 2 0 0 1 2 2v4m0 0-2-2m2 2 2-2',
  facts: 'M5 4.5h10l4 4v11H5zM15 4.5v4h4M8.5 12.5h7M8.5 16h5',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l1.8-1-1.5-2.6-2 .4a7 7 0 0 0-1.7-1L15 5.8h-3l-.6 2a7 7 0 0 0-1.7 1l-2-.4L6.2 11 8 12l-1.8 1 1.5 2.6 2-.4a7 7 0 0 0 1.7 1l.6 2h3l.6-2a7 7 0 0 0 1.7-1l2 .4 1.5-2.6z',
  more: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
};

function NavIcon({ name }: { name: AppTab | 'more' }) {
  return (
    <svg
      className="nav-icon"
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3 : 1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={iconPaths[name]} />
    </svg>
  );
}

export function MobileNav({
  tab,
  onNavigate,
  account,
  onSignOut,
}: {
  tab: AppTab;
  onNavigate: (tab: AppTab) => void;
  /** Who is signed in, when login is on — the topbar has no room for the account row on a phone, so it lives in "more". */
  account: string | null;
  onSignOut: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  const inMore = secondaryMobileTabs.includes(tab);

  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  const go = (t: AppTab) => {
    setMoreOpen(false);
    onNavigate(t);
  };

  return (
    <>
      {moreOpen ? <div className="sheet-scrim" onClick={() => setMoreOpen(false)} aria-hidden="true" /> : null}
      {moreOpen ? (
        <div className="sheet more-sheet" role="dialog" aria-label="more views">
          <div className="sheet-grip" aria-hidden="true" />
          <ul>
            {secondaryMobileTabs.map((t) => (
              <li key={t}>
                <button
                  type="button"
                  className={tab === t ? 'active' : ''}
                  aria-current={tab === t ? 'page' : undefined}
                  onClick={() => go(t)}
                >
                  <NavIcon name={t} />
                  {t}
                </button>
              </li>
            ))}
          </ul>
          {account ? (
            <div className="more-sheet-account">
              <span className="dim">signed in as {account}</span>
              <button type="button" className="account-signout" onClick={onSignOut}>
                sign out
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <nav className="bottom-nav" aria-label="views">
        {primaryMobileTabs.map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t && !moreOpen ? 'active' : ''}
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => go(t)}
          >
            <NavIcon name={t} />
            <span>{t}</span>
          </button>
        ))}
        <button
          type="button"
          className={inMore || moreOpen ? 'active' : ''}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          onClick={() => setMoreOpen((v) => !v)}
        >
          <NavIcon name="more" />
          <span>{inMore && !moreOpen ? tab : 'more'}</span>
        </button>
      </nav>
    </>
  );
}
