/**
 * 内置路由处理器：设置页、连通性自检与模型清单。
 *
 * 不负责分发与监听；请求体已由上层解析并限长。
 * 必须始终成立：设置页只回本机数据，绝不回显凭据。
 * @module dsh-pet/src/standalone/server/handlers
 */
import { publicSettings, validateSettings, type StandaloneSettingsService } from '../settings.ts';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { rejectRequest } from '../request-security.ts';
import type { ModelDiscoveryInput } from '../ai-provider/types.ts';
import { toBalanceState } from '../../shared/balance/parse.ts';
import { kindPreviews, type BubbleKindPreviews } from '../../shared/balance/preview.ts';
import { bubbleTemplateContext } from '../../shared/balance/template.ts';
import { sendJson } from './respond.ts';

/** 读完请求体并解析成 JSON；空体当作空对象。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.once('end', resolve);
    req.once('error', reject);
  });
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** 只接受对象形态的草稿；数组、标量与 null 一律当未填。 */
function asDraft(body: unknown): ModelDiscoveryInput {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as ModelDiscoveryInput) : {};
}

/**
 * 创建设置读写处理器（GET 读，POST 存）。
 * @param ai - 设置服务。
 * @returns 处理请求的异步函数。
 */
export function settingsHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  let windowStart = Date.now();
  let count = 0;
  return async (req, res) => {
    if (!ai) {
      rejectRequest(res, 503, '本机 AI 设置尚未就绪');
      return;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, publicSettings(ai.getSettings()));
      return;
    }
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 GET 或 POST');
      return;
    }
    if (Date.now() - windowStart >= 60000) {
      windowStart = Date.now();
      count = 0;
    }
    count += 1;
    // 保存是重操作，按一分钟窗口限流，避免设置页反复重试打爆磁盘。
    if (count > 20) {
      rejectRequest(res, 429, '保存过于频繁，请稍后再试');
      return;
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      rejectRequest(res, 415, '请使用 JSON 保存设置');
      return;
    }
    try {
      const input = validateSettings(await readJsonBody(req));
      sendJson(res, 200, publicSettings(await ai.saveSettings(input)));
    } catch {
      rejectRequest(res, 400, '设置未保存：请检查接口地址、模型名称、密钥和数值范围');
    }
  };
}

/**
 * 创建连通性测试处理器（POST）。
 * @param ai - 设置服务。
 * @returns 处理请求的异步函数。
 */
export function testHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 POST');
      return;
    }
    try {
      const input = asDraft(await readJsonBody(req));
      if (ai?.testConnection) sendJson(res, 200, await ai.testConnection(input));
      else sendJson(res, 200, { ok: false, message: '当前环境未配置测试能力' });
    } catch {
      sendJson(res, 400, { ok: false, message: '请求格式无效' });
    }
  };
}

/**
 * 创建「单家服务商密钥测试」处理器（POST）：给设置页多服务商列表的「测试」按钮用。
 *
 * 与 /test 的区别：/test 验的是当前表单要保存的那套（协议+地址+模型+密钥）；
 * 这里只验某一家已存的（或正在输入的）密钥能不能真的换来余额。
 * @param ai - 设置服务。
 * @returns 处理请求的异步函数。
 */
export function testKeyHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 POST');
      return;
    }
    try {
      const body = (await readJsonBody(req)) as Record<string, unknown>;
      const service = typeof body.service === 'string' ? body.service : '';
      if (service === '') {
        sendJson(res, 200, { ok: false, message: '请求里缺少服务商 id' });
        return;
      }
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey : undefined;
      if (ai?.testProviderKey) {
        const result = await ai.testProviderKey({ service, apiKey });
        sendJson(res, 200, { ok: result.ok === true, message: String(result.message ?? '') });
        return;
      }
      sendJson(res, 200, { ok: false, message: '当前环境未配置单服务商测试能力' });
    } catch {
      sendJson(res, 400, { ok: false, message: '请求格式无效' });
    }
  };
}

/**
 * 创建模型清单处理器（POST）。
 * @param ai - 设置服务。
 * @returns 处理请求的异步函数。
 */
export function modelsHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 POST');
      return;
    }
    if (!ai?.discoverModels) {
      sendJson(res, 200, { ok: false, code: 'input', message: '当前环境未配置模型清单能力' });
      return;
    }
    try {
      sendJson(res, 200, await ai.discoverModels(asDraft(await readJsonBody(req))));
    } catch {
      sendJson(res, 400, { ok: false, code: 'input', message: '请求格式无效' });
    }
  };
}

/**
 * 创建余额查询处理器（POST）。
 *
 * 服务商与密钥都取自已保存的设置，请求体不参与：避免调用方把密钥经查询接口再传一遍。
 * @param ai - 设置服务。
 * @returns 处理请求的异步函数。
 */
export function balanceHandler(
  ai: StandaloneSettingsService | undefined,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      rejectRequest(res, 405, '仅支持 POST');
      return;
    }
    if (!ai?.queryBalance) {
      sendJson(res, 200, { ok: false, provider: '', reason: 'unsupported' });
      return;
    }
    try {
      const raw = await ai.queryBalance();
      // 顺带把「各预置页会长什么样」算出来：设置页预览用它，才能和桌宠上的一模一样。
      // 预览失败绝不影响余额查询本身，所以单独兜住。
      let previews: BubbleKindPreviews | undefined;
      let context: Record<string, string> | undefined;
      try {
        const state = toBalanceState(raw);
        if (state) {
          previews = kindPreviews(state);
          // 自定义模板的预览也要用真数据填，否则「¥103.22」这种样本值会一直挂在设置页上。
          context = bubbleTemplateContext(state, null);
        }
      } catch {
        previews = undefined;
        context = undefined;
      }
      const extra: Record<string, unknown> = {};
      if (previews !== undefined) extra.previews = previews;
      if (context !== undefined) extra.context = context;
      sendJson(res, 200, { ...(raw as object), ...extra });
    } catch {
      sendJson(res, 200, { ok: false, provider: '', reason: 'fetch-error', message: '余额查询失败' });
    }
  };
}
