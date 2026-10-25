import "dotenv/config";
import { findUserWithHash, markEmailVerified, setRole } from "../auth/user.repository.js";
import { closeDatabase } from "../db/database.js";

// usage: npm run make-admin -- <email> [--revoke]
// Administrators can trigger a collection from the job sites. There is deliberately no way to become one
// through the API: this runs on the server, by someone who already has shell access to it.
const [email, ...flags] = process.argv.slice(2);

async function main(): Promise<number> {
    const user = email ? await findUserWithHash(email.trim().toLowerCase()) : undefined;

    if (!user) {
        console.error("usage: npm run make-admin -- <email of a registered account> [--revoke]");
        return 1;
    }

    const role = flags.includes("--revoke") ? "user" : "admin";
    await setRole(user.id, role);
    if (role === "admin") await markEmailVerified(user.id); // whoever can run this on the server needs no email proof
    console.log(`${user.email} is now ${role === "admin" ? "an administrator" : "a regular user"}`);
    return 0;
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
