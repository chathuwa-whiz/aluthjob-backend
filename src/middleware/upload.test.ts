import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import multer from "multer";
import { guardResumeUpload, uploadResume } from "./upload.middleware.js";
import { BadRequestError, RuleError, TooManyRequestsError } from "../errors.js";

let base: string;
let server: import("node:http").Server;
before(async () => {
    const app = express();
    app.use((req, _res, next) => { req.user = { id: Number(req.get("x-test-user") ?? 501) } as Express.Request["user"]; next(); });
    app.post("/", guardResumeUpload, uploadResume.single("resume"), (req, res) => res.json({ bytes: req.file?.size ?? 0 }));
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error instanceof TooManyRequestsError ? 429 : error instanceof RuleError ? 409 : error instanceof multer.MulterError || error instanceof BadRequestError ? 400 : 500).json({ message: error.message });
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});
after(() => { server.closeAllConnections(); server.close(); });
const upload = (extra = false) => {
    const form = new FormData();
    form.set("resume", new Blob(["%PDF-1.4 cv"], { type: "application/pdf" }), "cv.pdf");
    if (extra) form.set("unwanted", "large arbitrary text");
    return form;
};

describe("resume request limits", () => {
    it("preserves the existing single CV form", async () => {
        const response = await fetch(base, { method: "POST", body: upload() });
        assert.equal(response.status, 200);
        assert.equal((await response.json() as { bytes: number }).bytes, 11);
    });
    it("rejects text parts instead of accumulating arbitrary form fields", async () => {
        const response = await fetch(base, { method: "POST", headers: { "x-test-user": "502" }, body: upload(true) });
        assert.equal(response.status, 400);
    });
    it("enforces the rate limit before attempting multipart parsing", async () => {
        for (let i = 0; i < 10; i++) {
            const response = await fetch(base, { method: "POST", headers: { "x-test-user": "503" } });
            assert.equal(response.status, 200);
            await response.arrayBuffer();
        }
        const response = await fetch(base, { method: "POST", headers: { "x-test-user": "503", "content-type": "multipart/form-data; boundary=invalid" }, body: "malformed" });
        assert.equal(response.status, 429);
    });
});
