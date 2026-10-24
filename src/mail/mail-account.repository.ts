import { getDatabase } from "../db/database.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";
import type { SmtpSettings } from "./smtp.js";

/** What the API may show: everything except the password. */
export interface MailAccount {
    candidateId: number;
    email: string;
    fromName: string | null;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    verifiedAt: string;
}

interface MailAccountRow {
    candidate_id: number;
    email: string;
    from_name: string | null;
    host: string;
    port: number;
    secure: number;
    username: string;
    password_enc: string;
    verified_at: string;
}

const toAccount = (row: MailAccountRow): MailAccount => ({
    candidateId: row.candidate_id,
    email: row.email,
    fromName: row.from_name,
    host: row.host,
    port: row.port,
    secure: row.secure === 1,
    username: row.username,
    verifiedAt: row.verified_at,
});

const selectRow = (candidateId: number) =>
    getDatabase().prepare("SELECT * FROM mail_accounts WHERE candidate_id = ?").get(candidateId) as unknown as MailAccountRow | undefined;

export function saveMailAccount(input: Omit<MailAccount, "verifiedAt"> & { password: string }): MailAccount {
    const now = new Date().toISOString();

    getDatabase()
        .prepare(`
            INSERT INTO mail_accounts (candidate_id, email, from_name, host, port, secure, username, password_enc, verified_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (candidate_id) DO UPDATE SET
                email = excluded.email, from_name = excluded.from_name, host = excluded.host, port = excluded.port,
                secure = excluded.secure, username = excluded.username, password_enc = excluded.password_enc,
                verified_at = excluded.verified_at, updated_at = excluded.updated_at
        `)
        .run(
            input.candidateId, input.email, input.fromName, input.host, input.port, input.secure ? 1 : 0,
            input.username, encryptSecret(input.password), now, now, now,
        );

    return getMailAccount(input.candidateId)!;
}

export function getMailAccount(candidateId: number): MailAccount | undefined {
    const row = selectRow(candidateId);
    return row && toAccount(row);
}

/** The only place a decrypted password leaves storage; used right before connecting. */
export function getSmtpSettings(candidateId: number): (SmtpSettings & { email: string; fromName: string | null }) | undefined {
    const row = selectRow(candidateId);
    if (!row) return undefined;

    return {
        host: row.host,
        port: row.port,
        secure: row.secure === 1,
        username: row.username,
        password: decryptSecret(row.password_enc),
        email: row.email,
        fromName: row.from_name,
    };
}

export function deleteMailAccount(candidateId: number): boolean {
    return getDatabase().prepare("DELETE FROM mail_accounts WHERE candidate_id = ?").run(candidateId).changes > 0;
}
