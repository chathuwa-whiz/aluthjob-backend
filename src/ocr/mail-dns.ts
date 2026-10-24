import { lookup, Resolver, resolveMx } from "node:dns/promises";

/**
 * Whether a domain exists and can receive mail. This is the check that catches most OCR misreads of
 * an address: a misread domain almost never exists ("madgunasena.com" for "mdgunasena.com").
 */
export type MailDomainCheck = "yes" | "no" | "unknown";

export interface DnsLookup {
    /** Rejects with code ENOTFOUND for a domain that does not exist, ENODATA for one without MX records. */
    resolveMx(domain: string): Promise<{ exchange: string }[]>;
    /** The operating system's resolver (address records only). */
    lookup(domain: string): Promise<unknown>;
}

const codeOf = (error: unknown) => (error as { code?: string }).code ?? "";
const fail = (code: string) => Object.assign(new Error(code), { code });

// ---- real resolvers --------------------------------------------------------------------

/** Node's built-in resolver reads the system's DNS settings and fails outright in some environments. */
const PUBLIC_SERVERS = () => (process.env.DNS_SERVERS ?? "1.1.1.1,8.8.8.8,9.9.9.9").split(",").map((s) => s.trim()).filter(Boolean);

const isDefinite = (code: string) => code === "ENOTFOUND" || code === "ENODATA";

async function mxViaPublicServers(domain: string) {
    const resolver = new Resolver({ timeout: 4000, tries: 1 });
    resolver.setServers(PUBLIC_SERVERS());
    return resolver.resolveMx(domain);
}

/** DNS-over-HTTPS: works wherever HTTPS does, even when UDP port 53 is blocked. */
async function mxViaHttps(domain: string): Promise<{ exchange: string }[]> {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`;
    const response = await fetch(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw fail("ESERVFAIL");

    const answer = (await response.json()) as { Status: number; Answer?: { type: number; data: string }[] };
    if (answer.Status === 3) throw fail("ENOTFOUND"); // NXDOMAIN
    if (answer.Status !== 0) throw fail("ESERVFAIL");

    return (answer.Answer ?? []).filter((record) => record.type === 15).map((record) => ({ exchange: record.data }));
}

const defaultDns: DnsLookup = {
    async resolveMx(domain) {
        let lastError: unknown;

        for (const attempt of [resolveMx, mxViaPublicServers, mxViaHttps]) {
            try {
                return await attempt(domain);
            } catch (error) {
                // "does not exist" and "has no MX" are answers; anything else means this resolver is broken, try the next
                if (isDefinite(codeOf(error))) throw error;
                lastError = error;
            }
        }

        throw lastError;
    },
    lookup: (domain) => lookup(domain, { all: true }),
};

// ---- the check -------------------------------------------------------------------------

const cache = new Map<string, MailDomainCheck>();

export async function domainAcceptsMail(domain: string, dns: DnsLookup = defaultDns): Promise<MailDomainCheck> {
    const key = domain.toLowerCase();
    const cached = cache.get(key);
    if (cached) return cached;

    let mx: "found" | "none" | "nxdomain" | "failed";
    try {
        mx = (await dns.resolveMx(key)).length > 0 ? "found" : "none";
    } catch (error) {
        const code = codeOf(error);
        mx = code === "ENOTFOUND" ? "nxdomain" : code === "ENODATA" ? "none" : "failed";
    }

    let verdict: MailDomainCheck;
    if (mx === "found") verdict = "yes";
    else if (mx === "nxdomain") verdict = "no";
    else {
        // No MX record: mail goes to the domain's own address record, so that has to exist.
        // If even the MX lookup could not be done, a missing address record proves nothing.
        verdict = await dns.lookup(key).then(
            () => "yes" as const,
            (error: unknown) => (mx === "none" && isDefinite(codeOf(error)) ? ("no" as const) : ("unknown" as const)),
        );
    }

    // only definite answers are remembered; an outage must not stick
    if (verdict !== "unknown") cache.set(key, verdict);
    return verdict;
}
