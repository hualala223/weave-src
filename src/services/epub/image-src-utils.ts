/**
 * 书内图片源字节解析工具（T03 纯函数部分）。
 *
 * 渲染后的章节 DOM 中，书内图片的 `src` 通常是 data: URI（blob 已内联）。
 * data URI 与档案原始字节一一对应（base64 编码，不做重编码/缩放），
 * 解码即可得到「原图字节」；blob: / 相对路径由引擎层另行处理。
 */

import type { ReaderImageBytes } from "./reader-engine-types";

/**
 * 解码 data: URI 为原始字节。
 * 支持 `data:<mime>;base64,<payload>` 与 `data:<mime>,<urlencoded>` 两种形态；
 * urlencoded 形态按 Latin-1 逐字节还原（字节 ≥ 0x80 不被 UTF-8 重编码）。
 * 非法输入返回 null（不抛异常）。
 */
export function decodeDataUriToBytes(uri: string): ReaderImageBytes | null {
	const match = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(
		String(uri || "").trim(),
	);
	if (!match) {
		return null;
	}
	const mimeType = (match[1] || "application/octet-stream")
		.trim()
		.toLowerCase();
	const isBase64 = Boolean(match[2]);
	const payload = match[3] || "";
	try {
		let bytes: Uint8Array;
		if (isBase64) {
			const binaryString = atob(payload);
			bytes = new Uint8Array(binaryString.length);
			for (let i = 0; i < binaryString.length; i += 1) {
				bytes[i] = binaryString.charCodeAt(i);
			}
		} else {
			// 非 base64 形态：手工解析 %XX 十六进制对（按字节还原，不做 UTF-8 解码），
			// 未转义字符按 Latin-1 逐字节取值。
			const raw = payload;
			const buffer = new Uint8Array(raw.length);
			let length = 0;
			for (let i = 0; i < raw.length; i += 1) {
				const char = raw[i];
				if (char === "%" && i + 2 < raw.length) {
					const code = Number.parseInt(raw.slice(i + 1, i + 3), 16);
					if (Number.isFinite(code)) {
						buffer[length] = code;
						length += 1;
						i += 2;
						continue;
					}
				}
				buffer[length] = char.charCodeAt(0) & 0xff;
				length += 1;
			}
			bytes = buffer.slice(0, length);
		}
		return { bytes, mimeType };
	} catch {
		return null;
	}
}