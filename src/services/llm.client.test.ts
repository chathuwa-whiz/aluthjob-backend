import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";
import { chat, LlmBusyError, resetLlmClient } from "./llm.client.js";
import { KeyPool, parseKeys } from "./groq.keypool.js";

/** Stands in for Groq: each key is limited, rejected or working, and every call is recorded. */
type Behaviour = "ok" | "limited" | "rejected";
const behaviour = new Map<string, Behaviour>();
const calls: string[] = [];
let server: Server;

before(async () => {
    server = createServer((request, response) => {
        const key = (request.headers.authorization ?? "").replace("Bearer ", "");
        calls.push(key);
        const mode = behaviour.get(key) ?? "ok";

        if (mode === "limited") {
            response.writeHead(429, { "retry-after": "30" }).end(JSON.stringify({ error: { message: "rate limit" } }));
        } else if (mode === "rejected") {
            response.writeHead(401).end("{}");
        } else {
            response.writeHead(200, { "content-type": "text/event-stream" });
            const event = (delta: object, finish: string | null = null) =>
                response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
            event({ content: `hello from ` });
            event({ content: key });
            event({}, "stop");
            response.end("data: [DONE]\n\n");
        }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.GROQ_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
    server.close();
    delete process.env.GROQ_API_KEYS;
    delete process.env.GROQ_BASE_URL;
    resetLlmClient();
});

beforeEach(() => {
    behaviour.clear();
    calls.length = 0;
    process.env.GROQ_API_KEYS = "key-a, key-b\nkey-c";
    resetLlmClient();
});

const ask = (chunks = () => {}) => chat({ system: "s", user: "u", temperature: 0, maxTokens: 50 }, chunks);

describe("Groq with several keys", () => {
    it("streams the answer and reports each piece", async () => {
        let pieces = 0;
        const result = await ask(() => pieces++);

        assert.equal(result.content, "hello from key-a");
        assert.equal(result.truncated, false);
        assert.equal(pieces, 2);
    });

    it("spreads requests over the keys", async () => {
        await ask();
        await ask();
        await ask();

        assert.deepEqual([...calls].sort(), ["key-a", "key-b", "key-c"]);
    });

    it("moves a rate-limited request to the next key at once, in the same call", async () => {
        behaviour.set("key-a", "limited");

        const result = await ask();

        assert.equal(result.content, "hello from key-b");
        assert.deepEqual(calls, ["key-a", "key-b"]);
    });

    it("leaves a limited key alone afterwards", async () => {
        behaviour.set("key-a", "limited");
        await ask();
        calls.length = 0;

        await ask();
        await ask();
        await ask();

        assert.ok(!calls.includes("key-a"), "the benched key was not retried");
    });

    it("skips a rejected key", async () => {
        behaviour.set("key-a", "rejected");
        behaviour.set("key-b", "limited");

        assert.equal((await ask()).content, "hello from key-c");
    });

    it("reports when every key is limited, with when to retry", async () => {
        for (const key of ["key-a", "key-b", "key-c"]) behaviour.set(key, "limited");

        await assert.rejects(ask(), (error: unknown) => error instanceof LlmBusyError && error.retryAfterSeconds > 0);
        assert.equal(calls.length, 3, "each key was tried once");
    });
});

describe("key pool", () => {
    it("brings a key back when its rest is over", () => {
        let now = 0;
        const pool = new KeyPool(["a", "b"], () => now);
        pool.bench("a", 1000);

        assert.deepEqual(pool.available(), ["b"]);
        assert.equal(pool.waitForNext(), 0);
        now = 1000;
        assert.equal(pool.available().length, 2);
    });

    it("reads keys separated by commas, spaces or lines", () => {
        assert.deepEqual(parseKeys("a, b\nc;;a"), ["a", "b", "c"]);
        assert.deepEqual(parseKeys(undefined), []);
    });
});
