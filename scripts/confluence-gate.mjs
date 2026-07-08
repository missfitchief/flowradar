// FlowRadar — External Confluence final gate (Task F). Runnable scope/secret/
// GMGN/Dune scan over the confluence branch diff. Exit 0 = clean.
//   node scripts/confluence-gate.mjs
// Each check prints PASS/FAIL + evidence. Exit non-zero if ANY check fails.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const BASE = process.env.CONFLUENCE_BASE_REF || 'main';
const SELF = 'scripts/confluence-gate.mjs'; // self-reference guard: never scan this file's own content
function sh(cmd) {
  return execSync(cmd, { encoding: 'utf-8' });
}

let failed = false;
const changed = sh(`git diff --name-only ${BASE}...HEAD`)
  .split('\n')
  .map((f) => f.trim())
  .filter(Boolean)
  .filter((f) => f !== SELF);

// ---------------------------------------------------------------------------
// CHECK 1 — FORBIDDEN-FILE SCOPE CHECK
// Files the confluence track is FORBIDDEN to touch (design global rules 2-5,
// 8-12): FlowScore formula, wallet scoring, rules engine, candidate
// validation/promotion, scoring pass, signals ingestion, outbound Telegram,
// Dune paths, and any .env file.
// ---------------------------------------------------------------------------
const FORBIDDEN_PATHS = [
  /(^|\/)flowScore\.ts$/,
  /(^|\/)walletScore\.ts$/,
  /packages\/core\/src\/rules\//,
  /candidate/i,
  /(^|\/)scoring-pass\.ts$/,
  /(^|\/)packages\/db\/src\/signals\.ts$/,
  /packages\/providers\/src\/telegram\.ts$/,
  /dune/i,
  /(^|\/)\.env(\..*)?$/
];
const scopeViolations = changed.filter((f) => FORBIDDEN_PATHS.some((re) => re.test(f)));
if (scopeViolations.length) {
  failed = true;
  console.error('CHECK 1 [FORBIDDEN-FILE SCOPE]: FAIL — diff touches forbidden files:\n' + scopeViolations.join('\n'));
} else {
  console.log('CHECK 1 [FORBIDDEN-FILE SCOPE]: PASS — no FlowScore/wallet/rules/candidate/scoring-pass/signals/telegram/Dune/.env files changed');
}

// ---------------------------------------------------------------------------
// CHECK 2 — SECRET SCAN (production source only)
// Scope: only branch-changed files under packages/*/src/, apps/*/src/,
// apps/web/app/, apps/web/components/ that are PRODUCTION code — i.e.
// excluding any path containing "/test/" or ending in ".test.ts", and
// excluding this gate script itself.
//
// Test fixtures with fake secret-shaped values (e.g.
// packages/providers/test/confluenceSources.test.ts, which intentionally
// assigns fake values to process.env to assert they are NEVER leaked) are
// OUT OF SCOPE BY DESIGN — a test file is not production code, so it cannot
// trip this check no matter what literal it contains.
// ---------------------------------------------------------------------------
const PROD_SRC_DIR = /^(packages\/[^/]+\/src\/|apps\/[^/]+\/src\/|apps\/web\/app\/|apps\/web\/components\/)/;
const isTestPath = (f) => /\/test\//.test(f) || f.endsWith('.test.ts') || f.endsWith('.test.tsx');
const prodFiles = changed.filter((f) => PROD_SRC_DIR.test(f) && !isTestPath(f) && existsSync(f));

