// ESLint flat config (GAME_DESIGN.md §4.3, §10.1). Owner: O0.
// Main job: the determinism ban for src/sim (display.ts exempt). tests/sim/ban.test.ts greps the same rules.
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/** Math members allowed in src/sim: the §4.3 functions and the exact constants. */
const ALLOWED_MATH = [
  'abs', 'min', 'max', 'floor', 'ceil', 'round', 'trunc', 'sign', 'imul',
  'PI', 'E', 'LN2', 'LN10', 'LOG2E', 'LOG10E', 'SQRT2', 'SQRT1_2',
];
/** Explicitly banned Math functions of §4.3 (log* = log, log10, log2, log1p). */
const BANNED_MATH = [
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh',
  'exp', 'expm1', 'log', 'log10', 'log2', 'log1p', 'pow', 'sqrt', 'cbrt', 'hypot', 'fround', 'random',
];
const SIM_MSG = 'Banned in src/sim (GAME_DESIGN.md §4.3): not bit-identical across engines.';

export default defineConfig(
  {
    ignores: [
      'node_modules/',
      'dist/',
      'dist-single/',
      'dist-test/',
      '.wrangler/',
      'test-results/',
      'playwright-report/',
      'tools/.cache/',
      'public/',
    ],
  },
  {
    files: ['**/*.ts', '**/*.mts'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    rules: {
      'no-debugger': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
    },
  },
  {
    // The deterministic simulation: pure float64 TS, no DOM, no three.
    files: ['src/sim/**/*.ts'],
    ignores: ['src/sim/display.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        ...BANNED_MATH.map((property) => ({ object: 'Math', property, message: SIM_MSG })),
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "BinaryExpression[operator='**']", message: `'**' ${SIM_MSG}` },
        { selector: "AssignmentExpression[operator='**=']", message: `'**=' ${SIM_MSG}` },
        { selector: "Identifier[name='Float32Array']", message: `Float32Array: ${SIM_MSG}` },
        { selector: "Identifier[name='Date']", message: `Date: ${SIM_MSG}` },
        { selector: "Identifier[name='performance']", message: `performance: ${SIM_MSG}` },
        {
          selector: `MemberExpression[object.name='Math'][computed=false][property.name!=/^(${ALLOWED_MATH.join('|')})$/]`,
          message: `Only Math.${ALLOWED_MATH.slice(0, 9).join('/')} (and constants) are allowed in src/sim (§4.3).`,
        },
        { selector: "MemberExpression[object.name='Math'][computed=true]", message: `Computed Math[...] access: ${SIM_MSG}` },
        { selector: ":not(MemberExpression) > Identifier[name='Math']", message: `Aliasing Math: ${SIM_MSG}` },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['three', 'three/*'], message: 'src/sim must not depend on three (§10.2).' },
            { group: ['../*'], message: 'src/sim depends on nothing outside src/sim (§10.2).' },
            { group: ['./display', './display.ts'], message: 'display.ts is display-only; the simulation must not import it.' },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'No DOM in src/sim (§4).' },
        { name: 'document', message: 'No DOM in src/sim (§4).' },
        { name: 'navigator', message: 'No DOM in src/sim (§4).' },
        // The global object is the back door to everything above (globalThis.Math.sin, globalThis.performance,
        // globalThis.crypto ...): the simulation reads nothing global beyond the allowed Math members.
        { name: 'globalThis', message: 'No global object in src/sim (§4.3): globalThis.* bypasses the determinism ban.' },
        { name: 'self', message: 'No global object in src/sim (§4.3).' },
        { name: 'global', message: 'No global object in src/sim (§4.3).' },
      ],
      // the other way to reach the global object (Function('return this')()) and any string-built code
      'no-eval': 'error',
      'no-new-func': 'error',
    },
  },
);
