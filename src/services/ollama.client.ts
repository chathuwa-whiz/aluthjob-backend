import { Ollama } from "ollama";

export const ollama = new Ollama({
    host: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"
});

export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:2b";
/** Cover letters may use a larger model than resume parsing; falls back to the parsing model. */
export const OLLAMA_LETTER_MODEL = process.env.OLLAMA_LETTER_MODEL ?? OLLAMA_MODEL;
export const OLLAMA_THREADS = Number(process.env.OLLAMA_NUM_THREADS ?? 4);