const secretPatterns = [/(api_key|secret|token|password|bearer)\s*[:=]\s*['"][A-Za-z0-9_\/+-]{16,}['"]/i];
const secretHits = [];
for (const f of prodFiles) {
  const lines = readFileSync(f, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    if (secretPatterns.some((re) => re.test(line))) {
      secretHits.push(`${f}:${i + 1}: ${line.trim()}`);
    }
  });
}
if (secretHits.length) {
  failed = true;
  console.error('CHECK 2 [SECRET SCAN — production source]: FAIL — secret-shaped literals found:\n' + secretHits.join('\n'));
} else {
  console.log('CHECK 2 [SECRET SCAN — production source]: PASS — no secret-shaped literals in changed production source files');
}

// ---------------------------------------------------------------------------
// CHECK 3 — GMGN QUERY-ONLY SCAN
// The GMGN adapter must remain a query-only stub: it must never reference
// trading/execution/wallet-key capability endpoints.
// ---------------------------------------------------------------------------
const GMGN_FILE = 'packages/providers/src/confluence/gmgn.ts';
// Word-boundaried on both sides so this matches real capability calls/identifiers
// (swapToken(, executeOrder, privateKey) but not substrings inside unrelated
// English words (e.g. "design", "signal", "assignment" must NOT match "sign").
const FORBIDDEN_GMGN_TERMS = /\b(swap\w*|order\w*|execute\w*|privateKey|transfer\w*|withdraw\w*|signTransaction\w*|approve\w*)\b/i;
if (existsSync(GMGN_FILE)) {
  const gmgnSrc = readFileSync(GMGN_FILE, 'utf-8');
  const gmgnHits = gmgnSrc
    .split('\n')
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => FORBIDDEN_GMGN_TERMS.test(line));
  if (gmgnHits.length) {
    failed = true;
    console.error(
      `CHECK 3 [GMGN QUERY-ONLY]: FAIL — forbidden capability terms in ${GMGN_FILE}:\n` +
        gmgnHits.map(({ line, i }) => `${GMGN_FILE}:${i + 1}: ${line.trim()}`).join('\n')
    );
  } else {
    console.log('CHECK 3 [GMGN QUERY-ONLY]: PASS — no forbidden capability terms in ' + GMGN_FILE);
  }
} else {
  failed = true;
  console.error(`CHECK 3 [GMGN QUERY-ONLY]: FAIL — expected file missing: ${GMGN_FILE}`);
}

// ---------------------------------------------------------------------------
// CHECK 4 — DUNE CHECK (precise, not prose grep)
// (a) fail if the branch diff touches any Dune source path.
// (b) fail if any PRODUCTION confluence source file references a Dune
//     client/execute call. This greps FILE CONTENTS on disk (not the diff,
//     not docs/tests/prose), so doc sentences like "DUNE_EXECUTE_FRESH=false
//     stays disabled" or test assertions that merely mention "execute" as a
//     regex-pattern string can never trip it.
// ---------------------------------------------------------------------------
const DUNE_PATH_RE = /dune/i;
const duneDiffHits = changed.filter((f) => DUNE_PATH_RE.test(f));
if (duneDiffHits.length) {
  failed = true;
  console.error('CHECK 4a [DUNE — diff path scan]: FAIL — diff touches Dune source path(s):\n' + duneDiffHits.join('\n'));
} else {
  console.log('CHECK 4a [DUNE — diff path scan]: PASS — no Dune source paths in diff');
}

const CONFLUENCE_PROD_FILES_TO_SCAN = [
  'packages/core/src/confluence/index.ts',
  'packages/core/src/confluence/liquidityRisk.ts',
  'packages/core/src/confluence/types.ts',
  'packages/db/src/confluence/ingest.ts',
  'packages/db/src/confluence/queries.ts',
  'packages/providers/src/confluence/agPaper.ts',
  'packages/providers/src/confluence/clobr.ts',
  'packages/providers/src/confluence/gmgn.ts',
  'packages/providers/src/confluence/holderscan.ts',
  'packages/providers/src/confluence/index.ts',
  'packages/providers/src/confluence/mockConfluence.ts',
  'packages/providers/src/confluence/sourceStatus.ts',
  'packages/providers/src/confluence/types.ts',
  'apps/worker/src/jobs/externalConfluence.ts',
  'apps/web/components/tokens/ConfluencePanel.tsx'
].filter((f) => existsSync(f));

const duneContentHits = [];
for (const f of CONFLUENCE_PROD_FILES_TO_SCAN) {
  const lines = readFileSync(f, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return; // pure comment lines excluded
    if (/dune/i.test(line)) duneContentHits.push(`${f}:${i + 1}: ${trimmed}`);
  });
}
if (duneContentHits.length) {
  failed = true;
  console.error('CHECK 4b [DUNE — production confluence file content scan]: FAIL — Dune reference found:\n' + duneContentHits.join('\n'));
} else {
  console.log('CHECK 4b [DUNE — production confluence file content scan]: PASS — zero Dune references in production confluence files');
}

process.exit(failed ? 1 : 0);
