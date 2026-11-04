/**
 * 统一版权注释。
 *
 * 所有渲染模板底部的「版权注释」都从这一处取，避免几十个模板各写一份、
 * 样式/文案漂移。模板里写 `{{@copy()}}` 即可（`@` 表示输出原始 HTML）。
 * 合并图（sharp/SVG 拼接）用 COPYRIGHT_TEXT 纯文本。
 */
export const COPYRIGHT_TEXT = 'from 米哈游'

/** 带样式的高亮片段（与历史模板里红色版权一致） */
export const COPYRIGHT_HTML = `<span class="copyright-from" style="color:#ff4d4f;font-weight:600">${COPYRIGHT_TEXT}</span>`

const copy = () => COPYRIGHT_HTML

/**
 * 把 copy() 注册成 art-template 的全局 import。
 * 模板以字符串方式编译（Renderer.dealTpl 直接 template.render(html, data)），
 * 无法用相对 include，所以用全局 import 函数最省事：所有渲染入口都能用。
 */
export function installCopyright(template) {
  if (!template?.defaults) return false
  template.defaults.imports = template.defaults.imports || {}
  template.defaults.imports.copy = copy
  return true
}
