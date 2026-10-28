import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { isPublicAddress, resolvePublicAddress } from "../network/public-address.js";

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
const MIN_GAP_MS = 750;
const RETRIES = 2;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const lastRequestAt = new Map<string, number>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ResponseTooLargeError extends Error {
    constructor() { super("The job site's response exceeded the download limit"); }
}
class UnsafeDestinationError extends Error {}

// Count decoded bytes as they arrive; compressed, chunked and misleading Content-Length bodies are bounded too.
export async function readLimitedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Buffer> {
    if (!body) return Buffer.alloc(0);
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return Buffer.concat(chunks, bytes);
            bytes += value.byteLength;
            if (bytes > maxBytes) throw new ResponseTooLargeError();
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
}

function destination(raw: string): URL {
    let url: URL;
    try { url = new URL(raw); } catch { throw new UnsafeDestinationError("The job URL must use a public HTTP or HTTPS destination"); }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        (url.port && url.port !== "80" && url.port !== "443") || (isIP(host) && !isPublicAddress(host))) {
        throw new UnsafeDestinationError("The job URL must use a public HTTP or HTTPS destination");
    }
    return url;
}

async function throttle(host: string) {
    const wait = (lastRequestAt.get(host) ?? 0) + MIN_GAP_MS - Date.now();
    lastRequestAt.set(host, Date.now() + Math.max(wait, 0));
    if (wait > 0) await sleep(wait);
    if (lastRequestAt.size > 1000) {
        for (const [name, time] of lastRequestAt) if (time + MIN_GAP_MS < Date.now()) lastRequestAt.delete(name);
    }
}

async function sendPublic(url: URL, init: RequestInit, maxBytes: number): Promise<Response> {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const signal = AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(init.signal ? [init.signal] : [])]);
    // Resolve once; the pinned address is used by the socket, while Host/SNI/certificate checks keep the original name.
    let address: string;
    let abortLookup: (() => void) | undefined;
    try {
        signal.throwIfAborted();
        address = await Promise.race([
            resolvePublicAddress(hostname),
            new Promise<never>((_resolve, reject) => {
                abortLookup = () => reject(signal.reason);
                signal.addEventListener("abort", abortLookup, { once: true });
            }),
        ]);
    } catch (error) {
        if (error instanceof Error && error.message.includes("public address")) throw new UnsafeDestinationError(error.message);
        throw error;
    } finally {
        if (abortLookup) signal.removeEventListener("abort", abortLookup);
    }
    signal.throwIfAborted();
    const outgoing = new Request(url, init);
    const payload = outgoing.body ? Buffer.from(await outgoing.arrayBuffer()) : undefined;
    const headers = new Headers(outgoing.headers);
    if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
    if (!headers.has("accept")) headers.set("accept", "*/*");
    headers.set("accept-encoding", "gzip, deflate, br");
    headers.set("host", url.host);
    return new Promise<Response>((resolve, reject) => {
        const send = url.protocol === "https:" ? httpsRequest : httpRequest;
        const req = send(url, {
            method: outgoing.method,
            headers: Object.fromEntries(headers),
            signal,
            // Both callback forms are needed: newer Node versions can request every address.
            lookup: (_host, options, callback) => {
                const family = isIP(address);
                if (typeof options === "object" && options.all) callback(null, [{ address, family }] as never);
                else callback(null, address, family);
            },
        }, async (incoming) => {
            try {
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(incoming.headers)) {
                    if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
                }
                const status = incoming.statusCode ?? 502;
                // No redirect/error body is needed: close it immediately, rather than downloading it.
                if (status < 200 || status >= 300 || outgoing.method === "HEAD" || status === 204 || status === 205) {
                    incoming.destroy();
                    resolve(new Response(null, { status, headers: responseHeaders }));
                    return;
                }
                const advertised = Number(incoming.headers["content-length"] ?? 0);
                if (advertised > maxBytes) throw new ResponseTooLargeError();
                const encoding = incoming.headers["content-encoding"]?.toLowerCase();
                const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate() : encoding === "br" ? createBrotliDecompress() : undefined;
                if (encoding && encoding !== "identity" && !decoder) throw new Error("Unsupported response encoding");
                if (decoder) incoming.on("error", (error) => decoder.destroy(error));
                const stream = decoder ? incoming.pipe(decoder) : incoming;
                const body = await readLimitedBody(Readable.toWeb(stream) as ReadableStream<Uint8Array>, maxBytes);
                responseHeaders.delete("content-encoding");
                responseHeaders.delete("content-length");
                resolve(new Response(new Uint8Array(body), { status, headers: responseHeaders }));
            } catch (error) {
                incoming.destroy();
                reject(error);
            }
        });
        req.on("error", reject);
        req.end(payload);
    });
}

/** Validate every redirect before it is sent, including public DNS answers at connection time. */
export async function followRedirects(
    raw: string, init: RequestInit, maxBytes: number,
    send: (url: URL, init: RequestInit, maxBytes: number) => Promise<Response> = sendPublic,
): Promise<Response> {
    let url = destination(raw);
    let options = { ...init };
    for (let redirects = 0; ; redirects++) {
        const response = await send(url, options, maxBytes);
        if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.has("location")) return response;
        if (redirects >= MAX_REDIRECTS) throw new UnsafeDestinationError("Too many job-site redirects");
        const next = destination(new URL(response.headers.get("location")!, url).href);
        const headers = new Headers(options.headers);
        if (next.origin !== url.origin) {
            headers.delete("authorization");
            headers.delete("cookie");
        }
        const method = (options.method ?? "GET").toUpperCase();
        if ((response.status === 303 && method !== "HEAD") || ([301, 302].includes(response.status) && method === "POST")) {
            options = { ...options, method: "GET", body: undefined };
            headers.delete("content-type");
            headers.delete("content-length");
        }
        options.headers = headers;
        url = next;
    }
}

export async function request(url: string, init: RequestInit = {}, maxBytes = MAX_RESPONSE_BYTES): Promise<Response> {
    const host = destination(url).host;
    for (let attempt = 0; ; attempt++) {
        await throttle(host);
        try {
            const response = await followRedirects(url, init, maxBytes);
            if (response.ok) return response;
            const blocked = response.status === 403 ? " (the site is refusing this server's requests; usually a temporary block on its IP address)" : "";
            const error = new Error(`${init.method ?? "GET"} ${url} -> HTTP ${response.status}${blocked}`);
            if (response.status < 500 && response.status !== 429) throw error;
            if (attempt >= RETRIES) throw error;
        } catch (error) {
            if (error instanceof UnsafeDestinationError || error instanceof ResponseTooLargeError || init.signal?.aborted || attempt >= RETRIES ||
                (error instanceof Error && error.message.includes("-> HTTP 4") && !error.message.includes("HTTP 429"))) throw error;
        }
        await sleep(1500 * (attempt + 1));
    }
}

export const getText = async (url: string, init?: RequestInit) => (await request(url, init)).text();
export const getJson = async <T = unknown>(url: string, init?: RequestInit) => (await request(url, init)).json() as Promise<T>;
