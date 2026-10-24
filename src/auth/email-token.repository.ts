import { createHash, randomBytes } from "node:crypto";
import { getDatabase } from "../db/database.js";

export type TokenPurpose = "verify" | "reset";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Creates a one-time token for a user and returns the raw value, which goes into the emailed link and is
 * stored nowhere. Any earlier unused token of the same kind is withdrawn first, so only the newest link works.
 */
export function issueEmailToken(userId: number, purpose: TokenPurpose, email: string, ttlMs: number): string {
    const db = getDatabase();
    const token = randomBytes(32).toString("base64url");
    const now = new Date();

    db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL").run(userId, purpose);
    db.prepare(`
        INSERT INTO email_tokens (user_id, purpose, token_hash, email, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, purpose, hash(token), email, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());

    return token;
}

export interface ConsumedToken {
    userId: number;
    /** The address the link was sent to. */
    email: string;
}

/**
 * Uses a token up. A single UPDATE both checks and spends it, so two requests racing with the same link
 * cannot both succeed; an unknown, expired, already used or wrong-purpose token returns undefined.
 */
export function consumeEmailToken(purpose: TokenPurpose, token: string): ConsumedToken | undefined {
    const now = new Date().toISOString();

    const row = getDatabase()
        .prepare(`
            UPDATE email_tokens SET used_at = ?
            WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
            RETURNING user_id, email
        `)
        .get(now, hash(token), purpose, now) as unknown as { user_id: number; email: string } | undefined;

    return row && { userId: row.user_id, email: row.email };
}

/** Withdraws every unused token of this kind (e.g. all reset links once the password has been changed). */
export function revokeEmailTokens(userId: number, purpose: TokenPurpose): void {
    getDatabase().prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL").run(userId, purpose);
}

export function purgeExpiredEmailTokens(): number {
    return getDatabase().prepare("DELETE FROM email_tokens WHERE expires_at <= ? OR used_at IS NOT NULL").run(new Date().toISOString()).changes as number;
}

/** Checks a token without using it up (so a rejected new password does not cost the user their one link). */
export function peekEmailToken(purpose: TokenPurpose, token: string): ConsumedToken | undefined {
    const row = getDatabase()
        .prepare(`
            SELECT user_id, email FROM email_tokens
            WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
        `)
        .get(hash(token), purpose, new Date().toISOString()) as unknown as { user_id: number; email: string } | undefined;

    return row && { userId: row.user_id, email: row.email };
}
