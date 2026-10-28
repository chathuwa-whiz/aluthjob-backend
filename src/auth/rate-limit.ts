import { TooManyRequestsError } from "../errors.js";

interface Window {
    count: number;
    pending: number;
    resetAt: number;
}

/** Process-local fixed windows. Reserve before awaiting work so concurrent attempts count too. */
export class RateLimiter {
    private readonly windows = new Map<string, Window>();

    constructor(
        private readonly max: number,
        private readonly windowMs: number,
        private readonly label = "attempts",
        private readonly clock: () => number = Date.now,
        private readonly maxKeys = 20_000,
    ) {}

    private active(key: string): Window | undefined {
        const window = this.windows.get(key);
        if (window && window.resetAt <= this.clock() && window.pending === 0) {
            this.windows.delete(key);
            return undefined;
        }
        return window;
    }

    private window(key: string): Window {
        const existing = this.active(key);
        if (existing) return existing;
        if (this.windows.size >= this.maxKeys) {
            for (const [name, entry] of this.windows) {
                if (entry.resetAt <= this.clock() && entry.pending === 0) this.windows.delete(name);
            }
            // Fail closed rather than evicting active counters, which would reset attackers' allowances.
            if (this.windows.size >= this.maxKeys) throw new TooManyRequestsError("Too many requests. Try again later", 60);
        }
        const window = { count: 0, pending: 0, resetAt: this.clock() + this.windowMs };
        this.windows.set(key, window);
        return window;
    }

    assertAllowed(key: string): void {
        const window = this.active(key);
        if (window && window.count + window.pending >= this.max) {
            const seconds = Math.max(1, Math.ceil((window.resetAt - this.clock()) / 1000));
            throw new TooManyRequestsError(`Too many ${this.label}. Try again in ${Math.ceil(seconds / 60)} minute(s)`, seconds);
        }
        if (!window) this.window(key);
    }

    record(key: string): void {
        this.window(key).count++;
    }

    /** Settle once after work: failures keep the attempt, successes release it, optionally clearing failures. */
    reserve(key: string): (success?: boolean, clearFailures?: boolean) => void {
        this.assertAllowed(key);
        const window = this.window(key);
        window.pending++;
        let settled = false;
        return (success = false, clearFailures = false) => {
            if (settled) return;
            settled = true;
            window.pending--;
            if (!success) window.count++;
            else if (clearFailures) window.count = 0;
        };
    }

    clear(key: string): void {
        const window = this.active(key);
        if (window?.pending) window.count = 0;
        else this.windows.delete(key);
    }

    reset(): void {
        this.windows.clear();
    }
}
