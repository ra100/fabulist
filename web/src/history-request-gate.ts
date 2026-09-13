/**
 * Lets a mutation invalidate every older asynchronous history read. A request
 * started after that mutation receives a newer revision and is authoritative.
 */
export class HistoryRequestGate {
  private revision = 0;

  beginRequest(): number {
    this.revision += 1;
    return this.revision;
  }

  invalidate(): number {
    this.revision += 1;
    return this.revision;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}
