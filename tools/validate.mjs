// Local gate validator for token-radar-01. Checks every scorer rule against out/
// with real numbers. Run: node tools/validate.mjs [outDir] [snapshotPath]
// Standard library only; imports the vendored dossier library to rebuild the dossier.
import { readFileSync, readdirSync, statSync, lstatSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from '../vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '..');
const out = process.argv[2] ? join(process.argv[2]) : join(repo, 'out');
const snapPath = process.argv[3] ?? 'C:/Users/kenvy/AppData/Local/hermes/cache/scratch/makefun/token-radar-01-kit/input/snapshot.json';
const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
const protoSlugs = new Set(snap.protocols.map((p) => p.slug));
const watchlist = new Set(snap.watchlist);

const results = [];
function check(name, pass, detail) { results.push({ name, pass, detail }); }
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// ---- board.json ----
const boardPath = join(out, 'board.json');
const boardBytes = readFileSync(boardPath);
let board = null, rows = null;
try {
  board = JSON.parse(boardBytes.toString('utf8'));
  rows = Array.isArray(board) ? board : board.rows;
} catch (e) { check('board_file', false, 'not JSON: ' + e.message); }

if (rows) {
  const isObj = board !== null && typeof board === 'object' && !Array.isArray(board);
  const sizeOk = boardBytes.length <= 8 * 1024 * 1024;
  const countOk = rows.length >= 100 && rows.length <= 4000;
  let rowErr = null;
  const seen = new Set();
  for (const r of rows) {
    if (typeof r.slug !== 'string' || r.slug.length < 1 || r.slug.length > 128 || /\s/.test(r.slug)) { rowErr = 'bad slug ' + r.slug; break; }
    if (!protoSlugs.has(r.slug)) { rowErr = 'invented slug ' + r.slug; break; }
    if (seen.has(r.slug)) { rowErr = 'duplicate slug ' + r.slug; break; }
    seen.add(r.slug);
    if (typeof r.name !== 'string' || r.name.trim() === '') { rowErr = 'empty name ' + r.slug; break; }
    if (!Number.isSafeInteger(r.rank) || r.rank <= 0) { rowErr = 'bad rank ' + r.slug; break; }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) { rowErr = 'bad implied ' + r.slug + '=' + r.implied_value_usd; break; }
    if (!Array.isArray(r.farm_steps)) { rowErr = 'farm_steps not array ' + r.slug; break; }
  }
  const allSame = rows.length >= 2 && rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd);
  check('board_file', isObj && sizeOk && countOk && !rowErr && !allSame,
    `object=${isObj} bytes=${boardBytes.length} (<=8MiB ${sizeOk}) rows=${rows.length} (100..4000 ${countOk}) rowErr=${rowErr ?? 'none'} allSameValue=${allSame}`);

  // sorted_by_value
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  const ranksExact = byRank.every((r, i) => r.rank === i + 1);
  let monotonic = true;
  for (let i = 1; i < byRank.length; i++) if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) { monotonic = false; break; }
  check('sorted_by_value', ranksExact && monotonic && !allSame,
    `ranks 1..${rows.length} exactly once=${ranksExact} non-increasing=${monotonic} top=$${byRank[0]?.implied_value_usd} bottom=$${byRank[byRank.length - 1]?.implied_value_usd}`);

  // coverage
  const missing = [...watchlist].filter((s) => !seen.has(s));
  const early = rows.filter((r) => !watchlist.has(r.slug)).length;
  check('coverage', missing.length === 0 && early >= 60,
    `watchlist ${watchlist.size - missing.length}/${watchlist.size} covered (missing=${missing.length ? missing.join(',') : 'none'}) non-watchlist rows=${early} (>=60 ${early >= 60})`);

  // farm_steps
  let farmErr = null, minLen = 1e9, maxLen = 0, minSteps = 1e9, maxSteps = 0;
  for (const r of rows) {
    const st = r.farm_steps;
    minSteps = Math.min(minSteps, st.length); maxSteps = Math.max(maxSteps, st.length);
    if (st.length < 3 || st.length > 12) { farmErr = r.slug + ' has ' + st.length + ' steps'; break; }
    for (const s of st) {
      if (typeof s !== 'string') { farmErr = r.slug + ' non-string step'; break; }
      const t = s.trim();
      minLen = Math.min(minLen, t.length); maxLen = Math.max(maxLen, t.length);
      if (t.length < 20 || t.length > 600) { farmErr = r.slug + ' step len ' + t.length; break; }
    }
    if (farmErr) break;
  }
  check('farm_steps', !farmErr, `steps/row ${minSteps}..${maxSteps} (3..12) trimmed chars ${minLen}..${maxLen} (20..600) err=${farmErr ?? 'none'}`);
}

