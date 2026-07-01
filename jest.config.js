'use strict';

/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  // src/hooks/runner.js is the dependency-free standalone hook runtime. Its pure
  // logic (config decrypt, state/marker parsing, IP cache) is unit-tested in
  // tests/runner.test.js; its https/Telegram network paths are exercised by
  // integration/e2e rather than unit mocks, so it is excluded from the global
  // line-coverage gate to keep that gate meaningful for the rest of src/.
  collectCoverageFrom: ['src/**/*.js', '!src/hooks/runner.js'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      branches: 60,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  clearMocks: true,
};
