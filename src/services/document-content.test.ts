import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crc32 } from "node:zlib";
import { validateWordArchive } from "./document-content.js";
import { extractResumeContent } from "./text-extraction.service.js";

function zip(files: Record<string, string>): Buffer {
    const chunks: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, value] of Object.entries(files)) {
        const filename = Buffer.from(name); const data = Buffer.from(value);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
        header.writeUInt32LE(crc32(data), 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
        entry.writeUInt32LE(crc32(data), 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
        chunks.push(header, filename, data); central.push(entry, filename);
        offset += header.length + filename.length + data.length;
    }
    const directory = Buffer.concat(central); const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...chunks, directory, end]);
}
const docx = () => zip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "word/document.xml": '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Ama Perera React Developer</w:t></w:r></w:p></w:body></w:document>',
});
const file = (buffer: Buffer, mimetype: string) => ({ buffer, mimetype }) as Express.Multer.File;

describe("document parser isolation", () => {
    it("rejects misleading oversized archive metadata before inflation", () => {
        const archive = docx();
        const start = archive.readUInt32LE(archive.length - 6);
        archive.writeUInt32LE(100 * 1024 * 1024, start + 24);
        assert.throws(() => validateWordArchive(archive), /too large/);
        assert.throws(() => validateWordArchive(Buffer.from("not a zip")), /valid Word/);
    });
    it("reads a valid Word CV through the isolated process", async () => {
        const result = await extractResumeContent(file(docx(), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"));
        assert.match(result.text, /Ama Perera React Developer/);
        assert.deepEqual(result.links, []);
    });
    it("rejects fake document MIME types and releases parser slots", async () => {
        await assert.rejects(extractResumeContent(file(Buffer.from("not a pdf"), "application/pdf")), /could not be read/);
        assert.match((await extractResumeContent(file(docx(), "application/msword"))).text, /Ama Perera/);
    });
});
