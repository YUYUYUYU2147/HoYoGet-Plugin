/**
 * 给「面板手动触发」造一个最小可用的事件对象。
 *
 * 签到/体力这类逻辑本来跑在群消息事件里，依赖 e.user_id、e.sender、
 * e.group_id、e.user.getUid() 与 e.runtime。锅巴的「立即执行」按钮没有
 * 真实消息，所以按 cron 的做法合成一份，避免各处再去判空。
 */
import Runtime from '../../../lib/plugins/runtime.js'

/**
 * @param {string|number} qq 触发用户
 * @param {string|number} [groupId] 目标群（有则带上，部分逻辑按群取配置）
 * @param {{name?:string, game?:string}} [opts]
 */
export async function makeTaskEvent(qq, groupId, opts = {}) {
  const userId = String(qq || '')
  const name = String(opts.name || userId)
  const event = {
    user_id: userId,
    msg: '',
    raw_message: '',
    message: [],
    isGroup: !!groupId,
    group_id: groupId ? String(groupId) : undefined,
    sender: { card: name, nickname: name },
    user: { getUid: () => '' },
    game: opts.game,
  }
  try {
    event.runtime = new Runtime(event)
  } catch (_) { /* 个别环境下 Runtime 依赖未就绪，签到本身不强依赖它 */ }
  return event
}

export default { makeTaskEvent }
