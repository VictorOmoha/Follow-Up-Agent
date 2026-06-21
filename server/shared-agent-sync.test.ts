import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * Drift guard.
 *
 * The domain logic in `agent.ts` must exist in two physical locations:
 *   - src/lib/agent.ts          → bundled into the frontend (Vite)
 *   - functions/src/shared/agent.ts → shipped inside the Cloud Function
 *     (Firebase only uploads the functions/ directory at deploy time)
 *
 * They cannot be a single file without coupling the frontend build to the
 * functions/ tree, so we keep two copies and fail the build if they diverge.
 * All other backend modules are de-duplicated via re-export shims in server/*.ts
 * pointing at functions/src/* — see docs/persistence-refactor.md (Phase 1).
 */
describe('shared agent.ts copies stay in sync', () => {
  it('src/lib/agent.ts is byte-identical to functions/src/shared/agent.ts', () => {
    const root = resolve(__dirname, '..');
    const frontend = readFileSync(resolve(root, 'src/lib/agent.ts'), 'utf8');
    const functions = readFileSync(resolve(root, 'functions/src/shared/agent.ts'), 'utf8');
    expect(functions).toBe(frontend);
  });
});
