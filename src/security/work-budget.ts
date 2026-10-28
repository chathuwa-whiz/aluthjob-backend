import { TooManyRequestsError } from "../errors.js";

/** Reject excess work rather than retaining an unbounded queue of requests. */
export class WorkBudget {
    private active = 0;
    constructor(private readonly capacity: number, private readonly label: string) {}
    acquire(): () => void {
        if (this.active >= this.capacity) throw new TooManyRequestsError(`${this.label} is busy. Try again shortly`, 10);
        this.active++;
        let released = false;
        return () => { if (!released) { released = true; this.active--; } };
    }
    async run<T>(work: () => Promise<T>): Promise<T> {
        const release = this.acquire();
        try { return await work(); } finally { release(); }
    }
}

/** Share ongoing work; completed results and failures are never retained. */
export class SingleFlight<T> {
    private readonly running = new Map<number, Promise<T>>();
    run(id: number, work: () => Promise<T>): Promise<T> {
        const existing = this.running.get(id);
        if (existing) return existing;
        const result = Promise.resolve().then(work).finally(() => this.running.delete(id));
        this.running.set(id, result);
        return result;
    }
}
