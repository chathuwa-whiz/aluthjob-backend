import { ollama } from "./ollama.client.js";
import { KeyPool, parseKeys } from "./groq.keypool.js";

/**
 * One entry point for every model call. With GROQ_API_KEYS set the request goes to Groq, spread over
 * all keys and moved to the next key the moment one is rate limited; if Groq fails altogether (or no
 * keys are set) the local Ollama model answers.
 * The same model reads resumes and writes cover letters.
 */
export interface ChatRequest {
    system: string;
    user: string;
    temperature: number;
    /** Hard cap so a runaway generation cannot hang the request. */
    maxTokens: number;
    /** When set, the answer must be JSON matching this JSON Schema. */
    jsonSchema?: object;
}

export interface ChatResult {
    content: string;
    /** The model stopped because it hit maxTokens, so `content` is incomplete. */
    truncated: boolean;
}

/** Called once for every piece of text the model streams, to show progress. */
export type OnChunk = () => void;

export class LlmBusyError extends Error {
    constructor(readonly retryAfterSeconds: number) {
        super(`Every model API key is rate limited; the first is free again in ${retryAfterSeconds}s`);
    }
}

const groqUrl = () => `${process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1"}/chat/completions`;
export const GROQ_MODEL = () => process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const DEFAULT_BENCH_MS = 60_000;
const BAD_KEY_BENCH_MS = 60 * 60_000;
const NETWORK_BENCH_MS = 10_000;
/** If a key frees up sooner than this, it is cheaper to wait for it than to fail the request. */
const MAX_WAIT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 120_000;

let pool: KeyPool | undefined;

function groqPool(): KeyPool | null {
    // Read lazily: the environment is loaded by dotenv after imports are evaluated
    pool ??= new KeyPool(parseKeys([process.env.GROQ_API_KEYS, process.env.GROQ_API_KEY].filter(Boolean).join(",")));
    return pool.keys.length ? pool : null;
}

/** For tests. */
export function resetLlmClient(): void {
    pool = undefined;
}

export const llmProvider = () => (groqPool() ? ("groq" as const) : ("ollama" as const));

/** Which model answers and how healthy the API keys are. Holds no key material. */
export function llmStatus() {
    const keys = groqPool();
    return {
        provider: llmProvider(),
        groqModel: GROQ_MODEL(),
        ollamaModel: OLLAMA_MODEL(),
        keys: keys ? keys.status() : { total: 0, usable: 0, resting: [] },
    };
}

export async function chat(request: ChatRequest, onChunk: OnChunk = () => {}): Promise<ChatResult> {
    const keys = groqPool();
    if (!keys) return ollamaChat(request, onChunk);

    try {
        return await groqChat(keys, request, onChunk);
    } catch (groqError) {
        // Every key limited, rejected or unreachable (or Groq refused the request): the local model takes over
        const reason = groqError instanceof Error ? groqError.message : String(groqError);
        console.warn(`Groq failed (${reason}); falling back to local model ${OLLAMA_MODEL()}`);

        try {
            return await ollamaChat(request, onChunk);
        } catch (localError) {
            const local = localError instanceof Error ? localError.message : String(localError);
            throw new Error(`Groq failed (${reason}) and the local model failed too (${local})`);
        }
    }
}

// ---- Groq ------------------------------------------------------------------------------

function retryAfterMs(response: Response): number {
    const seconds = Number(response.headers.get("retry-after"));
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : DEFAULT_BENCH_MS;
}

function groqBody(request: ChatRequest) {
    // Groq's JSON mode needs the word JSON in the prompt; the schema is given there because
    // not every model supports schema-constrained decoding. The caller validates the result.
    const system = request.jsonSchema
        ? `${request.system}\n\nRespond with a single JSON object that matches this JSON Schema:\n${JSON.stringify(request.jsonSchema)}`
        : request.system;

    return {
        model: GROQ_MODEL(),
        messages: [
            { role: "system", content: system },
            { role: "user", content: request.user },
        ],
        temperature: request.temperature,
        max_completion_tokens: request.maxTokens,
        stream: true,
        ...(request.jsonSchema ? { response_format: { type: "json_object" } } : {}),
    };
}

