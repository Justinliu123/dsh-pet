import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { validateSettings, publicSettings } from './settings.ts';
import { settingsPage, settingsScript, settingsStyle } from './settings-page.ts';

/** 记录到的一条请求。 */
type RecordedRequest = {
  url: string;
  options: { method: string; body?: string; headers: Record<string, string> };
};

/** getElementById 的替身：只实现页面脚本用到的那几个属性。 */
type FakeElement = {
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  dataset: Record<string, string>;
  children: unknown[];
  listeners: Record<string, (event?: unknown) => Promise<void> | void>;
  addEventListener: (name: string, fn: (event?: unknown) => Promise<void> | void) => void;
  append: (...kids: unknown[]) => void;
  setAttribute: () => void;
  reportValidity: () => boolean;
  getBoundingClientRect: () => {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
};

/** createElement 的替身：能追加、能设属性、能点、能被读值。 */
type FakeNode = {
  nodeType: number;
  isConnected: boolean;
  hidden: boolean;
  value: string;
  checked: boolean;
  disabled: boolean;
  textContent: string;
  className: string;
  style: Record<string, string>;
  dataset: Record<string, string>;
  children: FakeNode[];
  listeners: Record<string, () => void>;
  classList: { toggle(): void };
  append(...kids: unknown[]): void;
  setAttribute(): void;
  addEventListener(name: string, fn: () => void): void;
  removeEventListener(): void;
  remove(): void;
  focus(): void;
  scrollIntoView(): void;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
  readonly firstElementChild: FakeNode | null;
};

/** 一次页面启动后的句柄：各 test 自己起一份，互不共享状态。 */
interface Page {
  /** 按 id 取到启动时被脚本访问过的元素。 */
  element(id: string): FakeElement;
  /** 脚本发出的全部请求，按发出顺序。 */
  requests: RecordedRequest[];
  /** createElement 造出来的节点都会挂到 body 上（菜单、弹窗）。 */
  body: FakeNode;
  /** 地址片段是否已被清掉，清成什么。 */
  stripped(): string;
  /** 打到 AI 设置端点的请求。 */
  aiRequests(): RecordedRequest[];
  /** 最后一次 AI 设置请求的请求体。 */
  lastAiBody(): Record<string, unknown>;
  /** 最近一次确认框的两个按钮；没弹过就是空数组。 */
  lastDialogActions(): FakeNode[];
}

/**
 * 起一份页面：假 DOM + 真脚本。
 *
 * 每个 test 都新建，避免用例之间互相污染——脚本在启动时会发请求、改元素状态。
 */
async function setupPage(): Promise<Page> {
  const elements = new Map<string, FakeElement>();
  const element = (id: string): FakeElement => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        checked: false,
        disabled: false,
        hidden: false,
        textContent: '',
        dataset: {},
        children: [],
        listeners: {},
        addEventListener(name, fn) {
          this.listeners[name] = fn;
        },
        append(...kids) {
          this.children.push(...kids);
        },
        setAttribute() {},
        reportValidity: () => true,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 36, width: 200, height: 36 }),
      });
    return elements.get(id)!;
  };
  const node = (): FakeNode => {
    const el: Record<string, unknown> = {
      nodeType: 1,
      isConnected: true,
      hidden: false,
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      className: '',
      style: {} as Record<string, string>,
      dataset: {} as Record<string, string>,
      children: [] as unknown[],
      listeners: {} as Record<string, () => void>,
      classList: { toggle() {} },
      append(...kids: unknown[]) {
        (el.children as unknown[]).push(...kids);
      },
      setAttribute() {},
      addEventListener(name: string, fn: () => void) {
        (el.listeners as Record<string, () => void>)[name] = fn;
      },
      removeEventListener() {},
      remove() {
        el.isConnected = false;
      },
      focus() {},
      scrollIntoView() {},
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 36, width: 200, height: 36 }),
      get firstElementChild() {
        return (el.children as Array<{ nodeType?: number }>).find((kid) => kid && kid.nodeType === 1) ?? null;
      },
    };
    return el as unknown as FakeNode;
  };

  const body = node();
  const requests: RecordedRequest[] = [];
  let stripped = '';
  runInNewContext(settingsScript, {
    URLSearchParams,
    setTimeout,
    clearTimeout,
    console,
    window: { addEventListener() {}, removeEventListener() {}, innerHeight: 800, confirm: () => false },
    document: {
      getElementById: element,
      createElement: node,
      createElementNS: node,
      createTextNode: (text: string) => ({ nodeType: 3, textContent: text }),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
      body,
    },
    location: { hash: '#token=process-capability', pathname: '/standalone-ai/' },
    history: {
      replaceState: (_a: unknown, _b: unknown, path: string) => {
        stripped = path;
      },
    },
    fetch: async (url: string, options: RecordedRequest['options']) => {
      requests.push({ url, options });
      if (url === '/standalone-ai/models') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            models: [
              { id: 'm-one', name: 'M One' },
              { id: 'm-two', name: 'm-two' },
            ],
          }),
        };
      }
      if (url === '/standalone-ai/balance') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            provider: 'deepseek-official',
            shape: 'money',
            data: { wallets: [{ currency: 'CNY', total: '12.34', granted: '0.00', toppedUp: '12.34' }] },
          }),
        };
      }
      const clearing =
        url === '/standalone-ai/settings' && options.body ? JSON.parse(options.body).clearKey === true : false;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          service: 'deepseek-official',
          protocol: 'anthropic',
          baseUrl: 'https://example.test',
          model: 'x',
          profiles: {
            custom: { protocol: 'openai-compatible', baseUrl: 'https://mine.test', model: 'my-model' },
            'deepseek-official': { protocol: 'anthropic', baseUrl: 'https://example.test', model: 'x' },
            'opencode-go': { protocol: 'openai-compatible', baseUrl: 'https://opencode.test/v1', model: 'go-model' },
            commandcode: { protocol: 'openai-compatible', baseUrl: 'https://cc.test/v1', model: '' },
          },
          services: [
            { id: 'custom', label: '自定义', keyName: 'CUSTOM_API_KEY', protocol: 'openai-compatible' },
            {
              id: 'deepseek-official',
              label: 'DeepSeek 官方',
              keyName: 'DEEPSEEK_API_KEY',
              protocol: 'openai-compatible',
            },
            { id: 'opencode-go', label: 'opencode Go', keyName: 'OPENCODE_GO_API_KEY', protocol: 'openai-compatible' },
            { id: 'commandcode', label: 'commandcode', keyName: 'COMMANDCODE_API_KEY', protocol: 'openai-compatible' },
          ],
          savedKeys: clearing ? [] : ['DEEPSEEK_API_KEY'],
          hasKey: !clearing,
          automaticWhispers: false,
          whisperIntervalSec: 300,
          maxTokens: 1024,
        }),
      };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const aiRequests = () => requests.filter(({ url }) => url === '/standalone-ai/settings');
  return {
    element,
    requests,
    body,
    stripped: () => stripped,
    aiRequests,
    lastAiBody: () => {
      const list = aiRequests();
      return JSON.parse(list[list.length - 1].options.body ?? '{}');
    },
    lastDialogActions: () => {
      const masks = body.children.filter((kid) => kid.className === 'dialogMask');
      const panel = masks[masks.length - 1]?.children[0];
      return panel ? panel.children[2].children : [];
    },
  };
}

