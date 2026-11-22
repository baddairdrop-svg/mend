// main.ts is mend, the CLI SPEC.md specifies. Starting point: the kit's starter (MIT), which did SPEC.md
// sections 1 to 4, 9 and 10. Written for this entry, in this session: section 5 (three-tier line matching),
// section 6 (unified diffs), section 7 (SEARCH/REPLACE blocks), section 8 (V4A patches), and the section 2
// `R <old> -> <new>` output line for moves, which the starter printed as a separate D and A. Node 22, the
// standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Move edits that succeeded in the current run, for the section 2 `R` output line. */
const moveLog: { old: string; new: string }[] = [];

// ---------------------------------------------------------------------------
// Section 3: a file as lines, its own line break, and whether it ends with one
// ---------------------------------------------------------------------------

interface FileModel {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

function toModel(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function fromModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

/** A file an edit creates: LF breaks, and a final one unless the format says otherwise. */
function createdText(lines: string[], finalBreak: boolean): string {
  return fromModel({ lines, br: '\n', finalBreak });
}

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers
// ---------------------------------------------------------------------------

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => stripTrail(s.replace(/^[ \t]+/, ''));
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!tierEq(lines[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs at or after `from` (optionally filtered), or null. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0, keep?: (pos: number) => boolean): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrences(lines, O, t, from);
    if (keep) pos = pos.filter(keep);
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** One line of N: a context line (take the file's own matched line) or a written line. */
type NEnt = { ctx: number } | { text: string };

/**
 * The lines N becomes at a match: context lines are the file's own matched lines; at tier 2 every
 * other line is re-indented, the leading whitespace P of O's first line replaced by the leading
 * whitespace F of the file's first matched line, on lines that are not empty or only whitespace
 * and that start with P.
 */
function renderN(fileLines: string[], pos: number, O: string[], N: NEnt[], tier: number): string[] {
  const F = leadWS(fileLines[pos] ?? '');
  const P = leadWS(O[0] ?? '');
  const out: string[] = [];
  for (const e of N) {
    if ('ctx' in e) {
      out.push(fileLines[pos + e.ctx]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
    out.push(t);
  }
  return out;
}

/** A body line of a unified hunk or a V4A chunk: context, old, new, or a `\` marker. */
interface BodyEnt {
  k: 'ctx' | 'del' | 'add' | 'bs';
  t: string;
}

/** O (the context and `-` lines) and N (the context and `+` lines) of a body, in body order. */
function bodyON(body: BodyEnt[]): { O: string[]; N: NEnt[] } {
  const O: string[] = [];
  const N: NEnt[] = [];
  for (const e of body) {
    if (e.k === 'ctx') {
      O.push(e.t);
      N.push({ ctx: O.length - 1 });
    } else if (e.k === 'del') O.push(e.t);
    else if (e.k === 'add') N.push({ text: e.t });
  }
  return { O, N };
}

/** Whether a `\` line follows the body's last context or `+` line. */
function bsAfterLastWritten(body: BodyEnt[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const e = body[i]!;
    if (e.k === 'ctx' || e.k === 'add') return body[i + 1]?.k === 'bs';
    if (e.k === 'del') return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Section 4: detecting the format
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs
// ---------------------------------------------------------------------------

interface UHunk {
  a: number;
  body: BodyEnt[];
}

interface USection {
  gitOld?: string;
  gitNew?: string;
  hasPair: boolean;
  hdrOld: string | null;
  hdrNew: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** The path a `---` or `+++` line names: after the four characters, to the first tab, trimmed. */
function hdrPath(line: string): string | null {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  const p = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  const startSec = (): USection => {
    sec = { hasPair: false, hdrOld: null, hdrNew: null, newFile: false, delFile: false, hunks: [] };
    sections.push(sec);
    return sec;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^a\/(.*) b\/(.*)$/.exec(l.slice('diff --git '.length));
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSec();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      i += 1;
      continue;
    }
    if (l.startsWith('--- ')) {
      const next = lines[i + 1];
      const hasPlus = next !== undefined && next.startsWith('+++ ');
      if (hasPlus) {
        if (sec && sec.hunks.length === 0 && !sec.hasPair) {
          sec.hdrOld = hdrPath(l);
          sec.hdrNew = hdrPath(next);
          sec.hasPair = true;
        } else {
          const s = startSec();
          s.hdrOld = hdrPath(l);
          s.hdrNew = hdrPath(next);
          s.hasPair = true;
        }
        i += 2;
        continue;
      }
      if (sec && sec.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (!sec) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const body: (BodyEnt & { rawEmpty: boolean })[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ k: 'ctx', t: '', rawEmpty: true });
          continue;
        }
        const c = bl[0]!;
        if (c === ' ') body.push({ k: 'ctx', t: bl.slice(1), rawEmpty: false });
        else if (c === '-') body.push({ k: 'del', t: bl.slice(1), rawEmpty: false });
        else if (c === '+') body.push({ k: 'add', t: bl.slice(1), rawEmpty: false });
        else if (c === '\\') body.push({ k: 'bs', t: bl.slice(1), rawEmpty: false });
        else break;
      }
      while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
      sec.hunks.push({ a: Number(m[1]!), body });
      i = j;
      continue;
    }
    if (sec && sec.hunks.length === 0) {
      if (l.startsWith('rename from ')) sec.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.newFile = true;
      else if (l.startsWith('deleted file mode')) sec.delFile = true;
      // index, mode, similarity and every other header line are ignored.
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath: string | null | undefined = s.hasPair ? s.hdrOld : s.renameFrom !== undefined ? s.renameFrom : s.gitOld;
  const newPath: string | null | undefined = s.hasPair ? s.hdrNew : s.renameTo !== undefined ? s.renameTo : s.gitNew;
  const creation = (s.newFile || oldPath === null) && newPath != null;
  const deletion = !creation && (s.delFile || newPath === null) && oldPath != null;
  return (tree) => {
    if (!creation && !deletion && (oldPath == null || newPath == null)) {
      // A section naming no real file on one side (for example --- /dev/null with
      // +++ /dev/null): there is nothing it can change, and it must not crash.
      return;
    }
    if (creation) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let lastAddBs = false;
      for (const h of s.hunks) {
        h.body.forEach((e, idx) => {
          if (e.k === 'add') {
            out.push(e.t);
            lastAddBs = h.body[idx + 1]?.k === 'bs';
          }
        });
      }
      tree.now.set(p, createdText(out, !lastAddBs));
      return;
    }
    if (deletion) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const from = oldPath!;
    const to = newPath!;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (!safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    const isMove = from !== to;
    if (isMove && tree.get(to) !== null) throw new Fail('exists', to);
    const model = toModel(before);
    let d = 0;
    for (const h of s.hunks) {
      const { O, N } = bodyON(h.body);
      if (O.length === 0) {
        const add = N.map((e) => ('text' in e ? e.text : ''));
        const at = Math.min(h.a + d, model.lines.length);
        const atEnd = at === model.lines.length;
        model.lines.splice(at, 0, ...add);
        if (atEnd && add.length > 0) model.finalBreak = !bsAfterLastWritten(h.body);
        d += add.length;
      } else {
        const found = findTier(model.lines, O, strict);
        if (!found) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        let best = found.positions[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.positions) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            bestDist = dist;
            best = p;
          }
        }
        const reachesEnd = best + O.length === model.lines.length;
        const written = renderN(model.lines, best, O, N, found.tier);
        model.lines.splice(best, O.length, ...written);
        if (reachesEnd) model.finalBreak = !bsAfterLastWritten(h.body);
        d += written.length - O.length;
      }
    }
    if (isMove) {
      tree.now.set(from, null);
      tree.now.set(to, fromModel(model));
      moveLog.push({ old: from, new: to });
    } else {
      tree.now.set(from, fromModel(model));
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks
// ---------------------------------------------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (eq < 0 && lines[j]!.trimEnd() === '=======') eq = j;
      else if (eq >= 0 && lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    blocks.push({ path, oldLines: lines.slice(searchIdx + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map(
    (b): Edit =>
      (tree) => {
        if (!safe(b.path)) throw new Fail('unsafe', b.path);
        if (b.oldLines.length === 0) {
          if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
          tree.now.set(b.path, createdText(b.newLines, true));
          return;
        }
        const before = tree.get(b.path);
        if (before === null) throw new Fail('missing', b.path);
        const model = toModel(before);
        const found = findTier(model.lines, b.oldLines, strict);
        if (!found) throw new Fail('no-match', b.path);
        if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
        const pos = found.positions[0]!;
        const written = renderN(model.lines, pos, b.oldLines, b.newLines.map((t) => ({ text: t })), found.tier);
        model.lines.splice(pos, b.oldLines.length, ...written);
        tree.now.set(b.path, fromModel(model));
      },
  );
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  body: BodyEnt[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = lines.length - 1;
  while (lb >= 0 && blank(lines[lb]!)) lb -= 1;
  if (lb <= fb || lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSecStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = fb + 1;
  while (i < lb) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i += 1;
      const raw: { l: string; n: number }[] = [];
      while (i < lb && !isSecStart(lines[i]!)) {
        raw.push({ l: lines[i]!, n: i + 1 });
        i += 1;
      }
      // Blank lines (empty or only whitespace, section 4) at the end of a section are not part of it.
      while (raw.length > 0 && blank(raw[raw.length - 1]!.l)) raw.pop();
      const content: string[] = [];
      for (const { l: sl, n } of raw) {
        if (sl.startsWith('+')) content.push(sl.slice(1));
        else if (sl === '') content.push('');
        else throw new Exit2(`error: parse ${n}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, createdText(content, true));
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < lb && !isSecStart(lines[i]!)) {
        if (!blank(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updLine = i + 1;
      i += 1;
      const raw: { l: string; n: number }[] = [];
      while (i < lb && !isSecStart(lines[i]!)) {
        raw.push({ l: lines[i]!, n: i + 1 });
        i += 1;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.l)) raw.pop();
      // A Move to line still counts as the section's first line when blank lines precede it.
      {
        const firstContent = raw.findIndex((r) => !blank(r.l));
        if (firstContent > 0 && raw[firstContent]!.l.startsWith('*** Move to: ')) raw.splice(0, firstContent);
      }
      let moveTo: string | undefined;
      let idx = 0;
      if (raw.length > 0 && raw[0]!.l.startsWith('*** Move to: ')) {
        moveTo = raw[0]!.l.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; idx < raw.length; idx += 1) {
        const cl = raw[idx]!.l;
        const n = raw[idx]!.n;
        if (cl.startsWith('@@')) {
          cur = { anchor: cl.slice(2).trim() || null, body: [], eof: false };
          chunks.push(cur);
          continue;
        }
        if (cl === '*** End of File') {
          // It ends the chunk in progress; with none in progress it ends nothing and
          // creates nothing, so the no-chunk rule below still sees the section as it is.
          if (cur) {
            cur.eof = true;
            cur = null;
          }
          continue;
        }
        if (cl === '' || cl[0] === ' ' || cl[0] === '-' || cl[0] === '+') {
          if (!cur) {
            // Only the first chunk may start at a body line; a later one needs an @@ line.
            if (chunks.length > 0) throw new Exit2(`error: parse ${n}`);
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
          }
          if (cl === '') cur.body.push({ k: 'ctx', t: '' });
          else if (cl[0] === ' ') cur.body.push({ k: 'ctx', t: cl.slice(1) });
          else if (cl[0] === '-') cur.body.push({ k: 'del', t: cl.slice(1) });
          else cur.body.push({ k: 'add', t: cl.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${n}`);
      }
      if (chunks.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updLine}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (moveTo !== undefined && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const model = toModel(before);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== null) {
            const anchor = chunk.anchor;
            let at = -1;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const t of tiers) {
              at = -1;
              for (let k = cursor; k < model.lines.length; k += 1) {
                if (tierEq(model.lines[k]!, anchor, t)) {
                  at = k;
                  break;
                }
              }
              if (at >= 0) break;
            }
            if (at < 0) throw new Fail('no-match', path);
            cursor = at + 1;
          }
          const { O, N } = bodyON(chunk.body);
          if (O.length === 0) {
            const add = N.map((e) => ('text' in e ? e.text : ''));
            const at = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
            model.lines.splice(at, 0, ...add);
            cursor = at + add.length;
          } else {
            const found = chunk.eof
              ? findTier(model.lines, O, strict, cursor, (p) => p + O.length === model.lines.length)
              : findTier(model.lines, O, strict, cursor);
            if (!found) throw new Fail('no-match', path);
            const pos = found.positions[0]!;
            const written = renderN(model.lines, pos, O, N, found.tier);
            model.lines.splice(pos, O.length, ...written);
            cursor = pos + written.length;
          }
        }
        if (moveTo !== undefined) {
          tree.now.set(path, null);
          tree.now.set(moveTo, fromModel(model));
          moveLog.push({ old: path, new: moveTo });
        } else {
          tree.now.set(path, fromModel(model));
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the output, the all-or-nothing write
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  moveLog.length = 0;
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moveLog.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moveLog.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, 'A' | 'D' | 'M'>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: { key: string; text: string }[] = [];
  const paired = new Set<string>();
  for (const mv of moveLog) {
    if (changed.get(mv.old) === 'D' && changed.get(mv.new) === 'A' && !paired.has(mv.old) && !paired.has(mv.new)) {
      rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}` });
      paired.add(mv.old);
      paired.add(mv.new);
    }
  }
  for (const [p, k] of changed) {
    if (!paired.has(p)) rows.push({ key: p, text: `${k} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
