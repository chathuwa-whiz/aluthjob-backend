import { getDatabase } from "../db/database.js";
import { RuleError } from "../errors.js";
import type { Resume } from "../schemas/resume.schema.js";

export interface Candidate {
    id: number;
    /** The owning account; null only for rows from before accounts existed. */
    userId: number | null;
    fileName: string;
    mimeType: string;
    profile: Resume;
    createdAt: string;
    updatedAt: string;
}

interface CandidateRow {
    id: number;
    user_id: number | null;
    file_name: string;
    mime_type: string;
    profile_json: string;
    created_at: string;
    updated_at: string;
}

const toCandidate = (row: CandidateRow): Candidate => ({
    id: row.id,
    userId: row.user_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    profile: JSON.parse(row.profile_json) as Resume,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

// the resume file itself (file_data) is left out: it can be large and is read only when attaching it
const COLUMNS = "id, user_id, file_name, mime_type, profile_json, created_at, updated_at";

/** Looked up per owner: two accounts uploading the same file must never end up sharing a record. */
export async function findCandidateByHash(userId: number, hash: string): Promise<Candidate | undefined> {
    const row = await getDatabase().get<CandidateRow>(`SELECT ${COLUMNS} FROM candidates WHERE user_id = ? AND resume_hash = ?`, [userId, hash]);
    return row && toCandidate(row);
}

export async function createCandidate(input: {
    userId: number;
    hash: string;
    fileName: string;
    mimeType: string;
    fileData: Buffer;
    profile: Resume;
}): Promise<Candidate> {
    const now = new Date().toISOString();

    const id = await getDatabase().insert(
        `INSERT INTO candidates (user_id, resume_hash, file_name, mime_type, file_data, profile_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.userId, input.hash, input.fileName, input.mimeType, input.fileData, JSON.stringify(input.profile), now, now],
    );

    return (await getCandidate(id))!;
}

export async function getCandidate(id: number): Promise<Candidate | undefined> {
    const row = await getDatabase().get<CandidateRow>(`SELECT ${COLUMNS} FROM candidates WHERE id = ?`, [id]);
    return row && toCandidate(row);
}

/** The profile is machine-extracted, so users can correct it; matching reads the corrected version. */
export async function updateCandidateProfile(id: number, profile: Resume): Promise<Candidate | undefined> {
    await getDatabase().run("UPDATE candidates SET profile_json = ?, updated_at = ? WHERE id = ?", [JSON.stringify(profile), new Date().toISOString(), id]);

    return getCandidate(id);
}

export async function getCandidateFile(id: number): Promise<{ fileName: string; mimeType: string; data: Buffer } | undefined> {
    const row = await getDatabase().get<{ file_name: string; mime_type: string; file_data: Buffer }>(
        "SELECT file_name, mime_type, file_data FROM candidates WHERE id = ?",
        [id],
    );

    return row && { fileName: row.file_name, mimeType: row.mime_type, data: Buffer.from(row.file_data) };
}

export async function listCandidatesOf(userId: number): Promise<Candidate[]> {
    const rows = await getDatabase().all<CandidateRow>(`SELECT ${COLUMNS} FROM candidates WHERE user_id = ? ORDER BY id DESC`, [userId]);
    return rows.map(toCandidate);
}

/** Administrators only: moves a resume to another account (or to nobody). */
export async function setCandidateOwner(candidateId: number, userId: number | null): Promise<boolean> {
    return changeCandidateOwner(candidateId, userId);
}

async function changeCandidateOwner(candidateId: number, userId: number | null, onlyUnowned = false): Promise<boolean> {
    return getDatabase().transaction(async (tx) => {
        // Mailbox saves and send claims take this same short row lock. Ownership never changes
        // while an SMTP send is in progress, and credentials cannot be saved across a transfer.
        const candidate = await tx.get<{ user_id: number | null }>("SELECT user_id FROM candidates WHERE id = ? FOR UPDATE", [candidateId]);
        if (!candidate) return false;
        if (onlyUnowned && candidate.user_id !== null) return false;
        if (candidate.user_id === userId) return true;
        const sending = await tx.get<{ n: number }>("SELECT COUNT(*) AS n FROM applications WHERE candidate_id = ? AND status = 'sending'", [candidateId]);
        if (sending!.n > 0) throw new RuleError("Wait for the application being sent before changing this resume's owner");
        const at = new Date().toISOString();
        await tx.run("DELETE FROM mail_accounts WHERE candidate_id = ?", [candidateId]);
        await tx.run("UPDATE applications SET status = 'cancelled', error = ?, updated_at = ? WHERE candidate_id = ? AND status IN ('queued', 'failed')", ["Resume ownership changed; connect a mailbox and approve again before sending", at, candidateId]);
        await tx.run("UPDATE matches SET status = CASE WHEN status = 'approved' THEN 'suggested' ELSE status END, confirmed_email = NULL, updated_at = ? WHERE candidate_id = ?", [at, candidateId]);
        await tx.run("UPDATE candidates SET user_id = ?, updated_at = ? WHERE id = ?", [userId, at, candidateId]);
        return true;
    });
}

/** Deletes the resume with its matches, mailbox and applications (ON DELETE CASCADE). */
export async function deleteCandidate(candidateId: number): Promise<boolean> {
    return (await getDatabase().run("DELETE FROM candidates WHERE id = ?", [candidateId])).changes > 0;
}

/** Gives an ownerless (pre-accounts) resume to a user. Used by the `assign-candidate` script, never by the API. */
export async function assignCandidateOwner(candidateId: number, userId: number): Promise<boolean> {
    return changeCandidateOwner(candidateId, userId, true);
}
