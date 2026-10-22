/** A short, non-revivable recording lease. All failures deny recording. */
export class RecordingAuthority {
  private generation = 0;
  private deadline = 0;
  private grant: string | null = null;
  constructor(
    private readonly verify: () => Promise<string | null>,
    private readonly now: () => number = () => performance.now(),
    private readonly duration = 5000,
  ) {}
  valid() { return this.grant !== null && this.now() < this.deadline; }
  invalidate() { this.generation++; this.deadline = 0; this.grant = null; }
  async authorize(renew = false): Promise<boolean> {
    if (renew && !this.valid()) { this.invalidate(); return false; }
    const generation = this.generation;
    const started = this.now();
    const previous = this.grant;
    let id: string | null = null;
    try { id = await this.verify(); } catch { /* denied */ }
    if (generation !== this.generation) return false;
    if (!id || this.now() >= started + this.duration
      || (renew && (!this.valid() || previous !== id))) {
      this.invalidate(); return false;
    }
    this.grant = id;
    this.deadline = started + this.duration;
    return true;
  }
}
