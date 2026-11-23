/**
 * 「桌宠配置」面板的草稿与保存：条目切换、实例列表的读入、面板装配与两个写接口。
 *
 * 编辑的是一份草稿（state.pets），只有点保存才写盘：main 条目连同全局字段走 PUT /config，
 * 其余条目走 POST /pet-config。单只宠物的字段与增删见 ./pet-card，条目级全局字段见 ./globals。
 * @module dsh-pet/src/standalone/settings-page/script/pets
 */

/** 生成宠物面板片段。 */
export function petsScript(): string {
  return `
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 原配置里的 physics 段，用来判断哪些可选键「本来就有」。 */
let physicsSource = null;

/** 动作频率权重：缺字段或非法项回落到内置默认，三项各自独立判定。 */
function pickWeights(raw) {
  const base = Object.assign({}, FALLBACK_WEIGHTS);
  if (!raw || typeof raw !== 'object') return base;
  for (const key of ['idle', 'turn', 'move']) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value >= 0) base[key] = value;
  }
  return base;
}

/** 长期记忆段：provider 与 powercontext 都齐全才认，否则给空 provider（= 不提交，保留旧值）。 */
function pickMemory(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const conf = source.powercontext && typeof source.powercontext === 'object' ? source.powercontext : {};
  return {
    provider: typeof source.provider === 'string' ? source.provider : '',
    powercontext: {
      endpoint: typeof conf.endpoint === 'string' ? conf.endpoint : '',
      token: typeof conf.token === 'string' ? conf.token : '',
      optimizeQuery: conf.optimizeQuery === true,
    },
  };
}

/** 点击编排缺省队列：与消费端一致（收起 → 明细 → 峰谷）。 */
function defaultBubbleSteps(pages) {
  return [
    { kind: 'summary', enabled: true },
    { kind: 'detail', enabled: !pages || pages.detail !== false },
    { kind: 'pricing', enabled: !pages || pages.pricing !== false },
  ];
}

/**
 * 点击编排队列：优先读 bubbleClickSteps，缺键时按旧的 bubbleClickPages 两开关推出默认队列。
 *
 * 每一步的 id / title / template 都要留住：多份自定义页靠 id 区分，
 * 「编辑过某一页」靠它自己的 template 留住。旧配置里的全局 bubbleTemplate
 * 会灌进没有自己模板的自定义页里（升级后用户能在设置页里继续改）。
 */
function pickBubbleSteps(source) {
  const raw = Array.isArray(source.bubbleClickSteps) && source.bubbleClickSteps.length
    ? source.bubbleClickSteps
    : defaultBubbleSteps(source.bubbleClickPages);
  const known = { summary: true, detail: true, pricing: true, whisper: true, custom: true };
  const legacy = pickBubbleTemplate(source.bubbleTemplate);
  const out = [];
  for (let i = 0; i < raw.length && out.length < 12; i += 1) {
    const step = raw[i];
    const kind = step && typeof step.kind === 'string' && known[step.kind] ? step.kind : 'summary';
    const next = { kind: kind, enabled: !step || step.enabled !== false };
    if (step && typeof step.id === 'string' && step.id.trim() !== '') next.id = step.id.trim();
    if (step && typeof step.title === 'string' && step.title.trim() !== '') next.title = step.title.trim();
    const rows = pickBubbleTemplate(step && step.template);
    if (rows.length > 0) next.template = rows;
    else if (kind === 'custom' && legacy.length > 0) next.template = legacy.map(function (row) { return Object.assign({}, row); });
    out.push(next);
  }
  return out;
}

/** 自定义页模板：只保留有文本的行，归一化颜色/字号/对齐（消费端与校验层同口径）。 */
function pickBubbleTemplate(source) {
  const raw = Array.isArray(source) ? source : [];
  return raw.slice(0, 6).map(function (row) {
    const text = row && typeof row.text === 'string' && row.text.length ? row.text : ' ';
    const out = { text: text };
    if (row && typeof row.color === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(row.color)) out.color = row.color.toLowerCase();
    if (row && typeof row.size === 'number' && Number.isFinite(row.size)) out.size = Math.min(48, Math.max(8, Math.round(row.size)));
    if (row && (row.align === 'left' || row.align === 'center' || row.align === 'right')) out.align = row.align;
    if (row && row.bold === true) out.bold = true;
    // 随峰谷变色是模板行的一等字段：丢掉它，保存后那一行就退回固定颜色。
    if (row && row.tierColor === true) out.tierColor = true;
    return out;
  });
}

function pickGlobals(main) {
  const source = main || {};
  const physics = source.physics && typeof source.physics === 'object' ? source.physics : null;
  physicsSource = physics;
  return {
    notificationsEnabled: source.notificationsEnabled !== false,
    // 与 voiceNotifyEnabled 同理：本项默认关，字段缺失时不能显示成已勾选，
    // 否则设置页显示「开」而消费端拿到 undefined 当成「关」，两边打架。
    notifyWhenFocused: source.notifyWhenFocused === true,
    // 系统通知转述：默认关，字段缺失时不能显示成已勾选，否则设置页显示「开」而消费端拿到 undefined 当成「关」。
    systemNotifyEnabled: source.systemNotifyEnabled === true,
    clickSoundEnabled: source.clickSoundEnabled !== false,
    whisperImageEnabled: source.whisperImageEnabled === true,
    chatImageEnabled: source.chatImageEnabled === true,
    chatAnimationEnabled: source.chatAnimationEnabled === true,
    confineToScreen: source.confineToScreen === true,
    trayEnabled: source.trayEnabled !== false,
    voiceEnabled: source.voiceEnabled === true,
    voiceName: typeof source.voiceName === 'string' && source.voiceName ? source.voiceName : DEFAULT_VOICE_ID,
    // 识别实现：独立模式只有内置几家，缺值时留空——空值不提交，服务端保留原值
    speechProvider: typeof source.speechProvider === 'string' ? source.speechProvider : '',
    // 长期记忆：整段读，缺段或空实现都表示「还没配」
    memory: pickMemory(source.memory),
    // 天气城市覆盖：空串是有效值（= 跟随 IP 自动定位），与上面 speechProvider 的空值语义不同，照常提交
    environmentCity: typeof source.environmentCity === 'string' ? source.environmentCity : '',
    voiceVolume: typeof source.voiceVolume === 'number' ? source.voiceVolume : 1,
    voiceWhisperEnabled: source.voiceWhisperEnabled !== false,
    voiceTodoEnabled: source.voiceTodoEnabled !== false,
    // 与 voiceTodo/voiceWhisper 的 !== false 写法不同：本项默认关，字段缺失时不能显示成已勾选，
    // 否则设置页显示「开」而播放端拿到 undefined 当成「关」，两边打架。
    voiceNotifyEnabled: source.voiceNotifyEnabled === true,
    physics: Object.assign({}, FALLBACK_PHYSICS, source.physics || {}),
    font: Object.assign({}, FALLBACK_FONT, source.font || {}),
    // 点击编排：缺键按全开（与消费端口径一致），只保存两个开关
    bubbleClickPages: {
      detail: !source.bubbleClickPages || source.bubbleClickPages.detail !== false,
      pricing: !source.bubbleClickPages || source.bubbleClickPages.pricing !== false,
    },
    bubbleClickSteps: pickBubbleSteps(source),
    bubbleTemplate: pickBubbleTemplate(source.bubbleTemplate),
    chatMemoryRounds: Number.isFinite(Number(source.chatMemoryRounds)) ? Number(source.chatMemoryRounds) : 0,
    chatImageLimit: Number.isFinite(Number(source.chatImageLimit)) ? Number(source.chatImageLimit) : 0,
    animationWeights: pickWeights(source.animationWeights),
  };
}

function initDrafts(config) {
  state.config = config;
  state.globals = pickGlobals(config.main);
  state.pets = {};
  state.prompts = {};
  for (const key of Object.keys(config)) {
    const conf = config[key];
    if (!conf || !Array.isArray(conf.pets)) continue;
    state.pets[key] = cloneJson(conf.pets);
    if (typeof conf.whisperPrompt === 'string') state.prompts[key] = conf.whisperPrompt;
  }
  if (!state.pets.main) state.pets.main = [];
  if (!state.pets[state.entry]) state.entry = 'main';
}

function currentPets() {
  return state.pets[state.entry] || [];
}

function currentPet() {
  return currentPets()[state.petIndex];
}

function entryTabs(keys) {
  const tabs = keys.map((key) => tabButton(key === 'main' ? '默认条目' : key, key === state.entry, () => {
    state.entry = key;
    state.petIndex = 0;
    renderPetsPanel();
  }));
  return make('div', { class: 'tabs' }, tabs);
}

function packNote() {
  return card('条目说明', null, [
    make('p', { class: 'cardHint', text: '这个条目来自文件宠物，只保存它自己的实例；全局开关与语音外观在「默认条目」里改。' }),
  ]);
}

function renderPetsPanel() {
  const host = byId('pet-cards');
  if (!host) return;
  host.textContent = '';
  const keys = Object.keys(state.pets);
  if (keys.length > 1) host.append(entryTabs(keys));
  host.append(petCard());
  if (state.entry === 'main') {
    for (const builder of globalCards()) host.append(builder());
  } else {
    host.append(packNote());
  }
}

/** 「气泡」分区：外观字号 + 点击编排，保存走同一条 PUT /config（main 条目）。 */
function renderBubblePanel() {
  const host = byId('bubble-cards');
  if (!host) return;
  host.textContent = '';
  for (const builder of bubbleCards()) host.append(builder());
  // 面板画好后拉一次真实余额：预览要按真的钱包/窗口数据算，才能和桌宠上一致。
  loadBubbleLivePreviews();
}

async function saveBubble() {
  const status = byId('bubble-status');
  const saveBtn = byId('bubble-save');
  saveBtn.disabled = true;
  setStatus(status, '正在保存…');
  try {
    let merged = await callApi('PUT', '/config', petsBody());
    if (!merged || merged.ok === false) {
      setStatus(status, (merged && (merged.message || merged.reason)) || '宿主拒绝了这次保存。', 'error');
      return;
    }
    initDrafts(merged);
    markDirty(false);
    renderBubblePanel();
    loadBubbleLivePreviews();
    setStatus(status, '已保存到本机，桌宠与页面会立即按新设置渲染。', 'ok');
  } catch (error) {
    setStatus(status, error && error.message ? error.message : String(error), 'error');
  } finally {
    saveBtn.disabled = false;
  }
}

/** 提交用的 physics 段：原配置没写过的可选键不带出去，避免保存时凭空补键。 */
function physicsBody() {
  const out = Object.assign({}, state.globals.physics);
  for (const key of ['tiltGravity', 'shakeThrow', 'hapticEnabled']) {
    if (!physicsSource || !(key in physicsSource)) delete out[key];
  }
  return out;
}

/** 兼容旧字段：从队列里反推「明细/峰谷」开关，老版本消费端也认。 */
function bubblePagesFromSteps() {
  const steps = state.globals.bubbleClickSteps || [];
  let detail = false;
  let pricing = false;
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i].enabled === false) continue;
    if (steps[i].kind === 'detail') detail = true;
    if (steps[i].kind === 'pricing') pricing = true;
  }
  return { detail: detail, pricing: pricing };
}

function petsBody() {
  return Object.assign({ pets: state.pets.main }, {
    notificationsEnabled: state.globals.notificationsEnabled,
    notifyWhenFocused: state.globals.notifyWhenFocused,
    systemNotifyEnabled: state.globals.systemNotifyEnabled,
    clickSoundEnabled: state.globals.clickSoundEnabled,
    whisperImageEnabled: state.globals.whisperImageEnabled,
    chatImageEnabled: state.globals.chatImageEnabled,
    chatAnimationEnabled: state.globals.chatAnimationEnabled,
    confineToScreen: state.globals.confineToScreen,
    trayEnabled: state.globals.trayEnabled,
    voiceEnabled: state.globals.voiceEnabled,
    voiceName: state.globals.voiceName,
    voiceVolume: state.globals.voiceVolume,
    voiceWhisperEnabled: state.globals.voiceWhisperEnabled,
    voiceTodoEnabled: state.globals.voiceTodoEnabled,
    voiceNotifyEnabled: state.globals.voiceNotifyEnabled,
    // 空串 = 还没读到成品值：不提交，免得用一个本地猜的实现覆盖配置
    ...(state.globals.speechProvider ? { speechProvider: state.globals.speechProvider } : {}),
    // 记忆段整段提交；provider 或地址为空 = 还没读到成品值，不提交，免得覆盖配置
    ...(state.globals.memory.provider && state.globals.memory.powercontext.endpoint ? { memory: state.globals.memory } : {}),
    // 城市覆盖与上面不同：空串是有效值（= 恢复自动定位），必须照常提交
    environmentCity: state.globals.environmentCity || '',
    physics: physicsBody(),
    font: state.globals.font,
    bubbleClickPages: bubblePagesFromSteps(),
    bubbleClickSteps: state.globals.bubbleClickSteps,
    bubbleTemplate: state.globals.bubbleTemplate,
    chatMemoryRounds: state.globals.chatMemoryRounds,
    chatImageLimit: state.globals.chatImageLimit,
    animationWeights: state.globals.animationWeights,
  });
}

async function savePets() {
  const status = byId('pet-status');
  const saveBtn = byId('pet-save');
  if (state.entry === 'main' && currentPets().length === 0) {
    setStatus(status, '默认条目至少要保留一只宠物，否则宿主会拒绝保存。', 'error');
    return;
  }
  saveBtn.disabled = true;
  setStatus(status, '正在保存…');
  try {
    let merged;
    if (state.entry === 'main') {
      merged = await callApi('PUT', '/config', petsBody());
      if (merged && merged.ok === false && merged.reason === 'user-config-unparsable') {
        const file = merged.userFile ? String(merged.userFile) : '用户配置';
        const confirmed = await confirmDialog({
          title: '配置文件无法解析',
          text: file + '\\n继续保存会按白名单重建这个文件，里面其它内容会丢失。',
          confirmLabel: '覆盖保存',
          danger: true,
        });
        if (!confirmed) {
          setStatus(status, '已取消保存。', 'error');
          return;
        }
        merged = await callApi('PUT', '/config?force=1', petsBody());
      }
    } else {
      merged = await callApi('POST', '/pet-config', { entry: state.entry, pets: currentPets() });
    }
    if (!merged || merged.ok === false) {
      setStatus(status, (merged && (merged.message || merged.reason)) || '宿主拒绝了这次保存。', 'error');
      return;
    }
    initDrafts(merged);
    markDirty(false);
    renderPetsPanel();
    setStatus(status, '已保存到本机。', 'ok');
  } catch (error) {
    setStatus(status, error && error.message ? error.message : String(error), 'error');
  } finally {
    saveBtn.disabled = false;
  }
}
`;
}
