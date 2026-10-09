/**
 * Names the per-run directory scripts/test.ts hands every shard. Suites put their
 * private tmux sockets in it (`usePrivateTmux`, daemon/test/fixtures.ts), and the
 * runner sweeps it when the run ends. Its own module so the runner needn't import
 * a daemon fixture, and the fixture needn't import the runner.
 */
export const TEST_RUN_DIR_ENV = "SEANCE_TEST_RUN_DIR";
