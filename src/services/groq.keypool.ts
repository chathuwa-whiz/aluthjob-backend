/**
 * Rotates over several API keys (one per free Groq account). A key that hits its rate limit is
 * benched until the time Groq reports, and requests go to the next key straight away.
 */
export class KeyPool {
    private readonly benchedUntil = new Map<string, number>();
    private start = 0;

    constructor(
        readonly keys: readonly string[],
        private readonly now: () => number = Date.now,
    ) {}

    /** Keys that may be tried now. The first one rotates, so load spreads over all accounts before any limit is hit. */
    available(): string[] {
        const ready = this.keys.filter((key) => (this.benchedUntil.get(key) ?? 0) <= this.now());
        if (ready.length === 0) return [];

        const offset = this.start++ % ready.length;
        return [...ready.slice(offset), ...ready.slice(0, offset)];
    }

    bench(key: string, milliseconds: number): void {
        this.benchedUntil.set(key, this.now() + milliseconds);
    }

    /** Milliseconds until some key is usable again; 0 when one already is. */
    waitForNext(): number {
        const times = this.keys.map((key) => Math.max(0, (this.benchedUntil.get(key) ?? 0) - this.now()));
        return times.length ? Math.min(...times) : Infinity;
    }

    /** 1-based position of the key, for logs that must never show the key itself. */
    label(key: string): string {
        return `key ${this.keys.indexOf(key) + 1}/${this.keys.length}`;
    }
}

/** Accepts commas, spaces or new lines between keys and ignores duplicates. */
export function parseKeys(raw: string | undefined): string[] {
    return [...new Set((raw ?? "").split(/[\s,;]+/).filter(Boolean))];
}
