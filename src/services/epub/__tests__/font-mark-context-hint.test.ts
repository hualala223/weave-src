import { describe, expect, it } from "vitest";
import {
	findContextWordRangeInSection,
	findFontMarkContextOccurrence,
	recoverFontMarkRange,
} from "../font-mark-render";

/**
 * 重复词消歧（上下文 hint）的外部行为契约。
 *
 * 测试只断言外部行为：给定（节内文本、标记词、前后文 hint）→ 断言（唯一出现
 * 位置 / Range / null）。消歧命中是本功能的对外约定：同节重复词 + hint 必须
 * 锁定创建时的那一个出现，而不是节内首现。
 */

function buildDoc(html: string): Document {
	return new DOMParser().parseFromString(
		`<!DOCTYPE html><html><body>${html}</body></html>`,
		"text/html",
	);
}

const BASE = {
	sectionIndex: 0,
	allowSectionTextHint: true,
	cfiRange: "epubcfi(/6/4!/4/2)",
};

describe("findFontMarkContextOccurrence（hint 消歧纯函数）", () => {
	const TEXT = "第一个同意，中间的话，第二个同意，结尾的话，第三个同意。";

	it("唯一命中：before+after 锁定第二个出现 → 返回其字符位置", () => {
		const result = findFontMarkContextOccurrence(TEXT, "同意", "中间的话，第二个", "，结尾的话");
		expect(result).toBe(14); // 「第二个同意」的「同意」起点
	});

	it("多命中：hint 匹配多处 → 返回 null（宁可漏染，不可错配）", () => {
		const result = findFontMarkContextOccurrence(TEXT, "同意", "个", undefined);
		expect(result).toBeNull();
	});

	it("无 hint（before/after 均空）→ 返回 null（消歧信息缺失时不猜测）", () => {
		expect(findFontMarkContextOccurrence(TEXT, "同意", "", "")).toBeNull();
		expect(findFontMarkContextOccurrence(TEXT, "同意", undefined, undefined)).toBeNull();
	});

	it("词不在节内文本 → 返回 null", () => {
		expect(findFontMarkContextOccurrence(TEXT, "不同意", "中间", "结尾")).toBeNull();
	});

	it("trim 容差：hint 含换行/多余空白仍命中（跨块边界场景）", () => {
		const result = findFontMarkContextOccurrence(
			"段尾的话。\n第二个同意，下一句",
			"同意",
			"\n  段尾的话。第二个 ",
			" ，",
		);
		expect(result).toBe(9);
	});

	it("只有 before 也能唯一锁定", () => {
		const result = findFontMarkContextOccurrence(TEXT, "同意", "中间的话，第二个", undefined);
		expect(result).toBe(14);
	});

	it("只有 after 也能唯一锁定", () => {
		const result = findFontMarkContextOccurrence(TEXT, "同意", undefined, "，结尾的话");
		expect(result).toBe(14);
	});

	it("hint 在节内根本不存在 → 判失配返回 null（宁可漏染，不可错配）", () => {
		expect(findFontMarkContextOccurrence("同意，开头", "同意", "很长的前文", "，开头")).toBeNull();
	});
});

describe("findContextWordRangeInSection（hint 消歧的 Range 定位）", () => {
	it("重复词 + before/after → 返回覆盖正确出现的 Range", () => {
		const doc = buildDoc("<p>第一个同意在这里</p><p>第二个同意在那里</p><p>第三个同意在别处</p>");
		const range = findContextWordRangeInSection(doc, "同意", "第二个", "在那里");
		expect(range).not.toBeNull();
		expect(range!.toString()).toBe("同意");
		// 锁定的是第二个 <p> 里的出现，而不是文档首个。
		expect(range!.startContainer.parentNode!.textContent).toBe("第二个同意在那里");
	});

	it("hint 匹配多处 → null（跨节点不拼接猜测）", () => {
		const doc = buildDoc("<p>第一个同意在这里</p><p>第二个同意在那里</p><p>第三个同意在别处</p>");
		expect(findContextWordRangeInSection(doc, "同意", "个", undefined)).toBeNull();
	});

	it("跨块上下文（before 落在前一个 <p> 尾部）仍可命中", () => {
		const doc = buildDoc("<p>前一段结尾是这句话。</p><p>第二个同意在后段。</p><p>别的同意。</p>");
		const range = findContextWordRangeInSection(doc, "同意", "结尾是这句话。第二个", "在后段。");
		expect(range).not.toBeNull();
		expect(range!.startContainer.parentNode!.textContent).toBe("第二个同意在后段。");
	});

	it("空词 / 空 doc → null，不抛异常", () => {
		const doc = buildDoc("<p>文本</p>");
		expect(findContextWordRangeInSection(doc, "", "a", "b")).toBeNull();
		expect(findContextWordRangeInSection(null, "同意", "a", "b")).toBeNull();
	});
});

