/**
 * Raised when a run has spent every request it was allowed.
 *
 * This is a normal outcome rather than a fault: the run stops, leaves its
 * cursors where they are, and the next one resumes from there. Callers are
 * expected to catch it and finish cleanly.
 */
export class BudgetExhaustedError extends Error {
  constructor(readonly spent: number) {
    super(`request budget exhausted after ${spent} requests`);
    this.name = "BudgetExhaustedError";
  }
}

/**
 * A run's allowance of provider requests.
 *
 * Capping the work per run — rather than per repository, or not at all — is
 * what bounds the load the plugin puts on a provider no matter how many
 * repositories the catalog holds. Retries draw from the same allowance, because
 * a retry is a real request and a host that is failing should not be granted
 * more traffic than one that is healthy.
 *
 * It counts what it turned away as well as what it let through. Spending the
 * last request is not the same as wanting one more: a pass that used its
 * allowance to the unit finished, and one that was refused did not, and only
 * the refusals tell an operator which of the two they are looking at.
 */
export class RequestBudget {
  private consumed = 0;
  private refusals = 0;

  constructor(readonly limit: number) {}

  /** Reserves one request, or returns false when the allowance is gone. */
  tryConsume(): boolean {
    if (this.consumed >= this.limit) {
      this.refusals += 1;
      return false;
    }
    this.consumed += 1;
    return true;
  }

  /** Reserves one request, throwing rather than returning false. */
  consume(): void {
    if (!this.tryConsume()) throw new BudgetExhaustedError(this.consumed);
  }

  get spent(): number {
    return this.consumed;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.consumed);
  }

  get isExhausted(): boolean {
    return this.consumed >= this.limit;
  }

  /** Requests turned away because the allowance was already gone. */
  get refused(): number {
    return this.refusals;
  }
}
