/**
 * 「桌宠配置」面板的全局部分：开关、语音、外观、物理、移动端、对话模型与落盘位置。
 *
 * 全部读写 state.globals（main 条目的全局字段），由 ./pets 的保存一并提交。
 * 卡片按 builder 数组返回，渲染时机由 ./pets 决定——这里不自己找容器。
 * @module dsh-pet/src/standalone/settings-page/script/globals
 */

/** 生成全局卡片片段。 */
export function globalsScript(): string {
  return `
function globalCards() {
  return [globalFlagsCard, voiceCard, physicsCard, motionCard, modelCard, memoryCard, environmentCard, advancedCard];
}

/** 「气泡」分区：外观字号 + 点击编排（每一页的内容就在队列里点「编辑」改）。 */
function bubbleCards() {
  return [fontCard, bubbleClickCard];
}

/** 编排步骤目录：顺序即点击顺序；whisper 没有内容时消费端会跳过。 */
function bubbleStepDefs() {
  return [
    { kind: 'summary', label: '余额 / 额度 / 今日已用', hint: '收起态：余额、今日已用、最紧迫的额度与重置时间。' },
    { kind: 'detail', label: '窗口明细', hint: '5h 与周额度各自还剩多少、什么时候重置；服务商给了区间用量时跟在它后面。' },
    { kind: 'pricing', label: '峰谷价目', hint: 'DeepSeek 单价（命中/未命中/输出）与距下次峰谷切换的倒计时；只有同时有账户余额与窗口额度时才有内容。' },
    { kind: 'whisper', label: '碎碎念 / 对话', hint: '最近一条碎碎念或对话气泡；没有内容时这一步自动跳过。' },
    { kind: 'custom', label: '自定义页', hint: '自己写的一页：内容在它自己的「编辑」里配；可以建多份，每份各配各的。' },
  ];
}

function bubbleStepLabel(kind) {
  const defs = bubbleStepDefs();
  for (let i = 0; i < defs.length; i += 1) if (defs[i].kind === kind) return defs[i].label;
  return kind;
}

function bubbleStepHint(kind) {
  const defs = bubbleStepDefs();
  for (let i = 0; i < defs.length; i += 1) if (defs[i].kind === kind) return defs[i].hint;
  return '';
}

/**
 * 打开/收起某一步的编辑面板（同一时刻只展开一步）。
 *
 * 预置页第一次编辑时预填一份占位符种子——用户点开就能看见这一页能写什么，
 * 再逐行改成自己的内容；自定义页没有模板时给一份默认行。
 */
function toggleBubbleStepEdit(index) {
  var steps = state.globals.bubbleClickSteps || [];
  var step = steps[index];
  if (!step) return;
  if (state.bubbleEditStep === index) {
    state.bubbleEditStep = null;
    renderBubblePanel();
    return;
  }
  // 预置页打开编辑时不自动灌默认内容：没改过的页继续走内置渲染，预览=实际；
  // 要改文字请点编辑器里的「从默认内容开始改」（seedBubbleStepContent）。
  if (step.kind === 'custom' && (!Array.isArray(step.template) || step.template.length === 0)) {
    step.template = copyBubbleRows(BUBBLE_CUSTOM_DEFAULT_ROWS);
  }
  state.bubbleEditStep = index;
  markDirty(true);
  renderBubblePanel();
}

/** 新建一份自定义页：生成不重复的 id + 默认行，并直接进入编辑。 */
function addCustomBubblePage() {
  var steps = state.globals.bubbleClickSteps || [];
  var used = {};
  for (var i = 0; i < steps.length; i += 1) {
    if (steps[i] && typeof steps[i].id === 'string') used[steps[i].id] = true;
  }
  var n = 1;
  while (used['c' + n]) n += 1;
  var step = {
    kind: 'custom',
    id: 'c' + n,
    title: '自定义页 ' + n,
    template: copyBubbleRows(BUBBLE_CUSTOM_DEFAULT_ROWS),
  };
  state.globals.bubbleClickSteps = steps.concat([step]);
  state.bubbleEditStep = steps.length;
  markDirty(true);
  renderBubblePanel();
}

/** 上移/下移一步：顺序就是点击顺序，改完立即重渲染（保存仍走下方按钮）。 */
function moveBubbleStep(index, delta) {
  const steps = state.globals.bubbleClickSteps || [];
  const target = index + delta;
  if (target < 0 || target >= steps.length) return;
  const next = steps.slice();
  const moved = next[index];
  next[index] = next[target];
  next[target] = moved;
  state.globals.bubbleClickSteps = next;
  markDirty(true);
  renderBubblePanel();
}

function setBubbleStepEnabled(index, enabled) {
  const steps = state.globals.bubbleClickSteps || [];
  state.globals.bubbleClickSteps = steps.map(function (step, at) {
    return at === index ? Object.assign({}, step, { enabled: enabled }) : step;
  });
  markDirty(true);
}

/** 从编排里删掉一步（预制步骤也能删；至少保留一步，空队列宿主会拒绝保存）。 */
function removeBubbleStep(index) {
  const steps = state.globals.bubbleClickSteps || [];
  if (steps.length <= 1) return;
  const next = steps.slice();
  next.splice(index, 1);
  state.globals.bubbleClickSteps = next;
  markDirty(true);
  renderBubblePanel();
}

/** 往编排里加一步（同一 kind 只允许出现一次）。 */
function addBubbleStep(kind) {
  const steps = state.globals.bubbleClickSteps || [];
  for (let i = 0; i < steps.length; i += 1) if (steps[i].kind === kind) return;
  state.globals.bubbleClickSteps = steps.concat([{ kind: kind }]);
  markDirty(true);
  renderBubblePanel();
}

/** 队列里下一份自定义页的 id（不撞已有 id）。 */
function nextCustomStepId() {
  const steps = state.globals.bubbleClickSteps || [];
  let n = 1;
  const used = {};
  for (let i = 0; i < steps.length; i += 1) if (steps[i].id) used[steps[i].id] = true;
  while (used['c' + n]) n += 1;
  return 'c' + n;
}

/**
 * 把内置预置页加回编排：文本/颜色/字号都照预置内容带过来，加完就能直接弹。
 *
 * 自定义类预置每份一个新 id（可以建多份）；pricing 这种按 kind 只能有一份。
 */
function addBubblePreset(index) {
  const preset = BUBBLE_PRESET_PAGES[index];
  if (!preset) return;
  const steps = state.globals.bubbleClickSteps || [];
  const step = { kind: preset.kind, enabled: true, title: preset.title, template: copyBubbleRows(preset.rows) };
  if (preset.kind === 'custom') step.id = nextCustomStepId();
  else {
    for (let i = 0; i < steps.length; i += 1) if (steps[i].kind === preset.kind) return;
  }
  state.globals.bubbleClickSteps = steps.concat([step]);
  markDirty(true);
  renderBubblePanel();
}

/**
 * 「加入编排」：下拉里第一组是内置预置页（DeepSeek 余额 / MiniMax 额度 / 峰谷价目），
 * 第二组是还没进队列的通用步骤（碎碎念）。旧的「余额 / 额度 / 今日已用」「窗口明细」
 * 已不再作为预置提供——想要那种内容就在「新建自定义页」里自己写。
 */
function bubbleStepAddRow() {
  const steps = state.globals.bubbleClickSteps || [];
  const offered = [];
  for (let i = 0; i < BUBBLE_PRESET_PAGES.length; i += 1) {
    const preset = BUBBLE_PRESET_PAGES[i];
    let present = false;
    for (let j = 0; j < steps.length; j += 1) {
      if (steps[j].kind !== preset.kind) continue;
      if (preset.kind !== 'custom' || steps[j].title === preset.title) present = true;
    }
    if (!present) offered.push({ value: 'preset:' + i, text: preset.title });
  }
  let whisperPresent = false;
  for (let i = 0; i < steps.length; i += 1) if (steps[i].kind === 'whisper') whisperPresent = true;
  if (!whisperPresent) offered.push({ value: 'kind:whisper', text: bubbleStepLabel('whisper') });

  const wrap = make('div', { class: 'bubbleStepAdd' });
  const select = make('select', { class: 'bubbleStepAddSelect' });
  for (let i = 0; i < offered.length; i += 1) {
    select.appendChild(make('option', { value: offered[i].value, text: offered[i].text }));
  }
  if (offered.length > 0) {
    const add = make('button', { type: 'button', class: 'btn ghost', text: '＋ 加入编排' });
    add.addEventListener('click', function () {
      if (select.value.indexOf('preset:') === 0) addBubblePreset(Number(select.value.slice(7)));
      else addBubbleStep(select.value.slice(5));
    });
    wrap.appendChild(select);
    wrap.appendChild(add);
  } else {
    wrap.appendChild(make('p', { class: 'fieldHint', text: '预置页都在编排里了；要调顺序用 ↑ ↓，不想弹某一步就取消勾选。' }));
  }
  return wrap;
}

function bubbleStepRow(step, index, total) {
  const box = make('input', { type: 'checkbox', checked: step.enabled !== false });
  box.addEventListener('change', function () {
    setBubbleStepEnabled(index, box.checked);
  });
  const up = make('button', { type: 'button', class: 'btn ghost', text: '↑' });
  up.title = '上移';
  up.disabled = index === 0;
  up.addEventListener('click', function () {
    moveBubbleStep(index, -1);
  });
  const down = make('button', { type: 'button', class: 'btn ghost', text: '↓' });
  down.title = '下移';
  down.disabled = index === total - 1;
  down.addEventListener('click', function () {
    moveBubbleStep(index, 1);
  });
  const remove = make('button', { type: 'button', class: 'btn ghost', text: '×' });
  remove.title = '从编排里删掉这一步（之后可以用下方「加入编排」加回来）';
  remove.disabled = total <= 1;
  remove.addEventListener('click', function () {
    removeBubbleStep(index);
  });
  const edit = make('button', { type: 'button', class: 'btn ghost', text: state.bubbleEditStep === index ? '收起' : '编辑' });
  edit.title = '编辑这一页的内容：文字、{占位符}、颜色、字号、对齐';
  edit.addEventListener('click', function () {
    toggleBubbleStepEdit(index);
  });
  return make('div', { class: 'rowCheck bubbleStep' }, [
    box,
    make('span', { class: 'rowCheckText' }, [
      make('span', { class: 'rowCheckTitle', text: (index + 1) + '. ' + bubbleStepTitle(step, index) }),
      make('span', { class: 'rowCheckHint', text: bubbleStepHint(step.kind) }),
    ]),
    edit,
    up,
    down,
    remove,
  ]);
}

function bubbleClickCard() {
  const steps = state.globals.bubbleClickSteps || [];
  const blocks = [];
  for (let i = 0; i < steps.length; i += 1) {
    blocks.push(bubbleStepRow(steps[i], i, steps.length));
    // 展开中的那一步在它下面直接编辑内容，不用再翻别的卡片。
    if (state.bubbleEditStep === i) blocks.push(bubbleStepEditor(i));
  }
  const custom = make('button', { type: 'button', class: 'btn ghost', text: '＋ 新建自定义页' });
  custom.title = '新建一份自己的页：内容、颜色、字号都在它自己的「编辑」里配';
  custom.addEventListener('click', function () {
    addCustomBubblePage();
  });
  return card(
    '点击编排',
    '点一下宠物本体，按下面顺序一页页弹；再点推进，末页再点收起（10 秒不动也会自己收）。用 ↑ ↓ 调顺序、× 删掉某一步（下方可再加回来，内置预置页直接选名字即可），取消勾选只是临时跳过。每一页都能点「编辑」改内容：预置页可以换成自己的文字，自定义页可以建多份、每份各配各的。',
    [
      make('p', { class: 'fieldHint', text: '共 ' + steps.length + ' 步（至少保留一步）；自定义页点「＋ 新建自定义页」创建，内容在它自己的「编辑」里配。' }),
    ].concat(blocks).concat([bubbleStepAddRow(), custom]),
  );
}

function setGlobal(key, value) {
  state.globals[key] = value;
}

function globalFlagsCard() {
  const g = state.globals;
  return card('全局开关', '对所有宠物生效；保存后立即写盘。', [
    toggleRow('g-notify', '系统通知', '对话完成、生成失败、权限申请等事件弹出系统通知。', g.notificationsEnabled, (value) => setGlobal('notificationsEnabled', value)),
    toggleRow('g-notify-focused', '前台聚焦时也提醒', '开着本页、窗口在前台时照样弹通知、照样播报工作状态语音。默认关闭。', g.notifyWhenFocused, (value) => setGlobal('notifyWhenFocused', value)),
    toggleRow('g-system-notify', '由桌宠转述系统通知', '打开后桌宠每隔几秒读一次 Windows 通知中心，把微信、邮件、IDE 等应用弹出的通知用气泡和语音念出来；DSH 的对话完成、生成失败、等你回答也由它说。默认关闭（关着就不读你的通知）。', g.systemNotifyEnabled, (value) => setGlobal('systemNotifyEnabled', value)),
    toggleRow('g-click', '点击音效', '点击宠物时播放内置音效。', g.clickSoundEnabled, (value) => setGlobal('clickSoundEnabled', value)),
    toggleRow('g-whisper-image', '碎碎念配图', '碎碎念时允许模型挑一张表情包。', g.whisperImageEnabled, (value) => setGlobal('whisperImageEnabled', value)),
    toggleRow('g-chat-image', '对话配图', '对话时把表情包清单交给模型按语境选图。', g.chatImageEnabled, (value) => setGlobal('chatImageEnabled', value)),
    toggleRow('g-chat-anim', '对话动作联动', '对话时让模型挑一个动作当场表演。', g.chatAnimationEnabled, (value) => setGlobal('chatAnimationEnabled', value)),
    toggleRow('g-confine', '锁定在当前屏幕', '抛掷与自主漫游只在当前所在的这块屏幕里活动。', g.confineToScreen, (value) => setGlobal('confineToScreen', value)),
    toggleRow('g-tray', '系统托盘图标', '桌面模式常驻托盘；关掉后只能从任务栏找回。', g.trayEnabled, (value) => setGlobal('trayEnabled', value)),
  ]);
}

function environmentCard() {
  const g = state.globals;
  const feedback = make('p', { class: 'fieldHint', text: '', hidden: true });
  const show = (text) => {
    feedback.textContent = text;
    feedback.hidden = false;
  };
  const input = make('input', { type: 'text', id: 'g-env-city', value: g.environmentCity || '' });
  input.placeholder = '留空 = 自动定位';
  input.addEventListener('input', () => {
    setGlobal('environmentCity', input.value);
    markDirty(true);
    feedback.hidden = true;
  });
  // 检测走宿主已有的环境查询（不带 pet = 纯查询，不点亮气泡），把 IP 定位结果回填。
  // 必带 fresh=1：不带就会读到 10 分钟内的缓存定位，用户点了检测却拿到旧城市。
  // 必带 ip=1：不带就会把配置里已填的城市原样回显，检测按钮等于没作用。
  // 回填后不自动保存——用户可能还要改，统一走页面底部的保存。
  const detect = button('检测', () => {
    detect.textContent = '检测中…';
    detect.disabled = true;
    callApi('POST', '/environment?fresh=1&ip=1')
      .then((facts) => {
        if (!facts || typeof facts.city !== 'string' || !facts.city) {
          show('宿主没有返回城市（IP 定位失败），请手动填写。');
          return;
        }
        input.value = facts.city;
        setGlobal('environmentCity', facts.city);
        markDirty(true);
        show('已填入：' + facts.city + '（点保存生效）');
      })
      .catch((error) => show('检测失败：' + (error && error.message ? error.message : String(error))))
      .finally(() => {
        detect.textContent = '检测';
        detect.disabled = false;
      });
  });
  return card('环境与定位', '天气查哪座城市。留空 = 按出口 IP 自动定位；填了城市名就按它查。', [
    fieldRow('g-env-city', '城市', make('div', { class: 'row' }, [input, detect]), '填城市名即可，「扬州」和「扬州市」都行。'),
    feedback,
  ]);
}

function voiceCard() {
  const g = state.globals;
  // 运行时目录优先：宿主注册了 Edge / DeepSeek 就都列出来；拉不到回落构建期的内置清单
  const voices = state.voiceOptions && state.voiceOptions.length > 0
    ? state.voiceOptions
    : VOICES.map((voice) => ({ id: voice.id, name: voice.name, tag: voice.tag, provider: voice.provider }));
  const speechProviders = state.speechProviders || [];
  return card('语音', '四类语音各一个开关，互不从属；音色、识别实现与音量共用。', [
    toggleRow('g-voice', '手动播报', '右键菜单与斜杠命令触发的碎碎念、对话回复念出来。', g.voiceEnabled, (value) => setGlobal('voiceEnabled', value)),
    selectField('g-voice-name', '音色', g.voiceName, voices.map((voice) => ({ value: voice.id, label: voice.name + (voice.tag ? ' · ' + voice.tag : ''), group: voice.provider })), (value) => setGlobal('voiceName', value)),
    numberField('g-voice-volume', '音量（0–1）', g.voiceVolume, (value) => setGlobal('voiceVolume', clampNumber(value, 0, 1, 1)), { min: 0, max: 1, step: 0.05 }),
    toggleRow('g-voice-whisper', '周期碎碎念也念出来', '定时生成的那句碎碎念念出来。', g.voiceWhisperEnabled, (value) => setGlobal('voiceWhisperEnabled', value)),
    toggleRow('g-voice-todo', '待办提醒也念出来', '到点的待办提醒念出来。', g.voiceTodoEnabled, (value) => setGlobal('voiceTodoEnabled', value)),
    toggleRow('g-voice-notify', '通知播报', '任务完成、出错、等你确认时念一句配置的工作状态文案；页面被藏起来也照样念。', g.voiceNotifyEnabled, (value) => setGlobal('voiceNotifyEnabled', value)),
    selectField('g-speech-provider', '语音识别', g.speechProvider, speechProviders.map((item) => ({ value: item.id, label: item.name })), (value) => setGlobal('speechProvider', value), '按住录音后交给哪个实现转写。装了对应插件才会出现多个选项；选中的实现不可用时识别会明确报错，不会自动换一个。'),
  ]);
}

function fontCard() {
  const g = state.globals;
  return card('外观与字体', '气泡、悬浮提示与对话窗共用的字体。', [
    selectField('g-font-family', '字体', g.font.family, FONT_IDS.map((id) => ({ value: id, label: id })), (value) => { g.font = Object.assign({}, g.font, { family: value }); }),
    numberField('g-font-size', '字号（px）', g.font.size, (value) => { g.font = Object.assign({}, g.font, { size: clampNumber(value, 4, 200, 21) }); }, { min: 4, max: 200, step: 1, hint: '只影响气泡与悬浮提示，对话窗字号不变。' }),
    toggleRow('g-font-follow', '字号随宠物大小缩放', '关掉后恒为上面的字号，不随窗口尺寸变化。', g.font.followPet, (value) => { g.font = Object.assign({}, g.font, { followPet: value }); }),
  ]);
}

function physicsCard() {
  const g = state.globals;
  return card('拖拽与抛掷手感', '所有宠物共用；数值改动保存后生效。', [
    make('div', { class: 'grid2' }, [
      numberField('g-gravity', '重力加速度（px/s²）', g.physics.gravity, (value) => { g.physics = Object.assign({}, g.physics, { gravity: clampNumber(value, 0, 10000, 1400) }); }, { min: 0, max: 10000, step: 10 }),
      numberField('g-restitution', '碰壁弹性（0–1）', g.physics.restitution, (value) => { g.physics = Object.assign({}, g.physics, { restitution: clampNumber(value, 0, 1, 0.78) }); }, { min: 0, max: 1, step: 0.01 }),
    ]),
    make('div', { class: 'grid2' }, [
      numberField('g-friction', '接触面摩擦（/s）', g.physics.groundFriction, (value) => { g.physics = Object.assign({}, g.physics, { groundFriction: clampNumber(value, 0, 30, 2.5) }); }, { min: 0, max: 30, step: 0.1 }),
      numberField('g-power', '总力度', g.physics.throwPower, (value) => { g.physics = Object.assign({}, g.physics, { throwPower: clampNumber(value, 0.1, 5, 1) }); }, { min: 0.1, max: 5, step: 0.1 }),
    ]),
    toggleRow('g-ceiling', '顶部反弹', '关掉后上方没有边界，抛掷可以飞出屏幕顶部。', g.physics.ceilingBounce !== false, (value) => { g.physics = Object.assign({}, g.physics, { ceilingBounce: value }); }),
    toggleRow('g-collide', '宠物互相碰撞', '飞行中的宠物撞到其它宠物时按动量弹开。', g.physics.petCollision !== false, (value) => { g.physics = Object.assign({}, g.physics, { petCollision: value }); }),
    toggleRow('g-spring', '弹簧跟手', '开（默认）= 拖拽时用弹簧追指针，有一点延迟、手感柔和；关 = 刚性实时跟随，宠物直接贴住鼠标。不影响甩出力度。', g.physics.dragSpring !== false, (value) => { g.physics = Object.assign({}, g.physics, { dragSpring: value }); }),
  ]);
}

function motionCard() {
  const g = state.globals;
  const weights = g.animationWeights;
  const actionId = 'g-motion-action';
  const actionValue = () => String(Math.max(0, 100 - weights.idle - weights.turn - weights.move));
  const syncAction = () => {
    const node = byId(actionId);
    if (node) node.value = actionValue();
  };
  const weightField = (key, label) =>
    numberField('g-motion-' + key, label, weights[key], (value) => {
      const others = weights.idle + weights.turn + weights.move - weights[key];
      const max = Math.max(0, 100 - others);
      weights[key] = Math.round(Math.min(Math.max(value, 0), max));
      syncAction();
    }, { min: 0, max: 100, step: 1 });
  return card('动作频率', '四个框：待机 / 转向 / 移动可改，随机动作自动算（= 100 − 其余三项）。所有宠物共用；pet pack 可在自己种类文件里覆盖。', [
    make('div', { class: 'grid2' }, [
      weightField('idle', '待机（%）'),
      weightField('turn', '转向（%）'),
      weightField('move', '移动（%）'),
      numberField(actionId, '随机动作（%，自动）', actionValue(), () => {}, { min: 0, max: 100, step: 1, readOnly: true }),
    ]),
  ]);
}

function modelCard() {
  const g = state.globals;
  return card('对话上下文', '模型与接入方式在「AI 服务商」页配置；这里管对话保留多少上下文。', [
    make('div', { class: 'grid2' }, [
      numberField('g-memory', '对话记忆轮数', g.chatMemoryRounds, (value) => setGlobal('chatMemoryRounds', Math.round(clampNumber(value, 0, 100, 0))), { min: 0, max: 100, step: 1, hint: '0 表示不带历史。' }),
      numberField('g-image-limit', '配图张数上限', g.chatImageLimit, (value) => setGlobal('chatImageLimit', Math.round(clampNumber(value, 0, 50, 0))), { min: 0, max: 50, step: 1, hint: '0 表示不限制。' }),
    ]),
  ]);
}

function memoryCard() {
  const g = state.globals;
  const memoryProviders = state.memoryProviders || [];
  const isPowerContext = g.memory.provider === POWERCONTEXT_ID;
  // PowerContext 的参数只属于它：选中别家时整块隐藏。用 hidden 切换而不是整卡重渲染——
  // 重渲染会把正在输入的光标位置丢掉。
  const details = make('div', { class: 'grid2', hidden: !isPowerContext }, [
    textField('g-pc-endpoint', 'PowerContext 地址', g.memory.powercontext.endpoint, (value) => {
      g.memory.powercontext = Object.assign({}, g.memory.powercontext, { endpoint: value });
    }, { hint: '本机 PowerContext 服务的根地址，例如 http://127.0.0.1:8000。' }),
    textField('g-pc-token', '访问令牌', g.memory.powercontext.token, (value) => {
      g.memory.powercontext = Object.assign({}, g.memory.powercontext, { token: value });
    }, { secret: true, hint: '服务端没开认证时留空。令牌只存在本机配置里，不进日志。' }),
  ]);
  const optimize = make('div', { hidden: !isPowerContext }, [
    toggleRow('g-pc-optimize', '查询优化', '开启后用模型把这句话改写成检索查询，并带上最近两轮还原指代。默认关闭：指代通常指向刚说过的话，那些轮次本来就在对话历史里。', g.memory.powercontext.optimizeQuery, (value) => {
      g.memory.powercontext = Object.assign({}, g.memory.powercontext, { optimizeQuery: value });
    }),
  ]);
  return card('长期记忆', '对话时用哪个记忆实现；下面的地址、令牌与开关只属于 PowerContext。', [
    selectField('g-memory-provider', '记忆实现', g.memory.provider, memoryProviders.map((item) => ({ value: item.id, label: item.name })), (value) => {
      g.memory.provider = value;
      const show = value === POWERCONTEXT_ID;
      details.hidden = !show;
      optimize.hidden = !show;
    }, '对话时用哪个记忆实现。内置的只带最近若干轮历史；装了第三方记忆插件才会出现更多选项，找不到对应实现时回落内置。'),
    details,
    optimize,
  ]);
}

function pathRows() {
  const meta = state.meta || {};
  const rows = [];
  const pairs = [['用户配置', meta.user], ['内置默认', meta.default], ['动画配置', meta.animations], ['表情包', meta.memes], ['待办数据', meta.todos], ['日志', meta.logs]];
  for (const pair of pairs) {
    if (!pair[1]) continue;
    rows.push(make('div', { class: 'pathRow' }, [
      make('span', { class: 'pathKey', text: pair[0] }),
      make('span', { class: 'pathValue', text: String(pair[1]), title: String(pair[1]) }),
    ]));
  }
  if (Array.isArray(meta.storage)) {
    for (const item of meta.storage) {
      if (!item || !item.path) continue;
      rows.push(make('div', { class: 'pathRow' }, [
        make('span', { class: 'pathKey', text: item.exists === false ? '未生成' : '已存在' }),
        make('span', { class: 'pathValue', text: String(item.path), title: String(item.path) }),
      ]));
    }
  }
  return rows.length ? rows : [make('p', { class: 'empty', text: '读不到落盘位置信息。' })];
}

function advancedCard() {
  return card('高级', '手改配置文件时可以从这里找到位置；「同步」会用内置默认覆盖用户配置。', [
    make('div', {}, pathRows()),
    make('div', { class: 'testRow' }, [button('用内置默认覆盖用户配置', syncFromDefault)]),
  ]);
}

async function syncFromDefault() {
  const confirmed = await confirmDialog({
    title: '用内置默认覆盖用户配置',
    text: '现有的用户配置会被整份替换，这个操作不能撤销。',
    confirmLabel: '覆盖',
    danger: true,
  });
  if (!confirmed) return;
  const status = byId('pet-status');
  setStatus(status, '正在同步…');
  try {
    const merged = await callApi('POST', '/config');
    initDrafts(merged);
    markDirty(false);
    renderPetsPanel();
    setStatus(status, '已用内置默认覆盖用户配置。', 'ok');
  } catch (error) {
    setStatus(status, error && error.message ? error.message : String(error), 'error');
  }
}
`;
}
