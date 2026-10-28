import { getDatabase, isUniqueViolation } from "../db/database.js";
import { decryptSecret, encryptSecret } from "./secret-box.js";
import type { SmtpSettings } from "./smtp.js";
import { NotFoundError } from "../errors.js";

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

const selectRow = (candidateId: number) => getDatabase().get<MailAccountRow>("SELECT * FROM mail_accounts WHERE candidate_id = ?", [candidateId]);

export async function saveMailAccount(input: Omit<MailAccount, "verifiedAt"> & { password: string }, expectedOwnerId?: number): Promise<MailAccount> {
    const now = new Date().toISOString();

    await getDatabase().transaction(async (tx) => {
        const candidate = await tx.get<{ user_id: number | null }>("SELECT user_id FROM candidates WHERE id = ? FOR UPDATE", [input.candidateId]);
        if (!candidate || (expectedOwnerId !== undefined && candidate.user_id !== expectedOwnerId)) throw new NotFoundError("Candidate not found");
        const saved = await tx.run(
            `UPDATE mail_accounts
             SET email = ?, from_name = ?, host = ?, port = ?, secure = ?, username = ?, password_enc = ?, verified_at = ?, updated_at = ?
             WHERE candidate_id = ?`,
            [input.email, input.fromName, input.host, input.port, input.secure ? 1 : 0, input.username, encryptSecret(input.password), now, now, input.candidateId],
        );

        if (saved.changes === 0) {
            try {
                await tx.run(
                    `INSERT INTO mail_accounts (candidate_id, email, from_name, host, port, secure, username, password_enc, verified_at, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [input.candidateId, input.email, input.fromName, input.host, input.port, input.secure ? 1 : 0, input.username, encryptSecret(input.password), now, now, now],
                );
            } catch (error) {
                // saved twice at once: the other request inserted the row first, so this one only updates it
                if (!isUniqueViolation(error)) throw error;
                await tx.run(
                    "UPDATE mail_accounts SET email = ?, from_name = ?, host = ?, port = ?, secure = ?, username = ?, password_enc = ?, verified_at = ?, updated_at = ? WHERE candidate_id = ?",
                    [input.email, input.fromName, input.host, input.port, input.secure ? 1 : 0, input.username, encryptSecret(input.password), now, now, input.candidateId],
                );
            }
        }
    });

    return (await getMailAccount(input.candidateId))!;
}

export async function getMailAccount(candidateId: number): Promise<MailAccount | undefined> {
    const row = await selectRow(candidateId);
    return row && toAccount(row);
}

/** The only place a decrypted password leaves storage; used right before connecting. */
export async function getSmtpSettings(candidateId: number): Promise<(SmtpSettings & { email: string; fromName: string | null }) | undefined> {
    const row = await selectRow(candidateId);
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

export async function deleteMailAccount(candidateId: number): Promise<boolean> {
    return (await getDatabase().run("DELETE FROM mail_accounts WHERE candidate_id = ?", [candidateId])).changes > 0;
}