/** 等两轮事件循环，让脚本里的 await 链落定。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('气泡页编辑：改一行只刷新预览、不整面板重建（否则输入一个字符丢焦点）', () => {
  const script = Array.isArray(settingsScript) ? settingsScript.join('') : String(settingsScript);
  assert.match(script, /function refreshBubbleStepPreview/);
  const body = script.match(/function setBubbleStepRow[\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(body.length > 0, '应生成 setBubbleStepRow');
  assert.match(body, /refreshBubbleStepPreview\(/);
  assert.doesNotMatch(body, /renderBubblePanel/);
});

test('气泡页编辑：每一页都能编辑，自定义页可以建多份', () => {
  const script = Array.isArray(settingsScript) ? settingsScript.join('') : String(settingsScript);
  // 每一步都有「编辑」按钮：预置页与自定义页一视同仁。
  assert.match(script, /function toggleBubbleStepEdit/);
  assert.match(script, /function bubbleStepEditor/);
  assert.match(script, /function bubbleStepPreview/);
  assert.match(script, /function setBubbleStepRow/);
  // 多份自定义页：新建时生成不重复的 id，各自带自己的模板。
  assert.match(script, /function addCustomBubblePage/);
  assert.match(script, /＋ 新建自定义页/);
  assert.match(script, /id: 'c' \+ n/);
  assert.match(script, /BUBBLE_CUSTOM_DEFAULT_ROWS/);
  // 预置页第一次编辑会预填占位符种子，用户看得见这一页能写什么。
  assert.match(script, /BUBBLE_STEP_SEEDS/);
  assert.match(script, /恢复这一页的默认内容/);
});

test('气泡自定义页：页面上有占位符说明与可点击插入的 chip', () => {
  const script = Array.isArray(settingsScript) ? settingsScript.join('') : String(settingsScript);
  assert.match(script, /function bubblePlaceholderHint/);
  assert.match(script, /可用占位符/);
  assert.match(script, /function appendPlaceholderToFocusedRow/);
  assert.match(script, /bubbleChip/);
});

test('气泡预览：模板用真实余额填、预置页默认内容要手动「从默认内容开始改」', () => {
  const script = Array.isArray(settingsScript) ? settingsScript.join('') : String(settingsScript);
  assert.match(script, /BUBBLE_LIVE_CONTEXT/);
  assert.match(script, /function bubblePreviewContext/);
  assert.match(script, /function seedBubbleStepContent/);
  assert.match(script, /从默认内容开始改/);
  // 打开预置页的编辑器时不再自动灌种子，只有自定义页才自动带默认行
  assert.match(script, /if \(step\.kind === 'custom' && \(!Array\.isArray\(step\.template\)/);
});

test('气泡预览：预设页的行直接用真实余额算出来，不再拿种子模板糊样本', () => {
  const script = Array.isArray(settingsScript) ? settingsScript.join('') : String(settingsScript);
  assert.match(script, /function loadBubbleLivePreviews/);
  assert.match(script, /function setBubbleLivePreviews/);
  assert.match(script, /BUBBLE_LIVE_PREVIEWS/);
  assert.match(script, /function bubbleStepPreviewRows/);
  assert.match(script, /BUBBLE_LIVE_PREVIEWS\[step\.kind\]/);
  // 面板画完就拉一次余额，保存后也刷新一次
  assert.match(script, /for \(const builder of bubbleCards\(\)\) host\.append\(builder\(\)\);[\s\S]{0,200}loadBubbleLivePreviews\(\);/);
});

test('settings validation accepts per-service keys and profiles, rejects unknown fields', () => {
  const input = {
    service: 'custom',
    keys: { CUSTOM_API_KEY: '' },
    profiles: {
      custom: { protocol: 'openai-compatible', baseUrl: 'https://example.test/v1', model: 'model' },
    },
    automaticWhispers: false,
    whisperIntervalSec: 300,
    maxTokens: 512,
  };
  assert.deepEqual(validateSettings(input), input);
  assert.deepEqual(validateSettings({ clearKey: true }), { clearKey: true });
  for (const input of [
    null,
    [],
    { protocol: 'other' },
    { clearKey: 'yes' },
    { whisperIntervalSec: 59 },
    { whisperIntervalSec: 1.5 },
    { maxTokens: 99999 },
    { apiKey: 123 },
    { hasKey: true },
    { enabled: true },
    { baseUrl: 'file:///a' },
    {
      profiles: {
        custom: { protocol: 'openai-compatible', baseUrl: 'https://user:secret@example.test/v1', model: '' },
      },
    },
    { profiles: { custom: { protocol: 'openai-compatible', baseUrl: 'https://example.test/?key=secret', model: '' } } },
  ]) {
    assert.throws(() => validateSettings(input), Error, JSON.stringify(input));
  }
});

test('public settings are an allowlist even if backend accidentally includes credentials', () => {
  const actual = publicSettings({
    protocol: 'anthropic',
    service: 'deepseek-official',
    profiles: { custom: { protocol: 'anthropic', baseUrl: '', model: '' } },
    services: [{ id: 'custom', label: '自定义' }],
    apiKey: 'never expose',
    token: 'never expose',
    hasKey: true,
    model: 'x',
    enabled: false,
  });
  assert.deepEqual(actual, {
    protocol: 'anthropic',
    service: 'deepseek-official',
    profiles: { custom: { protocol: 'anthropic', baseUrl: '', model: '' } },
    services: [{ id: 'custom', label: '自定义' }],
    hasKey: true,
    model: 'x',
  });
  assert.equal(JSON.stringify(actual).includes('never expose'), false);
});

test('settings shell is accessible, self contained, and never saves browser secrets', () => {
  assert.match(settingsPage, /lang="zh-CN"/);
  assert.match(settingsPage, /type="password"/);
  assert.match(settingsPage, /aria-live="polite"/);
  assert.match(settingsPage, /data-tab="chat"/);
  assert.match(settingsPage, /data-tab="pet"/);
  assert.match(settingsPage, /data-tab="bubble"/);
  assert.match(settingsPage, /data-tab="ai"/);
  assert.match(settingsPage, /id="panel-pet"/);
  assert.match(settingsPage, /id="panel-bubble"/);
  assert.match(settingsPage, /id="panel-ai"/);
  // 三个分区各一个保存按钮：合在一个页面时用户点错过保存（桌宠 / 气泡 / AI）。
  assert.equal(settingsPage.match(/class="btn primary"/g).length, 3);
  assert.match(settingsPage, /id="pet-save"[^>]*>保存桌宠设置/);
  assert.match(settingsPage, /id="bubble-save"[^>]*>保存气泡设置/);
  assert.match(settingsPage, /id="save"[^>]*>保存 AI 设置/);
  // 点击编排是可排序队列：每步有上移/下移与启用勾选，不再只有两个固定开关。
  assert.match(settingsScript, /function bubbleStepRow/);
  assert.match(settingsScript, /function moveBubbleStep/);
  assert.match(settingsScript, /function setBubbleStepEnabled/);
  assert.match(settingsScript, /bubbleClickSteps/);
  assert.match(settingsScript, /function bubbleStepEditor/);
  assert.match(settingsScript, /function bubbleStepPreview/);
  assert.match(settingsScript, /function setBubbleStepRow/);
  assert.match(settingsScript, /BUBBLE_PLACEHOLDERS/);
  assert.match(settingsScript, /SAMPLE_BUBBLE_CONTEXT/);
  // 队列要能加/删步骤：预制步骤可删（×），自定义页可以从「加入编排」拉进来。
  assert.match(settingsScript, /function removeBubbleStep/);
  assert.match(settingsScript, /function addBubbleStep/);
  assert.match(settingsScript, /function bubbleStepAddRow/);
  assert.match(settingsScript, /＋ 加入编排/);
  // 自定义行支持加粗，且点占位符要插到「最近聚焦的那一行」而不是永远第一行。
  assert.match(settingsScript, /class: 'bubbleBold'/);
  assert.match(settingsScript, /粗体/);
  assert.match(settingsScript, /bubbleLastRowInput/);
  assert.doesNotMatch(settingsScript, /g-bubble-detail|g-bubble-pricing/);
  assert.match(settingsScript, /history\.replaceState/);
  assert.match(settingsScript, /X-DSH-Pet-Token/);
  assert.doesNotMatch(settingsScript, /localStorage|sessionStorage|document\.cookie|innerHTML/);
  assert.doesNotMatch(settingsPage, /https?:\/\/(?!example)/);
  assert.match(settingsStyle, /focus-visible/);
});

test('启动：地址片段被清掉，密钥框清空并显示已保存', async () => {
  const page = await setupPage();
  assert.equal(page.stripped(), '/standalone-ai/');
  assert.equal(page.element('apiKey').value, '');
  assert.equal(page.element('key-state').textContent, '已保存 · 不回显');
  assert.ok(
    page.aiRequests().every(({ options }) => options.headers['X-DSH-Pet-Token'] === 'process-capability'),
    'AI 请求必须带本次运行的访问令牌',
  );
});

test('保存：密钥只写不回显，按当前服务商提交 keys 与 profile', async () => {
  const page = await setupPage();
  page.element('apiKey').value = 'write-only-fake-key';
  await page.element('settings').listeners.submit({ preventDefault() {} });
  const body = page.lastAiBody() as unknown as {
    service: string;
    keys: Record<string, string>;
    profiles: Record<string, { protocol: string; baseUrl: string; model: string }>;
  };
  assert.equal(page.element('apiKey').value, '');
  assert.equal(body.service, 'deepseek-official');
  assert.deepEqual(body.keys, { DEEPSEEK_API_KEY: 'write-only-fake-key' });
  assert.deepEqual(body.profiles, {
    'deepseek-official': { protocol: 'anthropic', baseUrl: 'https://example.test', model: 'x' },
  });
  assert.equal('enabled' in body, false, '页面不再提交启用位');
});

test('查询余额：选了服务商才可点，结果拼成一行金额并带上访问令牌', async () => {
  const page = await setupPage();
  await settle();
  const button = page.element('balance-btn');
  const result = page.element('balance-result');
  assert.equal(button.disabled, false, '已保存 deepseek-official，按钮应可点');

  const balanceRequests = () => page.requests.filter(({ url }) => url === '/standalone-ai/balance');
  await button.listeners.click();
  await settle();

  assert.equal(balanceRequests().length, 1);
  assert.equal(balanceRequests()[0].options.headers['X-DSH-Pet-Token'], 'process-capability');
  assert.match(result.textContent, /CNY 12\.34/);
  assert.equal(result.dataset.ok, 'true');
  assert.equal(button.disabled, false, '查询结束后按钮恢复可点');
});

test('删除密钥：先弹确认框，取消不发请求，确认才提交 clearKey 与当前服务商', async () => {
  const page = await setupPage();
  page.element('key-delete').listeners.click();
  await settle();
  assert.equal(page.lastDialogActions().length, 2, '删除前必须先弹确认框');

  const before = page.aiRequests().length;
  page.lastDialogActions()[0].listeners.click();
  await settle();
  assert.equal(page.aiRequests().length, before, '取消后不得发出删除请求');

  page.element('key-delete').listeners.click();
  await settle();
  page.lastDialogActions()[1].listeners.click();
  await settle();
  assert.equal(page.lastAiBody().clearKey, true);
  assert.equal(page.lastAiBody().service, 'deepseek-official', '删的必须是用户当前看到的这家');
  assert.equal(page.element('key-state').textContent, '尚未设置');
  assert.equal(page.element('key-actions').hidden, true, '没有密钥时不再显示删除入口');
});

test('拉取模型：用表单草稿请求端点，选中后写回输入框并标记未保存', async () => {
  const page = await setupPage();
  page.element('baseUrl').value = 'https://draft.test/v1';
  page.element('apiKey').value = 'draft-key';
  page.element('model-toggle').listeners.click();
  await settle();

  const modelRequests = () => page.requests.filter(({ url }) => url === '/standalone-ai/models');
  assert.equal(modelRequests().length, 1);
  assert.deepEqual(JSON.parse(modelRequests()[0].options.body ?? '{}'), {
    protocol: 'anthropic',
    baseUrl: 'https://draft.test/v1',
    apiKey: 'draft-key',
  });
  assert.equal(modelRequests()[0].options.headers['X-DSH-Pet-Token'], 'process-capability');
  assert.match(page.element('model-result').textContent, /已拉取 2 个模型/);
  assert.equal(page.element('model').value, 'x', '拉取本身不得改动已填的模型');

  const menus = page.body.children.filter((kid) => kid.className === 'selectMenu');
  const menu = menus[menus.length - 1];
  assert.ok(menu, '拉到模型后必须直接弹出候选菜单');
  assert.equal(menu.children[0].className, 'selectSearchRow', '模型菜单必须先给一个搜索框');
  menu.children[1].listeners.click();
  assert.equal(page.element('model').value, 'm-one');
  assert.equal(page.element('dirty').hidden, false);
});

test('模型搜索：输入即过滤，大小写无关，清空恢复全部', async () => {
  const page = await setupPage();
  page.element('baseUrl').value = 'https://draft.test/v1';
  page.element('apiKey').value = 'draft-key';
  page.element('model-toggle').listeners.click();
  await settle();

  const menu = page.body.children.filter((kid) => kid.className === 'selectMenu').pop() as FakeNode;
  const search = menu.children[0].children[0];
  const first = menu.children[1];
  const second = menu.children[2];

  search.value = 'ONE';
  search.listeners.input();
  assert.equal(first.hidden, false, '「ONE」应该命中 M One');
  assert.equal(second.hidden, true, 'm-two 不该留在结果里');

  search.value = '';
  search.listeners.input();
  assert.equal(first.hidden, false);
  assert.equal(second.hidden, false);
});
