# Spec: 摘录面板排序方向——最新摘录可选置顶/置底

Status: Finalized locally — 一轮 grilling 定稿（用户确认 Q1/Q2/Q4/Q5 采推荐项；Q3 粘贴恒为最早在最上）。实现已完成并构建部署。

## Problem Statement

摘录面板列表目前写死为最新摘录在最上（快照按 createdTime 降序）。读者希望可选「最新在最下」，例如按阅读先后从上往下浏览（第一印象的摘录在顶部，新划的不断追加到底部）。

## Solution

摘录工具设置菜单新增全局开关「最新摘录在最上」（默认开 = 现状）。关闭后摘录面板列表改为 createdTime 升序（最新在最下）。

## Decisions（grilling 定稿）

- **作用范围**：全局（所有书一致），存入既有 `uiMemory.excerptSettings`（无插件设置页，无设备区分，与现有摘录设置一致）。
- **入口**：`EpubView` 摘录工具「摘录笔记设置」菜单，与 `想法自动入笔记`、`摘录时间戳` 同级，布尔勾选项。
- **形态**：单一布尔 `newestExcerptOnTop`，默认 `true`（兼容现状）；不做排序字段+方向泛化。
- **生效范围**：仅摘录面板列表显示。排序在 NotesPanel 显示层做（`sortExcerptsForDisplay` 纯函数），快照服务与全局侧栏保持最新在上不动，避免 contextKey/缓存失效问题。
- **粘贴不受影响**：粘贴到笔记（单条/所选/全部）恒为 createdTime 升序、最早在最上，与面板显示顺序解耦（现状保持）。

## Implementation

- `epub-excerpt-settings.ts`：新增 `newestExcerptOnTop: boolean`（默认 true）+ 归一化（`epub-local-data-normalize.ts`，非布尔回退默认）；`schema-v2.ts` `uiMemory.excerptSettings` 增加可选字段（向后兼容，无迁移）。
- `excerpt-display-order.ts`（新纯函数缝）：`sortExcerptsForDisplay(items, newestOnTop)`，返回新数组，缺失时间视为 0。
- `NotesPanel.svelte`：新 prop `newestExcerptOnTop`（默认 true），在 `annotationListView` 过滤后排序。
- `EpubGlobalSidebar.svelte`：透传 `sharedState.excerptSettings?.newestExcerptOnTop !== false`。
- `EpubView.ts`：菜单勾选项「最新摘录在最上」（icon `arrow-up-narrow-wide`）。

## Testing

- 新增 `excerpt-display-order.test.ts`：降序/升序、缺失时间归 0、不改输入数组。纯函数缝只测行为，不测菜单/接线胶水。

## Out of Scope

- 按章节位置/书籍位置等多字段排序；面板内手动拖拽排序；每书或每设备记忆；全局侧栏列表跟随该设置。
