/**
 * DSH 会话事件帧 → 待转述的通知：纯函数。
 *
 * 帧由宿主半侧监听 DSH 事件生成（见 ../notify-events.ts），经 DSH 桥镜像进本机状态仓的
 * `sections.notify`；这里把帧翻译成「她要说的一句」。
 *
 * 不 import src/shared（DSH 单文件加载约束），所以映射规则与 shared/notify.ts 的 frameToToast
 * 各写一份：那边把帧变成系统弹窗的标题与正文，这边把帧变成她嘴里的一句话。
 * 两者认的是同一批帧类型，认不出来的一律返回 null（她不念，也不报错）。
 * @module dsh-pet/src/host/system-notify/dsh-events
 */
import { DSH_APP_ID, type SystemNotification } from './notify-text.ts';

/** turn/end 事件在帧里的形状（宽松读取）。 */
interface TurnEndEvent {
  type?: string;
  data?: {
    reason?: { kind?: string; error?: { message?: string } };
    text?: string;
  };
}

/** 帧 → 一条待转述的通知；不认识的帧返回 null。 */
export function dshFrameToNotification(frame: unknown): SystemNotification | null {
  if (!frame || typeof frame !== 'object') return null;
  const f = frame as {
    type?: string;
    event?: TurnEndEvent;
    toolName?: string;
    reason?: string;
    questions?: Array<{ question?: string }>;
    message?: string;
  };
  if (f.type === 'session/event') {
    const ev = f.event;
    if (ev?.type !== 'turn/end') return null;
    const kind = ev.data?.reason?.kind;
    if (kind === 'completed') {
      const text = typeof ev.data?.text === 'string' ? ev.data.text.trim() : '';
      return { appId: DSH_APP_ID, title: '对话完成', body: text };
    }
    if (kind === 'error') {
      return { appId: DSH_APP_ID, title: '生成失败', body: ev.data?.reason?.error?.message ?? '' };
    }
    if (kind === 'max-tokens') {
      return { appId: DSH_APP_ID, title: '输出被截断', body: '已达到输出 token 上限' };
    }
    // aborted（用户取消）、interrupted（崩溃恢复）等：不念
    return null;
  }
  if (f.type === 'approval/requested') {
    const tool = typeof f.toolName === 'string' ? f.toolName : '';
    const reason = typeof f.reason === 'string' ? f.reason : '';
    return {
      appId: DSH_APP_ID,
      title: '正在申请权限',
      body: (tool !== '' ? `工具「${tool}」` : '') + (reason !== '' ? `：${reason}` : ''),
    };
  }
  if (f.type === 'question/requested') {
    const question = f.questions?.[0]?.question ?? '';
    return { appId: DSH_APP_ID, title: '模型在等你回答', body: question };
  }
  if (f.type === 'host/agent-error') {
    return { appId: DSH_APP_ID, title: '生成失败', body: typeof f.message === 'string' ? f.message : '' };
  }
  return null;
}
