import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

// Configuration must be in place before the modules under test are loaded
process.env.DATABASE_PATH = ":memory:";

type Mods = {
    db: typeof import("../db/database.js");
    users: typeof import("../auth/user.repository.js");
    tracker: typeof import("./analysis-tracker.js");
    ollama: typeof import("./ollama.client.js");
};
let m: Mods;
let userId: number;
let originalChat: unknown;

/** A tiny but valid one-page PDF whose text layer holds `lines`. */
function pdf(lines: string[]): Buffer {
    const escape = (line: string) => line.replace(/[\\()]/g, (character) => `\\${character}`);
    const stream = `BT /F1 12 Tf 14 TL 50 740 Td ${lines.map((line) => `(${escape(line)}) Tj T*`).join(" ")} ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let body = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((object, index) => {
        offsets.push(body.length);
        body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = body.length;
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(body);
}

const cv = (extra = "") => pdf(["Ama Perera", "ama@example.test", "EXPERIENCE", "Webminds - Full Stack Developer", "SKILLS", "React, Node.js, TypeScript", extra]);
const file = (buffer: Buffer, name = "cv.pdf") => ({ buffer, originalname: name, mimetype: "application/pdf" }) as Express.Multer.File;

const profileJson = JSON.stringify({
    personalInfo: { fullName: "Ama Perera", email: null, phone: null, location: null, linkedin: null, portfolio: null },
    education: [],
    experience: [{ company: "Webminds", position: "Full Stack Developer", startDate: null, endDate: null, responsibilities: [] }],
    skills: ["React", "Node.js", "TypeScript"],
    certifications: [],
    achievements: [],
});

/** Stands in for the local model: streams the answer in pieces so progress can be observed, and counts calls. */
function fakeModel(options: { pieces?: number; onPiece?: () => void; fail?: boolean } = {}) {
    const state = { calls: 0 };
    (m.ollama.ollama as unknown as { chat: unknown }).chat = async () => {
        state.calls++;
        if (options.fail) throw new Error("connect ECONNREFUSED 127.0.0.1:11434 internal detail");
        const pieces = options.pieces ?? 5;
        const size = Math.ceil(profileJson.length / pieces);
        return (async function* () {
            for (let i = 0; i < pieces; i++) {
                await new Promise((resolve) => setTimeout(resolve, 15));
                options.onPiece?.();
                yield { message: { content: profileJson.slice(i * size, (i + 1) * size) }, done: i === pieces - 1, done_reason: "stop" };
            }
        })();
    };
    return state;
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition: () => boolean) => {
    for (let waited = 0; !condition(); waited += 5) {
        if (waited > 8000) throw new Error("timed out waiting for the CV");
        await tick(5);
    }
};
const finished = () => until(() => m.tracker.getAnalysis(userId)!.status !== "running");

before(async () => {
    m = {
        db: await import("../db/database.js"),
        users: await import("../auth/user.repository.js"),
        tracker: await import("./analysis-tracker.js"),
        ollama: await import("./ollama.client.js"),
    };
    originalChat = (m.ollama.ollama as unknown as { chat: unknown }).chat;
});

beforeEach(() => {
    m.tracker.forgetAnalyses();
    m.db.getDatabase().exec("DELETE FROM matches; DELETE FROM jobs; DELETE FROM candidates; DELETE FROM users;");
    userId = m.users.createUser("a@example.test", "x")!.id;
});

after(() => {
    (m.ollama.ollama as unknown as { chat: unknown }).chat = originalChat;
});

describe("following a CV being read", () => {
    it("is null before anything was uploaded", () => {
        assert.equal(m.tracker.getAnalysis(userId), null);
    });

    it("returns at once, then shows what was read, what was found and how far the model has written", async () => {
        const seen: { phase: string; writing: number }[] = [];
        fakeModel({ pieces: 5, onPiece: () => seen.push({ phase: m.tracker.getAnalysis(userId)!.phase, writing: m.tracker.getAnalysis(userId)!.writing }) });

        const started = m.tracker.startAnalysis(userId, file(cv()));
        assert.equal(started.status, "running");
        assert.equal(started.fileName, "cv.pdf");

        await finished();
        const done = m.tracker.getAnalysis(userId)!;

        assert.equal(done.status, "done");
        assert.equal(done.phase, "done");
        assert.ok(done.characters! > 30, "reports how much text was read");
        assert.ok(done.skills! >= 3, "reports the skills the fast parser found");
        assert.equal(done.reused, false);
        assert.equal(done.writing, 1);
        assert.equal(done.result?.profile.personalInfo.fullName, "Ama Perera");
        assert.ok(done.result?.candidateId);

        assert.ok(seen.length === 5 && seen.every((entry) => entry.phase === "understanding"));
        assert.ok(seen[4]!.writing > seen[0]!.writing, "writing advances while the model streams");
        assert.ok(seen.every((entry) => entry.writing < 1), "never claims to be finished before it is");
    });

    it("skips the slow step when the same CV was read before, and says so", async () => {
        const model = fakeModel();
        m.tracker.startAnalysis(userId, file(cv()));
        await finished();

        m.tracker.startAnalysis(userId, file(cv()));
        await finished();

        const again = m.tracker.getAnalysis(userId)!;
        assert.equal(model.calls, 1);
        assert.equal(again.reused, true);
        assert.equal(again.status, "done");
    });

    it("refuses a second CV while one is being read", async () => {
        fakeModel({ pieces: 8 });
        m.tracker.startAnalysis(userId, file(cv()));

        assert.throws(() => m.tracker.startAnalysis(userId, file(cv("another"))), /still being read/);
        await finished();
        assert.doesNotThrow(() => m.tracker.startAnalysis(userId, file(cv("another"))));
        await finished();
    });

    it("reports a failure without leaking the internal reason", async () => {
        fakeModel({ fail: true });
        const log = console.error;
        console.error = () => {};
        try {
            m.tracker.startAnalysis(userId, file(cv()));
            await finished();
        } finally {
            console.error = log;
        }

        const failed = m.tracker.getAnalysis(userId)!;
        assert.equal(failed.status, "failed");
        assert.equal(failed.result, null);
        assert.doesNotMatch(failed.error ?? "", /ECONNREFUSED|11434/);
        assert.match(failed.error ?? "", /could not be read/);
    });

    it("keeps each person's CV separate", async () => {
        fakeModel();
        const other = m.users.createUser("b@example.test", "x")!.id;
        m.tracker.startAnalysis(userId, file(cv()));
        await finished();

        assert.equal(m.tracker.getAnalysis(other), null);
    });
});
