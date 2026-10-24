import { getDatabase } from "../db/database.js";

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
export function createUser(email: string, passwordHash: string): User | undefined {
    try {
        const result = db()
            .prepare("INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)")
            .run(email, passwordHash, now());

        return getUser(Number(result.lastInsertRowid));
    } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed: users\.email/.test(error.message)) return undefined;
        throw error;
    }
}

export function getUser(id: number): User | undefined {
    const row = db().prepare("SELECT * FROM users WHERE id = ?").get(id) as unknown as UserRow | undefined;
    return row && toUser(row);
}

export function findUserWithHash(email: string): (User & { passwordHash: string }) | undefined {
    const row = db().prepare("SELECT * FROM users WHERE email = ?").get(email) as unknown as UserRow | undefined;
    return row && { ...toUser(row), passwordHash: row.password_hash };
}

export function getPasswordHash(id: number): string | undefined {
    const row = db().prepare("SELECT password_hash FROM users WHERE id = ?").get(id) as unknown as { password_hash: string } | undefined;
    return row?.password_hash;
}

export function setPasswordHash(id: number, passwordHash: string): void {
    db().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
}

/** Idempotent: the first verification time is kept. */
export function markEmailVerified(id: number): void {
    db().prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").run(now(), id);
}

export function setRole(id: number, role: Role): void {
    db().prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
}

export function touchLogin(id: number): void {
    db().prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(now(), id);
}

/** Deletes the user; their sessions, resumes, matches, mailbox and applications go with them (ON DELETE CASCADE). */
export function deleteUser(id: number): boolean {
    return db().prepare("DELETE FROM users WHERE id = ?").run(id).changes > 0;
}

// ---- sessions --------------------------------------------------------------------------

export function createSession(userId: number, tokenHash: string, expiresAt: Date, userAgent: string | null): void {
    db()
        .prepare("INSERT INTO sessions (user_id, token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)")
        .run(userId, tokenHash, now(), expiresAt.toISOString(), userAgent?.slice(0, 200) ?? null);
}

/** The user behind a live (not expired) session. */
export function findSessionUser(tokenHash: string): User | undefined {
    const row = db()
        .prepare(`
            SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?
        `)
        .get(tokenHash, now()) as unknown as UserRow | undefined;

    return row && toUser(row);
}

export function deleteSession(tokenHash: string): void {
    db().prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
}

/** Signs a user out everywhere, optionally keeping the session they are using right now. */
export function deleteSessionsOf(userId: number, exceptTokenHash?: string): number {
    return db()
        .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash IS NOT ?")
        .run(userId, exceptTokenHash ?? null).changes as number;
}

export function purgeExpiredSessions(): number {
    return db().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now()).changes as number;
}
