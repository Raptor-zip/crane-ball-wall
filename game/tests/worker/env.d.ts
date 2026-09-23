// Test-only typing for the vitest "worker" project. Owner: O0.
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      /** Added by vitest.config.ts; applied in tests/worker/setup.ts. */
      TEST_MIGRATIONS: D1Migration[];
    }
    interface GlobalProps {
      /** Types `exports.default` of "cloudflare:workers". */
      mainModule: typeof import('../../worker/index');
    }
  }
}
