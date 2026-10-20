/*
* 武器类型中文名映射（原神），星铁直接使用中文 type
* */
export const weaponTypeMap = {
  sword: "单手剑",
  catalyst: "法器",
  bow: "弓",
  claymore: "双手剑",
  polearm: "长柄武器"
}

/**
 * 获取武器类型中文名
 * @param type - 武器类型（gs 为英文 key，sr 已是中文）
 * @param isSr - 是否星铁
 */
export function weaponTypeName(type, isSr = false) {
  if (isSr) return type
  return weaponTypeMap[(type || "").toLowerCase()] || ""
}
