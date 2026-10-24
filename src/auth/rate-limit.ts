import { TooManyRequestsError } from "../errors.js";

interface Window {
    count: number;
    resetAt: number;
}

/**
 * Fixed-window counter kept in memory: enough for one API process, and it resets on restart. Callers
 * check before doing the work (`assertAllowed`) and count only what should count (`record`), so a
 * successful login does not use up the allowance of a user who simply mistyped a few times earlier.
 */
export class RateLimiter {
    private readonly windows = new Map<string, Window>();

    constructor(
        private readonly max: number,
        private readonly windowMs: number,
        private readonly label = "attempts",
        private readonly clock: () => number = Date.now,
    ) {}

    private active(key: string): Window | undefined {
        const window = this.windows.get(key);
        if (window && window.resetAt <= this.clock()) {
            this.windows.delete(key);
            return undefined;
        }
        return window;
    }

    /** Throws TooManyRequestsError (HTTP 429) when the key has used up its allowance. */
    assertAllowed(key: string): void {
        const window = this.active(key);
        if (window && window.count >= this.max) {
            const seconds = Math.max(1, Math.ceil((window.resetAt - this.clock()) / 1000));
            throw new TooManyRequestsError(`Too many ${this.label}. Try again in ${Math.ceil(seconds / 60)} minute(s)`, seconds);
        }
    }

    record(key: string): void {
        const window = this.active(key);

        if (window) window.count++;
        else this.windows.set(key, { count: 1, resetAt: this.clock() + this.windowMs });

        // keep memory bounded when many different addresses probe the API
        if (this.windows.size > 20_000) {
            for (const [name, entry] of this.windows) if (entry.resetAt <= this.clock()) this.windows.delete(name);
        }
    }

    clear(key: string): void {
        this.windows.delete(key);
    }

    /** Test helper */
    reset(): void {
        this.windows.clear();
    }
}
