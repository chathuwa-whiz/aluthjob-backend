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

/** Looked up per owner: two accounts uploading the same file must never end up sharing a record. */
export function findCandidateByHash(userId: number, hash: string): Candidate | undefined {
    const row = getDatabase()
        .prepare("SELECT id, user_id, file_name, mime_type, profile_json, created_at, updated_at FROM candidates WHERE user_id = ? AND resume_hash = ?")
        .get(userId, hash) as unknown as CandidateRow | undefined;

    return row && toCandidate(row);
}

export function createCandidate(input: {
    userId: number;
    hash: string;
    fileName: string;
    mimeType: string;
    fileData: Buffer;
    profile: Resume;
}): Candidate {
    const db = getDatabase();
    const now = new Date().toISOString();

    const result = db
        .prepare(`
            INSERT INTO candidates (user_id, resume_hash, file_name, mime_type, file_data, profile_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(input.userId, input.hash, input.fileName, input.mimeType, input.fileData, JSON.stringify(input.profile), now, now);

    return getCandidate(Number(result.lastInsertRowid))!;
}

export function getCandidate(id: number): Candidate | undefined {
    const row = getDatabase()
        .prepare("SELECT id, user_id, file_name, mime_type, profile_json, created_at, updated_at FROM candidates WHERE id = ?")
        .get(id) as unknown as CandidateRow | undefined;

    return row && toCandidate(row);
}

/** The profile is machine-extracted, so users can correct it; matching reads the corrected version. */
export function updateCandidateProfile(id: number, profile: Resume): Candidate | undefined {
    getDatabase()
        .prepare("UPDATE candidates SET profile_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(profile), new Date().toISOString(), id);

    return getCandidate(id);
}

export function getCandidateFile(id: number): { fileName: string; mimeType: string; data: Buffer } | undefined {
    const row = getDatabase()
        .prepare("SELECT file_name, mime_type, file_data FROM candidates WHERE id = ?")
        .get(id) as unknown as { file_name: string; mime_type: string; file_data: Uint8Array } | undefined;

    return row && { fileName: row.file_name, mimeType: row.mime_type, data: Buffer.from(row.file_data) };
}

export function listCandidatesOf(userId: number): Candidate[] {
    const rows = getDatabase()
        .prepare("SELECT id, user_id, file_name, mime_type, profile_json, created_at, updated_at FROM candidates WHERE user_id = ? ORDER BY id DESC")
        .all(userId) as unknown as CandidateRow[];

    return rows.map(toCandidate);
}

/** Gives an ownerless (pre-accounts) resume to a user. Used by the `assign-candidate` script, never by the API. */
export function assignCandidateOwner(candidateId: number, userId: number): boolean {
    return (
        getDatabase()
            .prepare("UPDATE candidates SET user_id = ? WHERE id = ? AND user_id IS NULL")
            .run(userId, candidateId).changes === 1
    );
}