async function groqChat(keys: KeyPool, request: ChatRequest, onChunk: OnChunk): Promise<ChatResult> {
    const body = JSON.stringify(groqBody(request));

    for (let round = 0; round < 2; round++) {
        for (const key of keys.available()) {
            let response: Response;
            try {
                response = await fetch(groqUrl(), {
                    method: "POST",
                    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
                    body,
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
            } catch (error) {
                console.warn(`Groq ${keys.label(key)} unreachable, trying the next key:`, error instanceof Error ? error.message : error);
                keys.bench(key, NETWORK_BENCH_MS);
                continue;
            }

            if (response.status === 429 || response.status >= 500) {
                const wait = retryAfterMs(response);
                console.warn(`Groq ${keys.label(key)} answered ${response.status}, switching key (benched ${Math.round(wait / 1000)}s)`);
                keys.bench(key, wait);
                await response.body?.cancel();
                continue;
            }
            if (response.status === 401 || response.status === 403) {
                console.warn(`Groq ${keys.label(key)} was rejected (${response.status}); check that the key is valid. Skipping it for an hour.`);
                keys.bench(key, BAD_KEY_BENCH_MS);
                await response.body?.cancel();
                continue;
            }
            // Any other refusal is about the request itself (bad model name, too large), so another key cannot help
            if (!response.ok) throw new Error(`Groq request failed (${response.status}): ${(await response.text()).slice(0, 300)}`);

            return readGroqStream(response, onChunk);
        }

        const wait = keys.waitForNext();
        if (round === 1 || wait > MAX_WAIT_MS) throw new LlmBusyError(Math.ceil(wait / 1000));
        await new Promise((resolve) => setTimeout(resolve, wait + 50));
    }

    throw new LlmBusyError(0);
}

async function readGroqStream(response: Response, onChunk: OnChunk): Promise<ChatResult> {
    const decoder = new TextDecoder();
    let buffered = "";
    let content = "";
    let finishReason: string | null = null;

    for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(part, { stream: true });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";

        for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") continue;

            const choice = (JSON.parse(data) as { choices?: { delta?: { content?: string }; finish_reason?: string | null }[] }).choices?.[0];
            if (choice?.delta?.content) {
                content += choice.delta.content;
                onChunk();
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
        }
    }

    return { content, truncated: finishReason === "length" };
}

// ---- Ollama (no API keys configured) -------------------------------------------------------

export const OLLAMA_MODEL = () => process.env.OLLAMA_MODEL ?? "qwen3.5:2b";

async function ollamaChat(request: ChatRequest, onChunk: OnChunk): Promise<ChatResult> {
    const options = {
        model: OLLAMA_MODEL(),
        messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
        ],
        ...(request.jsonSchema ? { format: request.jsonSchema } : {}),
        // Streamed so response headers arrive immediately; a non-streamed request
        // sends nothing until generation finishes and hits undici's 5 min headers timeout.
        stream: true as const,
        keep_alive: "30m",
        options: {
            temperature: request.temperature,
            num_ctx: 4096,
            num_predict: request.maxTokens,
            num_thread: Number(process.env.OLLAMA_NUM_THREADS ?? 4),
        },
    };

    // Reasoning is far too slow on a small local model; models without a reasoning mode reject the flag
    const stream = await ollama.chat({ ...options, think: false }).catch((error: unknown) => {
        if (error instanceof Error && /think/i.test(error.message)) return ollama.chat(options);
        throw error;
    });

    let content = "";
    let doneReason: string | undefined;
    for await (const piece of stream) {
        content += piece.message.content;
        onChunk();
        if (piece.done) doneReason = piece.done_reason;
    }

    return { content, truncated: doneReason === "length" };
}
