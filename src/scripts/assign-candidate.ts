import "dotenv/config";
import { assignCandidateOwner } from "../candidates/candidate.repository.js";
import { closeDatabase, getDatabase } from "../db/database.js";
import { findUserWithHash } from "../auth/user.repository.js";

// usage: npm run assign-candidate -- <email> <candidateId> | --list
// Resumes stored before accounts existed have no owner, so nobody can open them. This gives one to an account.
const args = process.argv.slice(2);

async function main(): Promise<number> {
    if (args[0] === "--list") {
        const rows = await getDatabase().all<{ id: number; file_name: string; created_at: string }>(
            "SELECT id, file_name, created_at FROM candidates WHERE user_id IS NULL ORDER BY id",
        );

        console.table(rows.map((row) => ({ id: row.id, file: row.file_name, created: row.created_at })));
        return 0;
    }

    const [email, rawId] = args;
    const user = email ? await findUserWithHash(email.trim().toLowerCase()) : undefined;
    const candidateId = Number(rawId);

    if (!user || !Number.isInteger(candidateId)) {
        console.error("usage: npm run assign-candidate -- <email> <candidateId>   (or --list to see ownerless resumes)");
        return 1;
    }

    if (await assignCandidateOwner(candidateId, user.id)) {
        console.log(`Resume #${candidateId} now belongs to ${user.email}`);
        return 0;
    }

    console.error(`Resume #${candidateId} was not changed: it does not exist or already has an owner`);
    return 1;
}

main()
    .catch((error: unknown) => {
        console.error(error);
        return 1;
    })
    .then(async (code) => {
        await closeDatabase();
        process.exit(code);
    });
