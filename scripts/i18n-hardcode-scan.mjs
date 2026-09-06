/**
 * Incremental UI hardcode scanner for i18n-migrated directories.
 * Heuristic (not a full AST): flags user-facing literals while skipping
 * Tailwind, URLs, imports, IDs, and other technical strings.
 *
 * JSX text detection only matches content after a real HTML/JSX tag
 * (avoids TypeScript generics like Promise<void>).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Directories (relative to repo root) considered migrated for optional full scans. */
export const I18N_MIGRATED_GLOBS = [
  'client/src/features/servers/components',
  'client/src/features/wallet',
  'client/src/features/shop',
  'client/src/features/inventory',
  'client/src/features/roleta',
  'client/src/features/merge',
  'client/src/features/lucky-boxes',
  'client/src/features/black-market',
  'client/src/features/profile',
  'client/src/features/auth',
  'client/src/features/ranking',
  'client/src/features/arcade',
  'client/src/features/roadmap',
  'client/src/features/game'
];

/**
 * Strict gate — files expected clean of A-class UI hardcode after migration.
 * Expand this list as pages finish migration.
 */
export const I18N_STRICT_FILES = [
  'client/src/features/servers/components/ServerRoom.tsx',
  'client/src/features/servers/components/MiningCoinSelect.tsx',
  'client/src/features/servers/components/NftRoomPaybackCard.tsx',
  'client/src/features/ranking/RankingPage.tsx',
  'client/src/features/roadmap/RoadmapPage.tsx',
  'client/src/features/arcade/PartnerGamesPage.tsx',
  'client/src/features/wallet/DepositHistoryPage.tsx',
  'client/src/features/wallet/WithdrawalHistoryPage.tsx',
  'client/src/features/wallet/components/Exchange.tsx',
  'client/src/features/wallet/WalletPage.tsx'
];

const FILE_RE = /\.(tsx|jsx)$/;

const ALLOW_EXACT = new Set([
  'USDC',
  'H/s',
  'N/s',
  'Wh',
  '…',
  '...',
  '—',
  '-',
  '×',
  '•',
  'OK',
  'NFT',
  'GPU',
  'ASIC',
  'GPUs',
  'ASICs',
  'USDT',
  'DAI',
  'GHO',
  'GEMT',
  'cbBTC',
  'Discord',
  'Telegram',
  'Genesis DAO',
  'BlockMiner'
]);

function isTechnicalLiteral(raw) {
  const s = raw.trim();
  if (!s || s.length < 3) return true;
  if (ALLOW_EXACT.has(s)) return true;
  if (/^https?:\/\//i.test(s)) return true;
  if (/^\/[a-z0-9/_-]+$/i.test(s)) return true;
  if (/^#[0-9a-f]{3,8}$/i.test(s)) return true;
  if (/\$\{/.test(s)) return true;
  if (/^(STATE_|IDEMPOTENCY|ROOM_|POST_|GET_)/.test(s)) return true;
  if (/^[a-z0-9_.:/-]+$/i.test(s) && !/\s/.test(s)) return true;
  if (!/[A-Za-zÀ-ú]{3,}/.test(s)) return true;
  // code-ish fragments from bad matches
  if (/[;={}()]/.test(s)) return true;
  if (/\b(return|const|export|import|useState|useRef|Promise|React)\b/.test(s)) return true;
  if (/^\s*[:?|]/.test(s) || /\)\s*:/.test(s)) return true;
  return false;
}

function looksLikeUiCopy(raw) {
  const s = raw.trim();
  if (isTechnicalLiteral(s)) return false;
  if (!/[A-Za-zÀ-ú]/.test(s)) return false;
  if (/\s/.test(s)) return true;
  if (/^[A-ZÁÉÍÓÚÃÕÇ][a-zà-ú]{2,}/.test(s) && s.length >= 4) return true;
  if (/[!?…]/.test(s)) return true;
  return false;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

function collectTsxFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '__tests__') continue;
      collectTsxFiles(p, out);
    } else if (FILE_RE.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Scan one source file for likely hardcoded UI copy.
 */
export function scanFileForHardcodedUi(filePath, source) {
  const findings = [];
  const cleaned = stripComments(source);
  // Remove t('…') / t("…", {…}) so their content is not re-flagged
  const withoutT = cleaned.replace(
    /\bt\(\s*(['"`])(?:\\.|(?!\1).)*\1(?:\s*,\s*\{[\s\S]*?\})?\s*\)/g,
    't(/*i18n*/)'
  );

  // JSX text after a real tag: <Tag ...>copy<  or </>copy<
  // Avoids `Foo<Bar>` TypeScript generics (no `/` or tag name after `<` with attrs).
  const jsxTextRe = /<\/?[A-Za-z][\w.-]*(?:\s[^>]*)?>\s*([^<>{]{3,200}?)\s*(?=<)/g;
  let m;
  while ((m = jsxTextRe.exec(withoutT))) {
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (!looksLikeUiCopy(text)) continue;
    findings.push({ file: filePath, line: lineOf(withoutT, m.index), text, kind: 'jsxText' });
  }

  const propRe =
    /\b(title|aria-label|placeholder|alt)\s*=\s*(['"`])([^'"`]{3,200})\2/g;
  while ((m = propRe.exec(withoutT))) {
    const text = m[3].trim();
    if (!looksLikeUiCopy(text)) continue;
    findings.push({ file: filePath, line: lineOf(withoutT, m.index), text, kind: 'prop' });
  }

  const alertRe = /\b(alert|confirm)\(\s*(['"`])([^'"`]{3,200})\2/g;
  while ((m = alertRe.exec(withoutT))) {
    const text = m[3].trim();
    if (!looksLikeUiCopy(text)) continue;
    findings.push({ file: filePath, line: lineOf(withoutT, m.index), text, kind: 'alertConfirm' });
  }

  return findings;
}

export function scanMigratedDirs(repoRoot) {
  const all = [];
  for (const relDir of I18N_MIGRATED_GLOBS) {
    const abs = join(repoRoot, relDir);
    for (const file of collectTsxFiles(abs)) {
      const src = readFileSync(file, 'utf8');
      const rel = relative(repoRoot, file).replace(/\\/g, '/');
      for (const f of scanFileForHardcodedUi(rel, src)) {
        all.push(f);
      }
    }
  }
  return all;
}

/** Strict gate for CI / vitest — only files listed in I18N_STRICT_FILES. */
export function scanStrictFiles(repoRoot) {
  const all = [];
  for (const rel of I18N_STRICT_FILES) {
    const abs = join(repoRoot, rel);
    let src;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    for (const f of scanFileForHardcodedUi(rel, src)) {
      all.push(f);
    }
  }
  return all;
}

export function formatFindings(findings) {
  if (!findings.length) return 'i18n hardcode scan: OK (0 findings)';
  return [
    `i18n hardcode scan: ${findings.length} finding(s)`,
    ...findings.map((f) => `${f.file}:${f.line}: [${f.kind}] ${JSON.stringify(f.text)}`)
  ].join('\n');
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('i18n-hardcode-scan.mjs') ||
    process.argv[1].includes('i18n-hardcode-scan'));

if (isMain) {
  const root = process.cwd();
  const mode = process.argv.includes('--all') ? 'all' : 'strict';
  const findings = mode === 'all' ? scanMigratedDirs(root) : scanStrictFiles(root);
  console.log(formatFindings(findings));
  if (findings.length) process.exitCode = 1;
}
