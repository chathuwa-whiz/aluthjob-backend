import { createHash, randomBytes } from "node:crypto";
import { getDatabase, type Db } from "../db/database.js";

export type TokenPurpose = "verify" | "reset";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Creates a one-time token for a user and returns the raw value, which goes into the emailed link and is
 * stored nowhere. Any earlier unused token of the same kind is withdrawn first, so only the newest link works.
 */
export async function issueEmailToken(userId: number, purpose: TokenPurpose, email: string, ttlMs: number): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const now = new Date();

    await getDatabase().transaction(async (tx) => {
        // Concurrent resend/reset requests must not both leave a usable token behind.
        await tx.get("SELECT id FROM users WHERE id = ? FOR UPDATE", [userId]);
        await tx.run("DELETE FROM email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL", [userId, purpose]);
        await tx.run(
            "INSERT INTO email_tokens (user_id, purpose, token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
            [userId, purpose, hash(token), email, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString()],
        );
    });

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
export async function consumeEmailToken(purpose: TokenPurpose, token: string, tx: Db = getDatabase()): Promise<ConsumedToken | undefined> {
    const now = new Date().toISOString();

    const row = await tx.update<{ user_id: number; email: string }>(
        "UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?",
        [now, hash(token), purpose, now],
        { user_id: "number", email: "string" },
    );

    return row && { userId: row.user_id, email: row.email };
}

/** Withdraws every unused token of this kind (e.g. all reset links once the password has been changed). */
export async function revokeEmailTokens(userId: number, purpose: TokenPurpose, tx: Db = getDatabase()): Promise<void> {
    await tx.run("DELETE FROM email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL", [userId, purpose]);
}

export async function purgeExpiredEmailTokens(): Promise<number> {
    return (await getDatabase().run("DELETE FROM email_tokens WHERE expires_at <= ? OR used_at IS NOT NULL", [new Date().toISOString()])).changes;
}

/** Checks a token without using it up (so a rejected new password does not cost the user their one link). */
export async function peekEmailToken(purpose: TokenPurpose, token: string): Promise<ConsumedToken | undefined> {
    const row = await getDatabase().get<{ user_id: number; email: string }>(
        `SELECT user_id, email FROM email_tokens
         WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?`,
        [hash(token), purpose, new Date().toISOString()],
    );

    return row && { userId: row.user_id, email: row.email };
}