describe("recoverFontMarkRange 接入 hint 消歧（找回链第②级）", () => {
	it("同节重复词 + 锚失败 + hint → 精确找回非首现（不再染到第一个）", () => {
		const doc = buildDoc("<p>第一个同意在这里</p><p>第二个同意在那里</p>");
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "同意",
			contextHint: { before: "第二个", after: "在那里" },
			allowFirstOccurrenceFallback: true,
			resolveRangeInDocument: () => null,
		});
		expect(result).not.toBeNull();
		expect(result!.toString()).toBe("同意");
		expect(result!.startContainer.parentNode!.textContent).toBe("第二个同意在那里");
	});

	it("无 hint 旧标记 + 重复词 + 宽回退 → 维持既有首现兜底（行为不变）", () => {
		const doc = buildDoc("<p>第一个同意在这里</p><p>第二个同意在那里</p>");
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "同意",
			allowFirstOccurrenceFallback: true,
			resolveRangeInDocument: () => null,
		});
		expect(result).not.toBeNull();
		expect(result!.startContainer.parentNode!.textContent).toBe("第一个同意在这里");
	});

	it("hint 失配（正文变化）→ 安静落回既有链（宽回退兜住，不阻断）", () => {
		const doc = buildDoc("<p>第一个同意在这里</p><p>第二个同意在那里</p>");
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "同意",
			contextHint: { before: "根本不存在的前文", after: "不存在的后文" },
			allowFirstOccurrenceFallback: true,
			resolveRangeInDocument: () => null,
		});
		expect(result).not.toBeNull();
		expect(result!.startContainer.parentNode!.textContent).toBe("第一个同意在这里");
	});

	it("异节标记不参与 hint 消歧（同节证明闸不变）", () => {
		const doc = buildDoc("<p>第一个同意在这里</p><p>第二个同意在那里</p>");
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 1,
			text: "同意",
			contextHint: { before: "第二个", after: "在那里" },
			allowFirstOccurrenceFallback: true,
			resolveRangeInDocument: () => null,
		});
		expect(result).toBeNull();
	});

	it("CFI 锚解析成功时 hint 不介入（锚优先级不变）", () => {
		const doc = buildDoc("<p>第一个同意在这里</p><p>第二个同意在那里</p>");
		const walker = doc.createTreeWalker(doc.body!, NodeFilter.SHOW_TEXT);
		let first: Range | null = null;
		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			const index = node.data.indexOf("同意");
			if (index >= 0) {
				first = doc.createRange();
				first.setStart(node, index);
				first.setEnd(node, index + 2);
				break;
			}
		}
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "同意",
			contextHint: { before: "第二个", after: "在那里" },
			resolveRangeInDocument: () => first,
		});
		expect(result).not.toBeNull();
		expect(result!.startContainer.parentNode!.textContent).toBe("第一个同意在这里");
	});

	it("hint 消歧找到的 Range 同样过文本验证闸（词面不符即拒绝）", () => {
		const doc = buildDoc("<p>第一个同意在这里</p><p>第二个同意在那里</p>");
		// 注入的解析器恒 null；消歧词面由实现保证——此处用错误词面验证闸不会放过错配：
		// 词「赞同」在节内不存在 → 整链失败返回 null。
		const result = recoverFontMarkRange({
			...BASE,
			doc,
			markSection: 0,
			text: "赞同",
			contextHint: { before: "第二个", after: "在那里" },
			allowFirstOccurrenceFallback: true,
			resolveRangeInDocument: () => null,
		});
		expect(result).toBeNull();
	});
});
