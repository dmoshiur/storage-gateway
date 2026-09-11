/**
 * Test-only stub for the `server-only` marker package.
 *
 * `server-only` throws outside of a React Server Component graph, which makes
 * server modules (the Blob adapter, the environment resolver) impossible to
 * unit-test. Vitest aliases the package to this empty module.
 */
export {};
