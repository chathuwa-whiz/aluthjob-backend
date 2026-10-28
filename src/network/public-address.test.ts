import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isPublicAddress, resolvePublicAddress } from "./public-address.js";
import { createTransport } from "../mail/smtp.js";

describe("public destination addresses", () => {
    it("rejects IPv4 internal, metadata, multicast and reserved ranges", () => {
        for (const address of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255"]) {
            assert.equal(isPublicAddress(address), false, address);
        }
    });
    it("rejects mapped IPv4 in every spelling, including the original SMTP bypass", () => {
        for (const address of ["::ffff:127.0.0.1", "::ffff:7f00:1", "0:0:0:0:0:ffff:a00:1", "::ffff:c0a8:101", "::ffff:a9fe:a9fe"]) {
            assert.equal(isPublicAddress(address), false, address);
        }
    });
    it("rejects local IPv6, transition tunnels and documentation ranges", () => {
        for (const address of ["::", "::1", "::127.0.0.1", "fc00::1", "fd12::1", "fe80::1", "fe80::1%eth0", "2606:4700:4700::1111%3", "febf::1", "ff02::1", "64:ff9b::7f00:1", "2001::1", "2001:20::1", "2001:db8::1", "2002:7f00:1::", "3fff::1", "not-an-ip"]) {
            assert.equal(isPublicAddress(address), false, address);
        }
    });
    it("preserves public IPv4, IPv6 and mapped public mail servers", () => {
        for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:808:808", "64:ff9b::7c2b:b1f7"]) {
            assert.equal(isPublicAddress(address), true, address);
        }
    });
    it("resolves literal public destinations and refuses literal private destinations", async () => {
        assert.equal(await resolvePublicAddress("8.8.8.8"), "8.8.8.8");
        await assert.rejects(resolvePublicAddress("::ffff:7f00:1"), /public address/);
    });
    it("rejects mixed public/private DNS answers and pins one validated public answer", async () => {
        await assert.rejects(resolvePublicAddress("example.com", async () => [{ address: "8.8.8.8" }, { address: "127.0.0.1" }]), /public address/);
        let calls = 0;
        assert.equal(await resolvePublicAddress("example.com", async () => {
            calls++;
            return [{ address: "8.8.8.8" }, { address: "1.1.1.1" }];
        }), "8.8.8.8");
        assert.equal(calls, 1);
    });
    it("SMTP rejects mapped internal addresses before a socket is created, even with a production local override", async () => {
        const previousMode = process.env.NODE_ENV;
        const previousLocal = process.env.MAIL_ALLOW_LOCAL;
        try {
            process.env.NODE_ENV = "production";
            process.env.MAIL_ALLOW_LOCAL = "true";
            for (const host of ["::ffff:7f00:1", "::ffff:a00:1", "127.0.0.1"]) {
                await assert.rejects(createTransport({ host, port: 587, secure: false, username: "test", password: "test" }), /public address/);
            }
        } finally {
            if (previousMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousMode;
            if (previousLocal === undefined) delete process.env.MAIL_ALLOW_LOCAL; else process.env.MAIL_ALLOW_LOCAL = previousLocal;
        }
    });
});
