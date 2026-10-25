import { Ollama } from "ollama";

/** Local fallback, used only when no GROQ_API_KEYS are set. Call it through llm.client.ts. */
export const ollama = new Ollama({
    host: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"
});
