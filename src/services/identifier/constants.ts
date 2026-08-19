/**
 * Weave 标识符系统常量定义
 *
 * 定义UUID、BlockID等标识符的格式规范
 *
 * @module services/identifier
 */

// ============================================================================
// UUID 常量
// ============================================================================

/**
 * UUID前缀
 * 用于命名空间隔离，避免与其他系统ID冲突
 */
export const UUID_PREFIX = "tk-";

/**
 * UUID字符集（Base32，去除易混淆字符）
 * 排除了：0、O、1、l、I 等易混淆字符
 */
export const UUID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/**
 * UUID长度配置
 */
export const UUID_LENGTH = {
	/** 时间戳部分长度（Base32编码） */
	TIMESTAMP: 7,
	/** 随机数部分长度（Base32编码） */
	RANDOM: 5,
	/** 总长度（不含前缀） */
	TOTAL: 12,
	/** 完整长度（含前缀 tk-） */
	FULL: 15,
} as const;

/**
 * UUID格式验证正则表达式
 */
export const UUID_REGEX = /^tk-[23456789abcdefghjkmnpqrstuvwxyz]{12}$/;

/**
 * UUID Base进制
 *  修正为31（对应alphabet的实际长度）
 */
export const UUID_BASE = 31;

// ============================================================================
// BlockID 常量
// ============================================================================

/**
 * BlockID字符集（Base36，符合Obsidian原生风格）
 */
export const BLOCK_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * BlockID随机部分长度
 */
export const BLOCK_ID_LENGTH = 6;

/**
 * BlockID格式验证正则表达式
 * 格式：we-{6位base36随机字符}
 */
export const BLOCK_ID_REGEX = /^we-[0-9a-z]{6}$/;

// ============================================================================
// ID生成配置
// ============================================================================

/**
 * 唯一性保证配置
 */
export const UNIQUENESS_CONFIG = {
	/** 最大重试次数（冲突时） */
	MAX_RETRY: 10,

	/** 预期冲突概率阈值 */
	COLLISION_THRESHOLD: 0.0001, // 0.01%

	/** 同一毫秒内最大生成数 */
	MAX_PER_MILLISECOND: 100,
} as const;

// ============================================================================
// 错误消息
// ============================================================================

/**
 * ID相关错误消息
 */
export const ERROR_MESSAGES = {
	INVALID_UUID_FORMAT: "UUID格式无效",
	INVALID_BLOCK_ID_FORMAT: "BlockID格式无效",
	UUID_COLLISION: "UUID冲突，已达到最大重试次数",
	BLOCK_ID_COLLISION: "BlockID冲突",
	TIMESTAMP_OUT_OF_RANGE: "时间戳超出有效范围",
	INVALID_ALPHABET: "包含无效字符",
	GENERATION_FAILED: "ID生成失败",
} as const;
