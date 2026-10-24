import "dotenv/config";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { findUserWithHash } from "../auth/user.repository.js";
import { listMatches } from "../matching/match.repository.js";
import { runMatching } from "../matching/match.service.js";
import { analyzeResume } from "../services/resume.service.js";

// usage: npm run match -- <resume.pdf|.docx> --user=<email of an existing account> [--min=35] [--limit=100] [--enrich=20] [--draft=0] [--show=15]
const [file, ...flags] = process.argv.slice(2);

if (!file) {
    console.error("usage: npm run match -- <resume.pdf|resume.docx> --user=<email> [--min=N] [--limit=N] [--enrich=N] [--draft=N] [--show=N]");
    process.exit(1);
}

const userEmail = flags.find((arg) => arg.startsWith("--user="))?.slice("--user=".length);

const flag = (name: string) => {
    const value = flags.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
    return value === undefined ? undefined : Number(value);
};

const MIME: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

async function main() {
    const user = userEmail ? findUserWithHash(userEmail.trim().toLowerCase()) : undefined;
    if (!user) throw new Error("Pass --user=<email> of an existing account (register one through the API first); resumes belong to an account");

    const mimetype = MIME[extname(file!).toLowerCase()];
    if (!mimetype) throw new Error("Resume must be a .pdf, .doc or .docx file");

    console.log("Reading resume (the model runs on first upload and can take a few minutes)...");
    const { candidateId, profile } = await analyzeResume(user.id, {
        buffer: readFileSync(file!),
        mimetype,
        originalname: basename(file!),
    } as Express.Multer.File);

    console.log(`Candidate #${candidateId}: ${profile.personalInfo.fullName}, ${profile.skills.length} skills, ${profile.experience.length} jobs`);

    const summary = await runMatching(candidateId, {
        ...(flag("min") !== undefined && { minScore: flag("min")! }),
        ...(flag("limit") !== undefined && { limit: flag("limit")! }),
        ...(flag("enrich") !== undefined && { enrichTop: flag("enrich")! }),
        ...(flag("draft") !== undefined && { draftTop: flag("draft")! }),
    });
    console.log("Run:", summary);

    for (const match of listMatches(candidateId, { limit: flag("show") ?? 15 })) {
        const { job } = match;
        console.log(`\n${String(match.score).padStart(3)}  ${job.title} | ${job.company ?? "?"} | ${job.location ?? "?"} [${job.source}, apply by ${match.applyMethod}]`);
        console.log(`     ${match.details.reasons.join(" / ") || "(no strong signals)"}`);
        for (const warning of match.details.warnings) console.log(`     ! ${warning}`);
        if (match.coverLetter) console.log(`\n--- ${match.subject}\n${match.coverLetter}\n---`);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
