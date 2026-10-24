import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

export interface ResumeLink {
    text: string;
    url: string;
}

export interface ExtractedResume {
    text: string;
    /** Hyperlink annotations; their URLs are not part of the visible text. */
    links: ResumeLink[];
}

const HTML_LINK_RE = /<a\s+[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gi;

export async function extractResumeContent(
    file: Express.Multer.File
): Promise<ExtractedResume> {
    let text = "";
    let links: ResumeLink[] = [];

    if(file.mimetype === "application/pdf") {
        const parser = new PDFParse({ data: file.buffer });
        const result = await parser.getText();
        const info = await parser.getInfo({ parsePageInfo: true });
        await parser.destroy();
        text = result.text;
        links = info.pages.flatMap((page) => page.links);
    } else if (file.mimetype === "application/msword" || file.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        text = result.value;

        const html = await mammoth.convertToHtml({ buffer: file.buffer });
        links = [...html.value.matchAll(HTML_LINK_RE)].map((match) => ({
            url: match[1]!,
            text: match[2]!.replace(/<[^>]+>/g, "").trim(),
        }));
    } else {
        throw new Error("Unsupported file type");
    }

    // Collapse layout whitespace; every extra character costs prompt tokens on a CPU-only model
    return {
        text: text
            .replace(/[ \t]+/g, " ")
            .replace(/ ?\n ?/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim(),
        links,
    };
}