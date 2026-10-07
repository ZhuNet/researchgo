import { createSignal } from 'solid-js';

import { bytesOf, DEFAULT_TEXT_BUDGET, TextCache } from '../lib/textcache';
import { tauriBackend, type Backend } from '../lib/backend';

/**
 * How the editor is showing one file, and the bounded state that lets it.
 *
 * A file is one of four things, and the probe decides which before any content is
 * read:
 *
 *  - `text` — small enough to hold whole. Read once and rendered by Monaco.
 *  - `oversized` — beyond what can be held in memory at all. Reported with its
 *    size, not rendered: the editor keeps a document as a single string, so a file
 *    past the limit cannot be opened, and pretending otherwise is how an editor
 *    eats a gigabyte of RAM and then janks on every keystroke.
 *  - `binary` — not text at all. Reported, not rendered, the way an editor that
 *    cannot show a file should.
 *  - `missing` — gone or unreadable, with the reason.
 *
 * Whole files are cached under one byte budget and evicted FIFO, so a project with
 * thousands of files opened in a session does not grow without bound.
 */

export type ContentMode = 'probing' | 'text' | 'oversized' | 'binary' | 'missing';

/**
 * Extensions that are never text, whatever a sniff says.
 *
 * A PDF's first few KiB can be plain enough to look like text — the header, the
 * object table and the first streams are mostly ASCII — so the NUL rule does not
 * reliably catch one, and the result would be a text editor full of PDF syntax.
 *
 * Opening a PDF is not the preview. The preview is the channel that shows what
 * the project *compiled*; a PDF file in the tree is just another binary file, and
 * it is reported as one.
 */
const NOT_TEXT = new Set(['.pdf']);

function notTextReason(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = path.slice(dot).toLowerCase();
  if (!NOT_TEXT.has(ext)) return null;
  return 'A PDF is not text, so there is nothing to show here. The preview pane shows the PDF this project builds from its sources.';
}

function oversizedReason(size: number): string {
  const mb = Math.max(1, Math.round(size / (1024 * 1024)));
  return `This file is ${mb} MB, larger than the editor can hold in memory. Open it in an external editor instead.`;
}

export interface ContentProbe {
  path: string;
  size: number;
  mtimeMs: number;
  binary: boolean;
  wholeReadable: boolean;
  /** The probe itself failed; kept so the mode stays honest until a retry. */
  failed: boolean;
}

export interface ArtifactInfo {
  path: string;
  absPath: string;
  size: number;
  builtMs: number;
}

export interface BuildPlan {
  buildable: boolean;
  command: string | null;
  reason: string | null;
  /** Project-relative path the artifact is expected at. */
  artifact: string | null;
  passes: number;
  detail: string | null;
}

export interface BuildOutcome {
  ok: boolean;
  command: string;
  code: number | null;
  output: string;
  durationMs: number;
  artifact: ArtifactInfo | null;
}

export interface EditorLimits {
  /** Whole-file resident budget, in bytes. */
  maxBytes: number;
}

export const DEFAULT_EDITOR_LIMITS: EditorLimits = {
  maxBytes: DEFAULT_TEXT_BUDGET,
};

