export function createSingleFlightController() {
  let running = false;

  return {
    isRunning() {
      return running;
    },
    async start(action: () => Promise<void>): Promise<void> {
      if (running) return;
      running = true;
      try {
        await action();
      } finally {
        running = false;
      }
    },
  };
}
