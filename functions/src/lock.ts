/**
 * Async mutex / write lock for serializing state mutations.
 *
 * Ensures only one operation at a time can read-modify-write the agent state.
 * Uses a simple promise chain pattern -- no external deps.
 */

export class AsyncLock {
  private chain: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Chain onto the previous operation
    const result = this.chain.then(fn);

    // Update chain to catch errors so one failure doesn't block all future ops
    this.chain = result.then(
      () => undefined,
      () => undefined
    );

    return result;
  }
}