// ---- dashboard files + no-network ----
const dashDir = join(out, 'dashboard');
function walk(dir, base) {
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (e.name.startsWith('.')) return { files, err: 'dot-directory ' + rel };
      const sub = walk(p, rel);
      if (sub.err) return sub;
      files.push(...sub.files);
    } else if (e.isFile()) {
      if (!PLAIN.test(e.name)) return { files, err: 'bad name ' + rel };
      files.push({ rel, path: p, size: lstatSync(p).size });
    } else return { files, err: 'not file/dir ' + rel };
  }
  return { files, err: null };
}
const w = walk(dashDir, '');
const files = w.files;
const totalBytes = files.reduce((n, f) => n + f.size, 0);
const hasHtml = files.some((f) => f.rel === 'index.html');
const hasCss = files.some((f) => f.rel.endsWith('.css'));
const hasJs = files.some((f) => f.rel.endsWith('.js'));

// no-network scan
function netOffenders(rel, text) {
  const off = [];
  const ext = rel.slice(rel.lastIndexOf('.'));
  if (ext === '.html') {
    // attribute values
    for (const m of text.matchAll(/=\s*("([^"]*)"|'([^']*)')/g)) {
      const v = m[2] ?? m[3] ?? '';
      if (/https?:\/\//i.test(v)) off.push('attr:' + v.slice(0, 60));
    }
    // <style> body
    for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) if (/https?:\/\//i.test(m[1])) off.push('style-body');
    // inline script import specifiers
    for (const m of text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
      for (const im of m[1].matchAll(/(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']/g)) {
        const spec = im[1] ?? im[2] ?? im[3] ?? '';
        if (/https?:\/\//i.test(spec)) off.push('inline-script-import:' + spec);
      }
    }
  } else if (ext === '.css') {
    if (/https?:\/\//i.test(text)) off.push('css-url');
  } else if (ext === '.js' || ext === '.mjs') {
    for (const im of text.matchAll(/(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']|require\s*\(\s*["']([^"']+)["']/g)) {
      const spec = im[1] ?? im[2] ?? im[3] ?? '';
      if (/https?:\/\//i.test(spec)) off.push('js-import:' + spec);
    }
  }
  return off;
}
let netErr = null;
for (const f of files) {
  const ext = f.rel.slice(f.rel.lastIndexOf('.'));
  if (['.html', '.css', '.js', '.mjs'].includes(ext)) {
    const off = netOffenders(f.rel, readFileSync(f.path, 'utf8'));
    if (off.length) { netErr = f.rel + ' -> ' + off.join('; '); break; }
  }
}
check('dashboard_files', !w.err && hasHtml && hasCss && hasJs && files.length <= 400 && totalBytes <= 4 * 1024 * 1024 && !netErr,
  `files=${files.length} (<=400) bytes=${totalBytes} (<=4MiB) index.html=${hasHtml} css=${hasCss} js=${hasJs} nameErr=${w.err ?? 'none'} networkErr=${netErr ?? 'none'}`);

// source byte budget (dossier shows whole only under 65536)
const srcBytes = files.filter((f) => /\.(html|css|js|json|mjs|svg|md|txt)$/.test(f.rel)).reduce((n, f) => n + f.size, 0);
check('source_under_64KB', srcBytes < 65536, `dashboard source bytes=${srcBytes} (<65536 ${srcBytes < 65536})`);

// ---- screenshots ----
const shotDir = join(out, 'screenshots');
const shotNames = existsSync(shotDir) ? readdirSync(shotDir).filter((n) => !n.startsWith('.') && lstatSync(join(shotDir, n)).isFile()).sort() : [];
function pngInfo(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  const w = buf.readUInt32BE(16), hh = buf.readUInt32BE(20);
  const iend = buf.lastIndexOf(Buffer.from('IEND'));
  return { w, h: hh, whole: iend > 0 && buf.length >= iend + 8 };
}
function jpgInfo(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2, w = 0, hh = 0;
  while (i < buf.length - 1) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      hh = buf.readUInt16BE(i + 5); w = buf.readUInt16BE(i + 7); break;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2); i += 2 + len;
  }
  const eoi = buf.lastIndexOf(Buffer.from([0xff, 0xd9]));
  return { w, h: hh, whole: eoi > 0 && buf.length >= eoi + 2 };
}
let shotErr = null; const shotDetail = [];
for (const n of shotNames) {
  if (!PLAIN.test(n)) { shotErr = 'bad name ' + n; break; }
  const buf = readFileSync(join(shotDir, n));
  if (buf.length > 512 * 1024) { shotErr = n + ' ' + buf.length + ' bytes > 512KiB'; break; }
  const info = pngInfo(buf) ?? jpgInfo(buf);
  if (!info) { shotErr = n + ' not a whole PNG/JPEG'; break; }
  if (!info.whole) { shotErr = n + ' truncated image'; break; }
  const long = Math.max(info.w, info.h), short = Math.min(info.w, info.h);
  if (long > 1440 || short < 800) { shotErr = n + ' ' + info.w + 'x' + info.h + ' out of bounds'; break; }
  shotDetail.push(`${n} ${info.w}x${info.h} ${buf.length}B`);
}
const shotCountOk = shotNames.length >= 3 && shotNames.length <= 4;
check('screenshots', shotCountOk && !shotErr, `count=${shotNames.length} (3..4 ${shotCountOk}) err=${shotErr ?? 'none'} [${shotDetail.join(' | ')}]`);

// ---- dossier matches ----
const dossierPath = join(out, 'dossier.json');
const dossierBytes = readFileSync(dossierPath);
let rebuilt = null, rebuildErr = null;
try {
  rebuilt = buildDossier(out, { text_max_bytes: 65536, screenshots: { max: 4, max_bytes: 524288 }, dashboard: { max_files: 400, max_bytes: 4194304 } });
} catch (e) { rebuildErr = e.message; }
const byteEqual = rebuilt !== null && Buffer.compare(Buffer.from(rebuilt), dossierBytes) === 0;
const dossierSizeOk = dossierBytes.length <= 1.5 * 1024 * 1024;
let cut = null;
try { cut = JSON.parse(dossierBytes.toString('utf8')).text.includes('[Cut at'); } catch { cut = 'parse-fail'; }
check('dossier_matches', byteEqual && dossierSizeOk && !rebuildErr,
  `byteEqual=${byteEqual} bytes=${dossierBytes.length} (<=1.5MiB ${dossierSizeOk}) rebuildErr=${rebuildErr ?? 'none'} textCut=${cut}`);

// ---- report ----
let allPass = true;
console.log('GATE VALIDATION — ' + out);
for (const r of results) {
  if (!r.pass) allPass = false;
  console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`);
}
console.log(allPass ? '\nALL CHECKS PASS' : '\nSOME CHECKS FAILED');
process.exit(allPass ? 0 : 1);
