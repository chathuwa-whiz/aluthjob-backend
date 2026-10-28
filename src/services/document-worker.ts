import { parseDocument } from "./document-content.js";

process.once("message", (input: { buffer: Buffer; mimeType: string }) => {
    parseDocument(input.buffer, input.mimeType).then(
        (result) => process.send?.({ result }, () => process.exit(0)),
        () => process.send?.({ error: true }, () => process.exit(0)),
    );
});
