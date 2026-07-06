// FlowRadar — Wave 4.6 grep-style trust-boundary regression (Task 37). The
// signal engine (packages/core/src/window/aggregate.ts's aggregateWindow, and
// every rule/scoring module it feeds) must have ZERO code-level dependency on
// the Prisma CandidateWallet model or CandidateWallet-shaped data — the ONLY
// candidate-adjacent code @flowradar/core is allowed to own is
// candidates/validate.ts's evaluateCandidate (which operates on a plain
// CandidateEvidence input, never a Prisma row), the ONE place a candidate's
// fate is decided (Task 35's own contract, restated here for the Wave 4.6
// Dune feeder specifically since it feeds the exact same CandidateWallet
// table via a different upstream source).
//
// This mirrors candidateValidation.test.ts's runtime trust-boundary proof
// (a pending candidate contributes 0 to smartWalletCount/uniqueEntityCount)
// from the OTHER direction: a static check that the signal-path SOURCE CODE
// itself never imports/references the CandidateWallet type at all, so the
// runtime guarantee can never regress via a future refactor that starts
// reading CandidateWallet rows directly from a rule/scoring module.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE_SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

// The one file allowed to mention "CandidateWallet" at all — in a comment
// only, documenting evaluateCandidate's role, never as an import/type usage.
const ALLOWED_COMMENT_ONLY_FILE = path.join('candidates', 'validate.ts');

function listTsFiles(dir: string): string[] {
  return globSync('**/*.ts', { cwd: dir }).map((f) => path.join(dir, f));
}

describe('signal engine has zero code-level CandidateWallet dependency (Wave 4.6 static trust-boundary check)', () => {
  it('no @flowradar/core source file imports or type-references the Prisma CandidateWallet model', () => {
    const files = listTsFiles(CORE_SRC_DIR);
    expect(files.length).toBeGreaterThan(0);

    const offendingFiles: { file: string; line: string }[] = [];

    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      const relative = path.relative(CORE_SRC_DIR, file);
      const lines = content.split('\n');

      for (const line of lines) {
        if (!line.includes('CandidateWallet')) continue;

        const isCommentLine = /^\s*(\/\/|\*|\/\*)/.test(line);
        if (relative === ALLOWED_COMMENT_ONLY_FILE && isCommentLine) continue; // documented, allowed exception

        offendingFiles.push({ file: relative, line: line.trim() });
      }
    }

    expect(offendingFiles).toEqual([]);
  });

  it('window/aggregate.ts (the signal aggregation entry point) never mentions CandidateWallet at all', () => {
    const aggregatePath = path.join(CORE_SRC_DIR, 'window', 'aggregate.ts');
    const content = readFileSync(aggregatePath, 'utf-8');
    expect(content).not.toContain('CandidateWallet');
  });

  it('candidates/validate.ts operates on a plain CandidateEvidence shape, not a Prisma CandidateWallet row', () => {
    const validatePath = path.join(CORE_SRC_DIR, 'candidates', 'validate.ts');
    const content = readFileSync(validatePath, 'utf-8');
    // It's fine (and expected) to talk ABOUT CandidateWallet in a comment;
    // it must never import the Prisma type or accept one as a parameter type.
    expect(content).not.toMatch(/import[^;]*CandidateWallet/);
    expect(content).not.toMatch(/:\s*CandidateWallet\b/);
  });
});