export function createEditor(
  backend: Backend = tauriBackend,
  limits: Partial<EditorLimits> = {},
) {
  const opts: EditorLimits = { ...DEFAULT_EDITOR_LIMITS, ...limits };

  /** Whole-file contents, bounded by bytes and evicted FIFO. */
  const texts = new TextCache<string>({ maxBytes: opts.maxBytes });
  /** Probed shape of each file, small and cheap; not budgeted by bytes. */
  const probes = new Map<string, ContentProbe>();

  const [revision, setRevision] = createSignal(0);
  const [buildState, setBuildState] = createSignal<
    { phase: 'idle' | 'running' | 'ok' | 'failed'; error: string | null } | null
  >(null);
  const [buildOutput, setBuildOutput] = createSignal<string>('');
  const [buildCommand, setBuildCommand] = createSignal<string>('');
  const [buildDuration, setBuildDuration] = createSignal<number | null>(null);
  const [artifact, setArtifact] = createSignal<ArtifactInfo | null>(null);
  /**
   * What Build would run, so an empty preview can say something true.
   *
   * `null` means "not asked yet", which is different from "asked and there is
   * nothing to build": the first is a moment, the second is a message the reader
   * needs.
   */
  const [plan, setPlan] = createSignal<BuildPlan | null>(null);

  const bump = () => setRevision((n) => n + 1);

  /** Everything held, so switching projects cannot show the last one's buffers. */
  function clearAll(): void {
    texts.clear();
    probes.clear();
    reasons.clear();
    bump();
  }

  /** Moves a resident buffer after a rename, keeping its place in the queue. */
  function moveBuffer(from: string, to: string): void {
    const text = texts.get(from);
    const probe = probes.get(from);
    if (text === undefined && probe === undefined) return;
    texts.delete(from);
    probes.delete(from);
    reasons.delete(from);
    if (text !== undefined) texts.put(to, text, bytesOf(text));
    if (probe) probes.set(to, { ...probe, path: to });
    bump();
  }

  /** Drops every cached thing about a file. Used by the workspace when it knows
   *  the file changed underneath us. */
  function invalidate(path: string): void {
    texts.delete(path);
    probes.delete(path);
    bump();
  }

  /**
   * Pins whatever must not be evicted: the file on screen and anything unsaved.
   *
   * One function rather than a pin per call site, because "forgot to unpin the
   * previous file" is exactly the kind of bug that shows up as a buffer that never
   * goes away, or an edit that vanishes on the next big file.
   */
  function syncPins(active: string | null, unsaved: ReadonlySet<string>): void {
    const wanted = new Set<string>();
    if (active) wanted.add(active);
    for (const path of unsaved) wanted.add(path);
    for (const held of pins) if (!wanted.has(held)) texts.unpin(held);
    for (const path of wanted) {
      if (pins.has(path)) continue;
      texts.pin(path);
    }
    pins.clear();
    for (const path of wanted) pins.add(path);
  }

  const pins = new Set<string>();

  /**
   * Every read below touches a plain Map, which Solid cannot see.
   *
   * `revision()` is therefore read first, on purpose: it is what turns these into
   * reactive reads for any memo or effect that calls them. Without it the editor
   * computed "no content" once and never recomputed — which is exactly the bug
   * where a freshly opened file showed a single empty line number until you
   * switched tabs and back.
   */
  function modeOf(path: string): ContentMode {
    revision();
    if (notTextReason(path)) return 'binary';
    const probe = probes.get(path);
    if (!probe) return 'probing';
    if (probe.failed) return 'missing';
    if (probe.binary) return 'binary';
    return probe.wholeReadable ? 'text' : 'oversized';
  }

  /** Resident whole content, or undefined when the file is not held whole. */
  function contentOf(path: string): string | undefined {
    revision();
    return texts.get(path);
  }

  /**
   * Probes and, if it fits, loads the file.
   *
   * The probe comes first because it is one `stat` plus one small read, and it
   * decides whether reading the content at all is safe.
   */
  async function open(path: string): Promise<ContentMode> {
    const notText = notTextReason(path);
    if (notText) {
      setReason(path, notText);
      if (!probes.has(path)) {
        probes.set(path, {
          path,
          size: 0,
          mtimeMs: 0,
          binary: true,
          wholeReadable: false,
          failed: false,
        });
      }
      bump();
      return 'binary';
    }
    let probe = probes.get(path);
    if (!probe) {
      try {
        const info = await backend.fileInfo(path);
        probe = {
          path,
          size: info.size,
          mtimeMs: info.mtimeMs,
          binary: info.binary,
          wholeReadable: info.wholeReadable,
          failed: false,
        };
      } catch (err) {
        // Recorded as a failed probe rather than merely absent, because absence
        // reads as "not looked at yet" and this file has been looked at and
        // refused. Without it the mode would fall through to `oversized` and draw
        // an empty view of a file that does not exist.
        probes.set(path, {
          path,
          size: 0,
          mtimeMs: 0,
          binary: false,
          wholeReadable: false,
          failed: true,
        });
        setReason(path, String((err as Error)?.message ?? err));
        bump();
        return 'missing';
      }
      probes.set(path, probe);
      bump();
    }
    if (probe.failed) return 'missing';
    if (probe.binary) return 'binary';
    if (!probe.wholeReadable) {
      setReason(path, oversizedReason(probe.size));
      return 'oversized';
    }
    if (!texts.has(path)) await loadWhole(path);
    return texts.has(path) ? 'text' : 'missing';
  }

  async function loadWhole(path: string, force = false): Promise<boolean> {
    if (texts.has(path) && !force) return true;
    try {
      const text = await backend.readFile(path);
      const size = bytesOf(text);
      // Admitted even when it busts the budget on its own: the file being looked
      // at is pinned, and dropping it here would mean re-reading on every
      // keystroke.
      texts.put(path, text, size);
      setReason(path, null);
      bump();
      return true;
    } catch (err) {
      setReason(path, String((err as Error)?.message ?? err));
      bump();
      return false;
    }
  }

  /**
   * Records content the app already has in hand, without another disk read.
   *
   * Used after a save: the editor wrote exactly these bytes, so re-reading them
   * would be a wasted scan and — when the buffer was dropped first — a visible
   * blank-then-refill in the editor.
   */
  function setContent(path: string, text: string): void {
    texts.put(path, text, bytesOf(text));
    setReason(path, null);
    bump();
  }

  const reasons = new Map<string, string | null>();

  function setReason(path: string, reason: string | null): void {
    reasons.set(path, reason);
  }

  function reasonOf(path: string): string | null {
    return reasons.get(path) ?? null;
  }

  function isResident(path: string): boolean {
    revision();
    return texts.has(path);
  }

  function stats() {
    return {
      bytes: texts.bytes,
      files: texts.size,
    };
  }

  async function build(root: string): Promise<BuildOutcome | null> {
    setBuildState({ phase: 'running', error: null });
    setBuildOutput('');
    setBuildDuration(null);
    try {
      const outcome = await backend.buildProject(root);
      setBuildOutput(outcome.output);
      setBuildCommand(outcome.command);
      setBuildDuration(outcome.durationMs);
      setBuildState({ phase: outcome.ok ? 'ok' : 'failed', error: null });
      if (outcome.ok) {
        // Only a build that actually succeeded puts something on screen. A PDF
        // left over from an earlier compile is not the result of this one, and
        // showing it next to a failed build would be a lie twice over.
        setArtifact(outcome.artifact);
      }
      return outcome;
    } catch (err) {
      const message = String((err as Error)?.message ?? err);
      setBuildOutput(message);
      setBuildState({ phase: 'failed', error: message });
      return null;
    }
  }

  /**
   * Asks what building would run. Never sets an artifact: the preview is empty
   * until something is actually compiled.
   */
  async function loadPlan(root: string): Promise<BuildPlan | null> {
    try {
      const found = await backend.buildPlan(root);
      setPlan(found);
      return found;
    } catch (err) {
      setPlan({
        buildable: false,
        command: null,
        reason: null,
        artifact: null,
        passes: 1,
        detail: String((err as Error)?.message ?? err),
      });
      return null;
    }
  }

  return {
    revision,
    bump,
    open,
    invalidate,
    clearAll,
    moveBuffer,
    syncPins,
    modeOf,
    contentOf,
    reasonOf,
    loadWhole,
    setContent,
    isResident,
    stats,
    build,
    buildState,
    buildOutput,
    buildCommand,
    buildDuration,
    artifact,
    plan,
    loadPlan,
  };
}

export type Editor = ReturnType<typeof createEditor>;
