import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RuleError } from "../errors.js";
import { WorkBudget } from "../security/work-budget.js";

export interface ResumeLink { text: string; url: string; }
export interface ExtractedResume { text: string; links: ResumeLink[]; }

const parsers = new WorkBudget(2, "Document processing");

/** Untrusted parsers run outside the API process, with a heap budget and a hard deadline. */
export function extractResumeContent(file: Express.Multer.File): Promise<ExtractedResume> {
    return parsers.run(() => new Promise((resolve, reject) => {
        const compiled = join(__dirname, "document-worker.js");
        const source = !existsSync(compiled);
        const child = fork(source ? join(__dirname, "document-worker.ts") : compiled, [], {
            execArgv: ["--max-old-space-size=192", ...(source ? ["--import", "tsx"] : [])],
            serialization: "advanced",
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            windowsHide: true,
            // Parsing does not need database credentials, mailbox keys, or API tokens.
            env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP)$/i.test(name))),
        });
        const failure = () => new RuleError("This CV could not be read within the document limits. Use a text-based PDF or Word document with at most 100 pages");
        let settled = false;
        const finish = (result?: ExtractedResume) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill();
            if (result) resolve(result); else reject(failure());
        };
        const timer = setTimeout(() => finish(), 20_000);
        child.once("error", () => finish());
        child.once("exit", () => finish());
        child.once("message", (message: { result?: ExtractedResume }) => finish(message.result));
        child.send({ buffer: file.buffer, mimeType: file.mimetype }, (error) => { if (error) finish(); });
    }));
}
