// Classifies and reduces one run. Shared by the pipeline and the fixture
// tests, so both always apply exactly the same rules in the same order.

import { reduceRun } from './reduce.mjs';
import { serverStatusProblem, validateHarness, validateStructure } from './validate.mjs';

export function evaluateRun(loaded, ctx) {
  const serverProblem = serverStatusProblem(loaded.run);
  if (serverProblem) return { status: 'harness_invalid', errors: [serverProblem], warnings: [], reduced: null };
  const structural = validateStructure(loaded, ctx);
  if (structural.length) return { status: 'rejected', errors: structural, warnings: [], reduced: null };
  const reduced = reduceRun(loaded, ctx);
  const harness = validateHarness(loaded, reduced);
  return {
    status: harness.problems.length ? 'harness_invalid' : 'valid',
    errors: harness.problems,
    warnings: harness.warnings,
    reduced,
  };
}
