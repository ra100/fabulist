import { Fragment, useEffect, useState } from 'react';
import { api, type Timeline } from '../api.ts';

export function TimelineView() {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [reveal, setReveal] = useState<Set<number>>(new Set());

  useEffect(() => {
    void api.timeline().then(setTimeline);
  }, []);

  if (!timeline) return <div className="main"><div className="pane"><p className="empty">Loading.</p></div></div>;

  const chapterMeta = new Map(timeline.chapters.map((c) => [c.chapter, c]));
  const byChapter = new Map<number, Timeline['scenes']>();
  for (const scene of timeline.scenes) {
    const list = byChapter.get(scene.chapter) ?? [];
    list.push(scene);
    byChapter.set(scene.chapter, list);
  }
  const chapterNumbers = [...byChapter.keys()].sort((a, b) => a - b);

  return (
    <div className="main">
      <div className="pane">
        <div className="measure-tool">
          <p className="lede">
            The record of how this playthrough actually went — where it diverged from canon, and by how
            much, scene by scene.
          </p>
          {timeline.scenes.length === 0 ? <p className="empty">Nothing played yet.</p> : null}
          <div className="timeline">
            {chapterNumbers.map((chapter) => {
              const chapterInfo = chapterMeta.get(chapter);
              return (
                <Fragment key={chapter}>
                  <div className="timeline-chapter-head">
                    <span>Chapter {chapter}{chapterInfo?.title ? `: ${chapterInfo.title}` : ''}</span>
                  </div>
                  {chapterInfo?.summary ? (
                    <p className="small dim" style={{ margin: '0 0 var(--s3)' }}>{chapterInfo.summary}</p>
                  ) : null}
                  {byChapter.get(chapter)!.map((scene) => (
                    <div
                      key={scene.scene}
                      className={`timeline-scene${scene.scene === timeline.currentScene ? ' current' : ''}`}
                    >
                      <div className="row baseline">
                        <span className="mono" style={{ minWidth: '3.5rem' }}>s{scene.scene}</span>
                        <span className="grow small">{scene.title || (scene.turnCount ? '' : 'not yet played')}</span>
                        <span className="dimmer small">
                          {scene.turnCount} turn{scene.turnCount === 1 ? '' : 's'}
                        </span>
                        {scene.scene === timeline.currentScene ? <span className="tag locked">current</span> : null}
                      </div>
                      {scene.summary ? <p className="small dim" style={{ margin: '4px 0 0' }}>{scene.summary}</p> : null}
                      {scene.divergences.length ? (
                        <div className="stack" style={{ marginTop: 'var(--s2)' }}>
                          {scene.divergences.map((divergence) => {
                            const open = reveal.has(divergence.id);
                            return (
                              <div key={divergence.id} className="timeline-divergence">
                                <div className="row baseline">
                                  <span className="tag chronicle">{divergence.kind}</span>
                                  <span className="small grow">{divergence.detail}</span>
                                  {divergence.canon ? (
                                    <button
                                      className="link"
                                      onClick={() => setReveal((previous) => {
                                        const next = new Set(previous);
                                        if (next.has(divergence.id)) next.delete(divergence.id);
                                        else next.add(divergence.id);
                                        return next;
                                      })}
                                    >
                                      {open ? 'hide canon' : 'vs. canon'}
                                    </button>
                                  ) : null}
                                </div>
                                {open && divergence.canon ? (
                                  <p className="small dimmer" style={{ margin: '2px 0 0' }}>{divergence.canon}</p>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </Fragment>
              );
            })}
          </div>
        </div>
      </div>
      <aside className="side">
        <div className="card">
          <h3>reading this</h3>
          <p className="small dim">
            Every divergence here is a real branch point — the story went one way, the source material
            (or the setup) said another. That gap is what makes this a playthrough of the world rather
            than a transcript of it.
          </p>
          <div className="small dimmer" style={{ marginTop: 'var(--s3)' }}>
            {timeline.divergenceCount} divergence{timeline.divergenceCount === 1 ? '' : 's'} total
          </div>
        </div>
      </aside>
    </div>
  );
}
