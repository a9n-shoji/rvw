export function installFixtureLifecycle({ cleanup, close = (done) => done() }) {
  let cleaned = false;
  let shuttingDown = false;
  const cleanupOnce = () => {
    if (cleaned) return;
    cleaned = true;
    cleanup();
  };
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    close(() => {
      cleanupOnce();
      process.exit(0);
    });
  };
  process.once("exit", cleanupOnce);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGHUP", shutdown);
  return cleanupOnce;
}
