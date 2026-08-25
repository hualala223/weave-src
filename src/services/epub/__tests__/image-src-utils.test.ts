import { describe, expect, it } from "vitest";
import { decodeDataUriToBytes } from "../image-src-utils";

describe("decodeDataUriToBytes", () => {
	it("解码 base64 data URI，MIME 取自前缀", () => {
		const payload = "iVBORw0KGgoAAAANSUhEUg==";
		const result = decodeDataUriToBytes(`data:image/png;base64,${payload}`);
		expect(result).not.toBeNull();
		expect(result!.mimeType).toBe("image/png");
		const expected = Uint8Array.from(Buffer.from(payload, "base64"));
		expect(result!.bytes).toEqual(expected);
	});

	it("解码非 base64（URL 编码）的 data URI", () => {
		const result = decodeDataUriToBytes(
			"data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E",
		);
		expect(result).not.toBeNull();
		expect(result!.mimeType).toBe("image/svg+xml");
		expect(new TextDecoder().decode(result!.bytes)).toBe("<svg></svg>");
	});

	it("URL 编码的二进制字节（≥0x80）按 Latin-1 逐字节还原，不被 UTF-8 重编码", () => {
		const result = decodeDataUriToBytes("data:image/png,%FF%00%80%FE");
		expect(result).not.toBeNull();
		expect(result!.bytes).toEqual(
			Uint8Array.from([0xff, 0x00, 0x80, 0xfe]),
		);
	});

	it("非法输入返回 null（不抛异常）", () => {
		expect(decodeDataUriToBytes("")).toBeNull();
		expect(decodeDataUriToBytes("https://example.com/a.png")).toBeNull();
		expect(decodeDataUriToBytes("data:image/png;base64,!!!")).toBeNull();
	});
});
