// vitest "worker" project setup (runs inside workerd before each test file). Owner: O0 (infra; O9 may extend).
// Applies migrations/*.sql to the local D1 binding. applyD1Migrations is idempotent.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
