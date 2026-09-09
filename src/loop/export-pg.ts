/**
 * Book export (DESIGN §11 / GAPS.md 2.2). There was no way to get the book
 * out at all — not text, not markdown, not anything — which is a strange
 * hole for a writing tool. Markdown and plain text cover it; scene and
 * chapter headings come from the compaction work (`Compactor`/`chapters()`/
 * `scenes()`), already there for the timeline and the book view's own
 * scene breaks.
 *
 * Deliberately reads only what `GET /api/book`/`GET /api/chapters` already
 * expose — `Turn.bookProse`, `chronicle.scenes()`, `chronicle.chapters()` —
 * rather than inventing a second rendering path. `bookProse` is what a
 * reader is meant to read (DESIGN §7.2's "prose is a view of state"); the
 * raw player input and mechanical meta stay in the app, not the export.
 */
import type { World } from '../store/index-pg.ts';

export interface ExportOptions {
  /** Book title, defaulting to the world's own title (`meta.worldTitle`) or "Untitled". */
  title?: string;
  /** Includes the scene-level summary written by `Compactor.summariseScene`, when one exists, before that scene's turns. */
  includeSceneSummaries?: boolean;
}

/**
 * Markdown export: a title page, then one `##` heading per chapter (using
 * its own summary when compaction wrote one), one `###` per scene, and each
 * turn's `bookProse` as a paragraph. A scene with no chapter row yet (an
 * unclosed final scene, most of the time — see `Compactor.chapterOf`'s own
 * `chapterSize` grouping) still gets its own scene heading, just without a
 * chapter wrapper around it.
 */
export async function exportMarkdown(world: World, opts: ExportOptions = {}): Promise<string> {
  // World identity now lives on `worlds.title` rather than a file-global meta key;
  // `getMeta` still answers for anything else a world remembers. See
  // `chronicle-pg.ts` for why that key could not stay global once a story can read
  // two worlds.
  const [metaTitle, scenes, chapters, turns] = await Promise.all([
    world.chronicle.getMeta('worldTitle', ''),
    world.chronicle.scenes(),
    world.chronicle.chapters(),
    world.chronicle.turns({ limit: 5000 }),
  ]);
  const title = opts.title ?? (metaTitle || 'Untitled');

  const turnsByScene = new Map<number, typeof turns>();
  for (const t of turns) {
    const list = turnsByScene.get(t.scene) ?? [];
    list.push(t);
    turnsByScene.set(t.scene, list);
  }

  const sceneMeta = new Map(scenes.map((s) => [s.scene, s]));
  const chapterMeta = new Map(chapters.map((c) => [c.chapter, c]));

  // Every scene that has either a turn or a recorded `scenes` row, grouped
  // by chapter (defaulting to 1, `upsertScene`'s own default) and ordered —
  // a scene can exist in `scenes` with no turns yet (closed with too few
  // turns to summarise) or have turns with no `scenes` row yet (the current,
  // still-open scene), so the union of both, not either alone.
  const allScenes = new Set<number>([...turnsByScene.keys(), ...sceneMeta.keys()]);
  const orderedScenes = [...allScenes].sort((a, b) => a - b);

  const lines: string[] = [`# ${title}`, ''];
  let currentChapter: number | null = null;

  for (const scene of orderedScenes) {
    const sMeta = sceneMeta.get(scene);
    const chapter = sMeta?.chapter ?? 1;
    if (chapter !== currentChapter) {
      currentChapter = chapter;
      const cMeta = chapterMeta.get(chapter);
      lines.push(`## Chapter ${chapter}${cMeta?.title ? `: ${cMeta.title}` : ''}`, '');
      if (cMeta?.summary) lines.push(cMeta.summary, '');
    }

    lines.push(`### Scene ${scene}${sMeta?.title ? `: ${sMeta.title}` : ''}`, '');
    if (opts.includeSceneSummaries !== false && sMeta?.summary) {
      lines.push(`*${sMeta.summary}*`, '');
    }

    for (const t of turnsByScene.get(scene) ?? []) {
      if (t.bookProse.trim()) lines.push(t.bookProse.trim(), '');
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * Plain text: the same structure, but `#`/`##`/`###`/`*italic*` stripped
 * to a reader-friendly heading style instead — a markdown file opened in a
 * plain text editor renders the hash marks literally, which is not what
 * "plain text" usually means to someone asking for it.
 */
export async function exportPlainText(world: World, opts: ExportOptions = {}): Promise<string> {
  const md = await exportMarkdown(world, opts);
  return md
    .split('\n')
    .map((line) => {
      const h1 = line.match(/^# (.*)$/);
      if (h1) return `${h1[1]}\n${'='.repeat(h1[1]!.length)}`;
      const h2 = line.match(/^## (.*)$/);
      if (h2) return `\n${h2[1]}\n${'-'.repeat(h2[1]!.length)}`;
      const h3 = line.match(/^### (.*)$/);
      if (h3) return h3[1]!;
      const italic = line.match(/^\*(.*)\*$/);
      if (italic) return italic[1]!;
      return line;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}
