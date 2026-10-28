import { getDatabase, isUniqueViolation, type Db } from "../db/database.js";

export type Role = "user" | "admin";

export interface User {
    id: number;
    email: string;
    role: Role;
    createdAt: string;
    lastLoginAt: string | null;
    /** True once the owner proved control of the address. Unverified accounts can sign in but do almost nothing. */
    emailVerified: boolean;
}

interface UserRow {
    id: number;
    email: string;
    password_hash: string;
    role: Role;
    created_at: string;
    last_login_at: string | null;
    email_verified_at: string | null;
}

const toUser = (row: UserRow): User => ({
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    emailVerified: row.email_verified_at !== null,
});

const db = () => getDatabase();
const now = () => new Date().toISOString();

/** Returns undefined when the address is already registered. */
export async function createUser(email: string, passwordHash: string): Promise<User | undefined> {
    try {
        const createdAt = now();
        const id = await db().insert("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)", [email, passwordHash, createdAt]);
        // built here, not read back: a sign-up for a taken address (one failed insert) must cost the same as a new one
        return { id, email, role: "user", createdAt, lastLoginAt: null, emailVerified: false };
    } catch (error) {
        if (isUniqueViolation(error)) return undefined;
        throw error;
    }
}

export async function getUser(id: number): Promise<User | undefined> {
    const row = await db().get<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
    return row && toUser(row);
}

export async function findUserWithHash(email: string): Promise<(User & { passwordHash: string }) | undefined> {
    const row = await db().get<UserRow>("SELECT * FROM users WHERE email = ?", [email]);
    return row && { ...toUser(row), passwordHash: row.password_hash };
}

export async function getPasswordHash(id: number, tx: Db = db()): Promise<string | undefined> {
    const row = await tx.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ?", [id]);
    return row?.password_hash;
}

export async function setPasswordHash(id: number, passwordHash: string, tx: Db = db()): Promise<void> {
    await tx.run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, id]);
}

/** Idempotent: the first verification time is kept. */
export async function markEmailVerified(id: number, tx: Db = db()): Promise<void> {
    await tx.run("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?", [now(), id]);
}

export async function setRole(id: number, role: Role): Promise<void> {
    await db().run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
}

export async function touchLogin(id: number): Promise<void> {
    await db().run("UPDATE users SET last_login_at = ? WHERE id = ?", [now(), id]);
}

/** Deletes the user; their sessions, resumes, matches, mailbox and applications go with them (ON DELETE CASCADE). */
export async function deleteUser(id: number, tx: Db = db()): Promise<boolean> {
    return (await tx.run("DELETE FROM users WHERE id = ?", [id])).changes > 0;
}

/** Serializes credential changes, session creation and token issuance across API processes. */
export async function withUserLock<T>(userId: number, work: (tx: Db) => Promise<T>): Promise<T> {
    return db().transaction(async (tx) => {
        await tx.get("SELECT id FROM users WHERE id = ? FOR UPDATE", [userId]);
        return work(tx);
    });
}

// ---- sessions --------------------------------------------------------------------------

export async function createSession(userId: number, tokenHash: string, expiresAt: Date, userAgent: string | null, expectedPasswordHash?: string): Promise<boolean> {
    return db().transaction(async (tx) => {
        // Serialize concurrent sign-ins across processes; retain the newest twenty devices.
        const user = await tx.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ? FOR UPDATE", [userId]);
        // A password reset/change may have completed while the expensive comparison was running.
        if (!user || (expectedPasswordHash !== undefined && user.password_hash !== expectedPasswordHash)) return false;
        await tx.run("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?", [userId, now()]);
        await tx.run(
            "INSERT INTO sessions (user_id, token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)",
            [userId, tokenHash, now(), expiresAt.toISOString(), userAgent?.slice(0, 200) ?? null],
        );
        await tx.run(
            `DELETE FROM sessions WHERE id IN (
                SELECT id FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id DESC) AS position FROM sessions WHERE user_id = ?)
                WHERE position > 20
            )`,
            [userId],
        );
        return true;
    });
}

/** The user behind a live (not expired) session. */
export async function findSessionUser(tokenHash: string): Promise<User | undefined> {
    const row = await db().get<UserRow>(
        `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
        [tokenHash, now()],
    );

    return row && toUser(row);
}

export async function deleteSession(tokenHash: string): Promise<void> {
    await db().run("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
}

/** Signs a user out everywhere, optionally keeping the session they are using right now. */
export async function deleteSessionsOf(userId: number, exceptTokenHash?: string, tx: Db = db()): Promise<number> {
    const result = exceptTokenHash
        ? await tx.run("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?", [userId, exceptTokenHash])
        : await tx.run("DELETE FROM sessions WHERE user_id = ?", [userId]);

    return result.changes;
}

export async function purgeExpiredSessions(): Promise<number> {
    return (await db().run("DELETE FROM sessions WHERE expires_at <= ?", [now()])).changes;
}
