import { getDatabase } from "../db/database.js";
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

/** Gives an ownerless (pre-accounts) resume to a user. Used by the `assign-candidate` script, never by the API. */
export async function assignCandidateOwner(candidateId: number, userId: number): Promise<boolean> {
    return (await getDatabase().run("UPDATE candidates SET user_id = ? WHERE id = ? AND user_id IS NULL", [userId, candidateId])).changes === 1;
}
