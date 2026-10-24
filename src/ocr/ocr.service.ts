import { createWorker, type Worker } from "tesseract.js";

export interface OcrWord {
    text: string;
    /** 0-100 */
    confidence: number;
}

export interface OcrResult {
    text: string;
    /** 0-100, whole image */
    confidence: number;
    words: OcrWord[];
}

// Language data (about 10 MB per language) is downloaded on first use and kept here
const LANGUAGES = process.env.OCR_LANGUAGES ?? "eng";
const CACHE_PATH = process.env.OCR_CACHE_PATH ?? "data/tessdata";

// The WebAssembly engine holds a few hundred MB while loaded, so it is released when idle
const IDLE_MS = 60_000;

let worker: Promise<Worker> | undefined;
let idleTimer: NodeJS.Timeout | undefined;
let queue: Promise<unknown> = Promise.resolve();

const isLoaded = () => worker !== undefined;

async function release(): Promise<void> {
    const current = worker;
    worker = undefined;
    if (idleTimer) clearTimeout(idleTimer);

    if (current) await (await current).terminate().catch(() => undefined);
}

async function recognize(image: Buffer): Promise<OcrResult> {
    worker ??= createWorker(LANGUAGES, 1, { cachePath: CACHE_PATH });
    if (idleTimer) clearTimeout(idleTimer);

    try {
        const { data } = await (await worker).recognize(image, {}, { blocks: true, text: true });

        const words = (data.blocks ?? [])
            .flatMap((block) => block.paragraphs)
            .flatMap((paragraph) => paragraph.lines)
            .flatMap((line) => line.words)
            .map((word) => ({ text: word.text, confidence: word.confidence }));

        return { text: data.text ?? "", confidence: data.confidence, words };
    } catch (error) {
        // a failed run can leave the engine in a bad state; start fresh next time
        await release();
        throw error;
    } finally {
        // (a failed run has already released the engine, so only arm the timer if one is still loaded)
        if (isLoaded()) idleTimer = setTimeout(() => void release(), IDLE_MS).unref();
    }
}

/** Reads the text of an image (PNG/JPEG). Calls are queued: the engine handles one image at a time. */
export function recognizeImage(image: Buffer): Promise<OcrResult> {
    const result = queue.then(() => recognize(image));
    queue = result.catch(() => undefined);
    return result;
}

export const shutdownOcr = release;
