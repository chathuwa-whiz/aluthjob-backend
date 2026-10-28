import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Only globally routable addresses may be contacted on behalf of untrusted input. */
export function isPublicAddress(address: string): boolean {
    // Interface-scoped IPv6 is not a public destination and is not accepted by WHATWG URLs.
    if (address.includes("%")) return false;
    const family = isIP(address);
    if (family === 4) {
        const bytes = address.split(".").map(Number);
        const value = bytes.reduce((result, byte) => result * 256 + byte, 0);
        const reserved: [number[], number][] = [
            [[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10],
            [[127, 0, 0, 0], 8], [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12],
            [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 168, 0, 0], 16],
            [[192, 88, 99, 0], 24],
            [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24], [[203, 0, 113, 0], 24],
            [[224, 0, 0, 0], 3],
        ];
        return !reserved.some(([prefix, bits]) => {
            const base = prefix.reduce((result, byte) => result * 256 + byte, 0);
            const block = 2 ** (32 - bits);
            return Math.floor(value / block) === Math.floor(base / block);
        });
    }
    if (family !== 6) return false;

    // WHATWG canonicalization turns both dotted and hexadecimal mapped IPv4 into hex groups.
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
    const [left = "", right = ""] = canonical.split("::");
    const before = left ? left.split(":") : [];
    const after = right ? right.split(":") : [];
    const groups = canonical.includes("::")
        ? [...before, ...Array(8 - before.length - after.length).fill("0"), ...after]
        : before;
    const words = groups.map((group) => parseInt(group, 16));
    const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
    const nat64 = words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0);
    if (mapped || nat64) {
        return isPublicAddress(`${words[6]! >> 8}.${words[6]! & 255}.${words[7]! >> 8}.${words[7]! & 255}`);
    }
    // Restrict other IPv6 to global unicast, excluding documentation and transition tunnels.
    return (words[0]! & 0xe000) === 0x2000 &&
        !(words[0] === 0x2001 && (words[1]! < 0x200 || words[1] === 0xdb8)) &&
        words[0] !== 0x2002 && !(words[0] === 0x3fff && words[1]! < 0x1000);
}

/** Validate every DNS answer and return one address to pin for the actual connection. */
export async function resolvePublicAddress(
    host: string,
    resolve: (hostname: string, options: { all: true }) => Promise<{ address: string }[]> = lookup,
): Promise<string> {
    const addresses = isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new Error("The destination must be a public address");
    }
    return addresses[0]!.address;
}
