const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 20_000;
const MIN_GAP_MS = 750;
const RETRIES = 2;

const lastRequestAt = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Politeness: never hit one host more than ~1.3 times a second
async function throttle(host: string) {
    const wait = (lastRequestAt.get(host) ?? 0) + MIN_GAP_MS - Date.now();
    lastRequestAt.set(host, Date.now() + Math.max(wait, 0));
    if (wait > 0) await sleep(wait);
}

export async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const host = new URL(url).host;

    for (let attempt = 0; ; attempt++) {
        await throttle(host);

        try {
            const response = await fetch(url, {
                ...init,
                headers: { "user-agent": USER_AGENT, accept: "*/*", ...init.headers },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });

            if (response.ok) return response;
            if (response.status < 500 && response.status !== 429) {
                const blocked = response.status === 403 ? " (the site is refusing this server's requests; usually a temporary block on its IP address)" : "";
                throw new Error(`${init.method ?? "GET"} ${url} -> HTTP ${response.status}${blocked}`);
            }
            if (attempt >= RETRIES) throw new Error(`${url} -> HTTP ${response.status}`);
        } catch (error) {
            if (attempt >= RETRIES || (error instanceof Error && error.message.includes("-> HTTP 4"))) throw error;
        }

        await sleep(1500 * (attempt + 1));
    }
}

export const getText = async (url: string, init?: RequestInit) => (await request(url, init)).text();
export const getJson = async <T = unknown>(url: string, init?: RequestInit) =>
    (await request(url, init)).json() as Promise<T>;
