import { readFileSync } from 'node:fs';
import path from 'node:path';
import { render, waitFor } from '@testing-library/svelte';
import EpubFootnotePreviewPopover from './EpubFootnotePreviewPopover.svelte';
import type { ReaderFootnotePreviewInfo } from '../../services/epub';

const info: ReaderFootnotePreviewInfo = {
	href: '#fn1',
	label: '注 1',
	text: '这是一条脚注内容，用于验证移动端弹窗可见性。',
	rect: {
		top: 100,
		left: 50,
		bottom: 120,
		right: 200,
		width: 150,
		height: 20,
	},
};

describe('EpubFootnotePreviewPopover', () => {
	afterEach(() => {
		document.body.innerHTML = '';
	});

	it('渲染脚注信息并显示弹窗', async () => {
		render(EpubFootnotePreviewPopover, { props: { info } });

		await waitFor(() => {
			expect(document.querySelector('.epub-footnote-preview')).toBeInTheDocument();
		});
		expect(document.querySelector('.epub-footnote-preview__label')).toHaveTextContent('注 1');
		expect(document.querySelector('.epub-footnote-preview__text')).toHaveTextContent('这是一条脚注内容');
	});

	it('无 info 时不渲染弹窗', () => {
		const { container } = render(EpubFootnotePreviewPopover, { props: { info: null } });
		expect(container.querySelector('.epub-footnote-preview')).not.toBeInTheDocument();
	});

	it('移动端不再通过 max-width 媒体查询隐藏弹窗（Bug 回归防护）', () => {
		const source = readFileSync(
			path.resolve(__dirname, './EpubFootnotePreviewPopover.svelte'),
			'utf8'
		);
		expect(source).not.toMatch(/@media\s*\(\s*max-width\s*:/);
		expect(source).not.toContain('display: none');
		// 触屏设备：可见且可触摸滚动查看超长注文。
		expect(source).toMatch(/@media\s*\(\s*hover:\s*none\s*\)\s*and\s*\(\s*pointer:\s*coarse\s*\)/);
		expect(source).toMatch(/pointer-events:\s*auto/);
	});
});