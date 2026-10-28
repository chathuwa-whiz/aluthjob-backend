import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { inflateRawSync } from "node:zlib";
import type { ExtractedResume } from "./text-extraction.service.js";

const MAX_TEXT = 200_000;
const MAX_LINKS = 1000;
const MAX_PAGES = 100;
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;

/** Inspect ZIP metadata before inflating. ZIP64 is unnecessary for a CV. */
export function validateWordArchive(buffer: Buffer): void {
    let end = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
    }
    if (end < 0) throw new Error("Use a valid Word document (.docx)");
    const entries = buffer.readUInt16LE(end + 10);
    const size = buffer.readUInt32LE(end + 12);
    const start = buffer.readUInt32LE(end + 16);
    if (buffer.readUInt32LE(end + 4) !== 0 || entries !== buffer.readUInt16LE(end + 8) || entries > 2000 || start + size > end) {
        throw new Error("This Word document is too complex or has an unsupported archive format");
    }
    let cursor = start;
    let expanded = 0;
    for (let entry = 0; entry < entries; entry++) {
        if (cursor + 46 > start + size || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid Word archive");
        const bytes = buffer.readUInt32LE(cursor + 24);
        const compressed = buffer.readUInt32LE(cursor + 20);
        expanded += bytes;
        if (bytes === 0xffffffff || expanded > MAX_EXPANDED_BYTES) throw new Error("The expanded Word document is too large");
        const local = buffer.readUInt32LE(cursor + 42);
        const method = buffer.readUInt16LE(cursor + 10);
        if (local + 30 > start || buffer.readUInt32LE(local) !== 0x04034b50 || (buffer.readUInt16LE(cursor + 8) & 1) || ![0, 8].includes(method)) throw new Error("Unsupported Word archive entry");
        const dataStart = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
        if (dataStart + compressed > start) throw new Error("Invalid Word archive entry");
        const data = buffer.subarray(dataStart, dataStart + compressed);
        // Verify actual expansion too: forged directory lengths must not bypass the budget.
        const actual = method === 0 ? data.length : inflateRawSync(data, { maxOutputLength: Math.max(1, bytes) }).length;
        if (actual !== bytes) throw new Error("Invalid Word archive size");
        cursor += 46 + buffer.readUInt16LE(cursor + 28) + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
        if (cursor > start + size) throw new Error("Invalid Word archive");
    }
    if (cursor !== start + size) throw new Error("Invalid Word archive");
}

/** Runs inside the disposable document process. Never receives a path or URL. */
export async function parseDocument(buffer: Buffer, mimeType: string): Promise<ExtractedResume> {
    let text: string;
    let links: ExtractedResume["links"];
    if (mimeType === "application/pdf") {
        if (!buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new Error("Use a valid PDF document");
        const parser = new PDFParse({ data: buffer, isEvalSupported: false });
        try {
            const info = await parser.getInfo();
            if (info.total > MAX_PAGES) throw new Error(`Use a CV with at most ${MAX_PAGES} pages`);
            text = (await parser.getText()).text;
            links = (await parser.getInfo({ parsePageInfo: true })).pages.flatMap((page) => page.links);
        } finally { await parser.destroy(); }
    } else if (mimeType === "application/msword" || mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        validateWordArchive(buffer);
        text = (await mammoth.extractRawText({ buffer })).value;
        const html = await mammoth.convertToHtml({ buffer }, { externalFileAccess: false });
        links = [...html.value.matchAll(/<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi)].map((match) => ({
            url: match[1]!, text: match[2]!.replace(/<[^>]+>/g, "").trim(),
        }));
    } else throw new Error("Unsupported file type");
    if (text.length > MAX_TEXT || links.length > MAX_LINKS || links.some((link) => link.url.length > 8192 || link.text.length > 8192)) {
        throw new Error("This CV contains too much text or too many links");
    }
    return { text: text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim(), links };
}
