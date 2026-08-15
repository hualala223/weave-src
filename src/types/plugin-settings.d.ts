/**
 * 插件设置类型定义
 * 
 * 为plugin.settings提供完整的类型定义
 * 解决Settings访问时的类型不安全问题
 * 
 * @module types/plugin-settings
 */

// ============================================================================
// 学习设置类型
// ============================================================================

/**
 * FSRS算法配置
 */
export interface FSRSConfig {
  /**
   * 算法参数
   */
  parameters?: number[];
  
  /**
   * 请求保留率
   */
  requestRetention?: number;
  
  /**
   * 最大间隔天数
   */
  maximumInterval?: number;
  
  /**
   * 是否启用个性化优化
   */
  enableOptimization?: boolean;
}

/**
 * 兄弟卡片分散配置（渐进式挖空子卡片调度优化）
 * 
 * 基于认知科学研究和Anki最佳实践：
 * - 避免前摄干扰和倒摄干扰
 * - 为记忆巩固提供足够时间
 * - 提升渐进式挖空学习效果
 */
export interface SiblingDispersionConfig {
  /**
   * 是否启用兄弟分散
   * 默认: true（强烈推荐开启）
   */
  enabled?: boolean;
  
  /**
   * 最小间隔天数
   * 默认: 5天（基于Anki社区标准）
   * 范围: 3-10天
   */
  minSpacing?: number;
  
  /**
   * 基于间隔的动态分散比例
   * 默认: 0.05（5%）
   * 范围: 0.03-0.10
   * 
   * 实际分散间隔 = max(minSpacing, scheduledDays * spacingPercentage)
   */
  spacingPercentage?: number;
  
  /**
   * 队列生成时过滤
   * 默认: true
   * 避免同一会话中出现兄弟卡片
   */
  filterInQueue?: boolean;
  
  /**
   * 复习后自动调整（P2）
   * 默认: true
   * 复习后自动调整冲突的兄弟卡片due日期
   */
  autoAdjustAfterReview?: boolean;
  
  /**
   * 遵守FSRS的fuzz范围（P3）
   * 默认: true
   * 仅在fuzz范围内调整，不破坏最优间隔
   */
  respectFuzzRange?: boolean;
}

/**
 * 学习配置
 */
export interface StudyConfig {
  /**
   * 每日新卡数量
   */
  newCardsPerDay?: number;
  
  /**
   * 每日复习卡数量
   */
  reviewsPerDay?: number;
  
  /**
   * FSRS配置
   */
  fsrs?: FSRSConfig;
  
  /**
   * 兄弟卡片分散配置
   */
  siblingDispersion?: SiblingDispersionConfig;
  
  /**
   * 是否显示答案按钮
   */
  showAnswerButtons?: boolean;
  
  /**
   * 是否启用键盘快捷键
   */
  enableKeyboardShortcuts?: boolean;
}

// ============================================================================
// 界面设置类型
// ============================================================================

/**
 * 主题配置
 */
export interface ThemeConfig {
  /**
   * 主题名称
   */
  name?: 'light' | 'dark' | 'auto';
  
  /**
   * 主色调
   */
  primaryColor?: string;
  
  /**
   * 字体大小
   */
  fontSize?: number;
}

/**
 * 牌组卡片设计样式
 */
export type DeckCardStyle = 'default' | 'chinese-elegant';

/**
 * 界面配置
 */
export interface UIConfig {
  /**
   * 主题配置
   */
  theme?: ThemeConfig;
  
  /**
   * 是否显示侧边栏
   */
  showSidebar?: boolean;
  
  /**
   * 是否启用动画
   */
  enableAnimations?: boolean;
  
  /**
   * 默认视图
   */
  defaultView?: 'cards' | 'decks' | 'stats';
  
  /**
   * 牌组卡片设计样式
   */
  deckCardStyle?: DeckCardStyle;
}

// ============================================================================
// 插件设置主接口
// ============================================================================

/**
 * Weave插件完整设置
 */
export interface WeaveSettings {
  
  /**
   * 学习配置
   */
  studyConfig?: StudyConfig;
  
  /**
   * 界面配置
   */
  uiConfig?: UIConfig;
  
  /**
   * 记忆牌组组织配置
   * 用于正式牌组与涌现式牌组双区模型
   */
  memoryDeckOrganization?: {
    enabled?: boolean;
    minCandidateCardCount?: number;
    tagDriftFollowMode?: 'off' | 'ask' | 'auto';
    activeRuleGroupId?: string;
    ruleGroups?: import('../services/deck/emergent-rule-groups').EmergentRuleGroup[];
  };
  
  /**
   * 默认牌组
   */
  defaultDeck?: string;
  
  /**
   * 数据存储路径
   */
  dataPath?: string;
  
  /**
   * 是否启用调试模式
   */
  enableDebugMode?: boolean;
  
  /**
   * 是否显示高级功能预览
   * 开启后，未激活的高级功能将以锁定状态显示
   */
  showPremiumFeaturesPreview?: boolean;
  
  /**
   * 是否显示性能优化设置
   */
  showPerformanceSettings?: boolean;

  /**
   * 是否启用预览
   */
  enablePreview?: boolean;
  
  /**
   * 是否自动保存
   */
  autoSave?: boolean;
  
  /**
   * 自动保存间隔（毫秒）
   */
  autoSaveInterval?: number;
  
  /**
   * 简化解析配置
   */
  simplifiedParsing?: {
    templates?: unknown[];
    enabled?: boolean;
  };

  clozeSettings?: {
    enabled?: boolean;
    openDelimiter?: string;
    closeDelimiter?: string;
    placeholder?: string;
  };
  
  /**
   * 批量解析配置
   */
  batchParsing?: {
    enabled?: boolean;
    scope?: string[];
  };
  
  /**
   * AnkiConnect配置
   */
  ankiConnect?: {
    enabled?: boolean;
    host?: string;
    port?: number;
  };
  
  weaveParentFolder?: string;

  createCardPreferences?: {
    lastSelectedDeckId?: string;
    lastSelectedDeckNames?: string[];
  };

  /**
   * 超时自动暂停计时（秒）
   * 单张卡片计时超过此值后自动暂停，防止离开时计时虚高
   * @default 60
   */
  timerAutoPauseSeconds?: number;

  /**
   * 提示功能每次学习会话最大使用次数
   * @default 5
   */
  hintMaxUses?: number;

  /**
   * 记忆学习底部“作答方式（显示答案/输入作答）”切换按钮显示设置
   * @default true
   */
  showClozeModeSwitchButton?: boolean;

  /**
   * 全局教程提示持久化状态（true 表示永久不再显示）
   */
  tutorialHints?: import('../services/tutorial/GlobalTutorialHints').GlobalTutorialHintState;
}

/**
 * 自定义格式化动作
 */
export interface CustomFormatAction {
  id: string;
  name: string;
  instruction: string;
  enabled: boolean;
}
