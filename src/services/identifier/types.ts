/**
 * Weave 标识符验证结果类型
 *
 * @module services/identifier
 */

// ============================================================================
// 标识符验证结果
// ============================================================================

/**
 * UUID验证结果
 */
export interface UUIDValidationResult {
	/** 是否有效 */
	isValid: boolean;

	/** 错误消息（如果无效） */
	error?: string;

	/** 格式正确性 */
	formatValid: boolean;

	/** 字符集正确性 */
	alphabetValid: boolean;

	/** 时间戳有效性（如果可提取） */
	timestampValid?: boolean;

	/** 提取的时间戳（如果可提取） */
	timestamp?: number;
}

/**
 * BlockID验证结果
 */
export interface BlockIDValidationResult {
	/** 是否有效 */
	isValid: boolean;

	/** 错误消息（如果无效） */
	error?: string;

	/** 格式正确性 */
	formatValid: boolean;

	/** 字符集正确性 */
	alphabetValid: boolean;
}
