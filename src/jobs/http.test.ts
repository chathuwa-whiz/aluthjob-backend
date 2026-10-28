import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { followRedirects, readLimitedBody, ResponseTooLargeError } from "./http.js";

describe("bounded external downloads", () => {
    it("stops chunked responses while reading, rather than after allocating the complete body", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) { controller.enqueue(new Uint8Array(4)); },
            cancel() { cancelled = true; },
        });
        await assert.rejects(readLimitedBody(body, 7), ResponseTooLargeError);
        assert.equal(cancelled, true);
    });
    it("accepts a complete response exactly at the byte limit", async () => {
        const body = new Response("hello").body;
        assert.equal((await readLimitedBody(body, 5)).toString(), "hello");
    });
    it("rejects unsafe initial URLs without attempting a connection", async () => {
        for (const url of ["http://127.1/", "http://[::ffff:7f00:1]/", "http://169.254.169.254/", "file:///etc/passwd", "https://user:pass@example.com/", "http://8.8.8.8:22/"]) {
            await assert.rejects(followRedirects(url, {}, 100, async () => assert.fail("unsafe destination was contacted")), /public HTTP/);
        }
    });
    it("rejects private and non-HTTP redirect destinations before contacting them", async () => {
        for (const target of ["http://10.1.2.3/", "http://[::ffff:7f00:1]/", "file:///etc/passwd"]) {
            let sent = 0;
            await assert.rejects(followRedirects("https://example.com/", {}, 100, async () => {
                sent++;
                return new Response(null, { status: 302, headers: { location: target } });
            }), /public HTTP/);
            assert.equal(sent, 1);
        }
    });
    it("preserves normal relative redirects and POST-to-GET behavior", async () => {
        const calls: { url: string; method: string; body: unknown }[] = [];
        const response = await followRedirects("https://example.com/start", { method: "POST", body: "query=jobs" }, 100, async (url, init) => {
            calls.push({ url: url.href, method: init.method ?? "GET", body: init.body });
            return calls.length === 1 ? new Response(null, { status: 302, headers: { location: "/jobs" } }) : new Response("ok");
        });
        assert.equal(await response.text(), "ok");
        assert.deepEqual(calls, [
            { url: "https://example.com/start", method: "POST", body: "query=jobs" },
            { url: "https://example.com/jobs", method: "GET", body: undefined },
        ]);
    });
    it("strips cookies and authorization across origins and bounds redirect loops", async () => {
        let count = 0;
        await assert.rejects(followRedirects("https://example.com/", { headers: { authorization: "Bearer secret", cookie: "session=secret" } }, 100, async (_url, init) => {
            if (++count > 1) {
                assert.equal(new Headers(init.headers).has("authorization"), false);
                assert.equal(new Headers(init.headers).has("cookie"), false);
            }
            return new Response(null, { status: 307, headers: { location: "https://other.example/again" } });
        }), /Too many/);
        assert.equal(count, 6);
    });
});
