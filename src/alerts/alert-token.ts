import { createHmac, timingSafeEqual } from "node:crypto";
import { ConfigError } from "../errors.js";

// The buttons in a job-alert email. Each link carries a signed, self-describing token instead of a row in
// the database: nothing to store or clean up, and an old email keeps working until the token expires.
//
// A token is not a login. It can only do the one small thing it names for the one account it names, and
// every one of those things is harmless to repeat (hide a job, change the email frequency, switch alerts off).

export type AlertAction = "hide" | "off" | "pause" | "daily" | "weekly";

export interface AlertTokenPayload {
    userId: number;
    action: AlertAction;
    /** The match to hide; only for "hide". */
    matchId?: number;
}

const DAY = 86_400_000;
// Unsubscribe must keep working from an old email, so every token but "hide" lasts a year
const LIFETIME_DAYS: Record<AlertAction, number> = { hide: 45, off: 365, pause: 365, daily: 365, weekly: 365 };
const ACTIONS = new Set<string>(Object.keys(LIFETIME_DAYS));

/** ALERT_SECRET, or a key derived from MAIL_SECRET so a server that already sends applications needs no new setting. */
function key(): Buffer {
    const own = process.env.ALERT_SECRET;
    if (own && own.length >= 32) return Buffer.from(own);

    const mail = process.env.MAIL_SECRET;
    if (mail && mail.length >= 32) return createHmac("sha256", mail).update("aluthjob:alert-links").digest();

    throw new ConfigError("Set ALERT_SECRET (32+ characters) to send job-alert emails");
}

const sign = (body: string) => createHmac("sha256", key()).update(body).digest("base64url");

export function signAlertToken(payload: AlertTokenPayload, now = Date.now()): string {
    const body = Buffer.from(
        JSON.stringify({ u: payload.userId, a: payload.action, ...(payload.matchId !== undefined && { m: payload.matchId }), e: Math.floor((now + LIFETIME_DAYS[payload.action] * DAY) / 1000) }),
    ).toString("base64url");

    return `${body}.${sign(body)}`;
}

/** The payload of a genuine, unexpired token; undefined for anything else (never throws on bad input). */
export function verifyAlertToken(token: string, now = Date.now()): AlertTokenPayload | undefined {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra !== undefined) return undefined;

    const expected = Buffer.from(sign(body));
    const given = Buffer.from(signature);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;

    try {
        const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { u?: unknown; a?: unknown; m?: unknown; e?: unknown };

        if (!Number.isInteger(data.u) || typeof data.a !== "string" || !ACTIONS.has(data.a)) return undefined;
        if (typeof data.e !== "number" || data.e * 1000 < now) return undefined;
        if (data.a === "hide" && !Number.isInteger(data.m)) return undefined;

        return { userId: data.u as number, action: data.a as AlertAction, ...(data.a === "hide" && { matchId: data.m as number }) };
    } catch {
        return undefined;
    }
}
