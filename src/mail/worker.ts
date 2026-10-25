import { failInterrupted } from "./application.repository.js";
import { processNext } from "./application.service.js";

const IDLE_POLL_MS = 15_000;
const BUSY_POLL_MS = 2_000;

let timer: NodeJS.Timeout | undefined;
let running = false;
let lastTick: { at: string; result: string } | undefined;
let lastError: { at: string; message: string } | undefined;

/** For the administrators' system screen. */
export const mailWorkerStatus = () => ({ running, lastTick: lastTick ?? null, lastError: lastError ?? null });

/**
 * Drains the application queue in the background. Only one message is handled per tick, and the
 * pacing rules (daily limit, pause between messages) live in processNext, so this loop can stay simple.
 */
export function startMailWorker(): void {
    if (running) return;
    running = true;

    const tick = async () => {
        let next = IDLE_POLL_MS;

        try {
            const result = await processNext();
            lastTick = { at: new Date().toISOString(), result };
            if (result === "sent" || result === "failed" || result === "cancelled") next = BUSY_POLL_MS;
            if (result === "sent") console.log("Application sent");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            lastError = { at: new Date().toISOString(), message };
            console.error("Mail worker error:", message);
        }

        if (running) timer = setTimeout(tick, next).unref();
    };

    // Before the first tick, so an application left in 'sending' by a crash is never picked up again
    failInterrupted().then(
        (interrupted) => {
            if (interrupted > 0) console.warn(`${interrupted} application(s) were interrupted mid-send; marked failed for you to check`);
        },
        (error: unknown) => console.error("Could not check for interrupted applications:", error instanceof Error ? error.message : error),
    ).finally(() => {
        if (running) timer = setTimeout(tick, BUSY_POLL_MS).unref();
    });
}

export function stopMailWorker(): void {
    running = false;
    if (timer) clearTimeout(timer);
}
