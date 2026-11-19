/**
 * 「气泡」分区里每一页的内容编辑器与预览。
 *
 * 编排队列里的每一步（预置的余额/明细/峰谷/碎碎念，以及任意多份自定义页）都能单独编辑：
 * 这一页的文字、`{token}` 占位符、颜色、字号、对齐都挂在**这一步自己**的模板上，
 * 队列里有多份自定义页时互不干扰。
 *
 * 占位符目录、预置页的编辑种子与预览数据由 `settingsPage.ts` 从 shared 注入
 * （页面脚本不能 import），渲染规则与气泡完全同源：文本里的 `{token}` 用同一份上下文替换，
 * 颜色/字号/对齐直接映射成内联样式，所以这里看到的预览与桌宠上看到的一致。
 * @module dsh-pet/src/standalone/settings-page/script/bubble-template
 */

export interface BubbleTemplateScriptOptions {
  /** 可插入的占位符（值由 shared 的 BUBBLE_PLACEHOLDERS 提供）。 */
  readonly placeholders: readonly { readonly token: string; readonly label: string }[];
  /** 预览用上下文：键为占位符名，值为显示文本。 */
  readonly context: Record<string, string>;
  /** 颜色输入的默认值（新增行时用）。 */
  readonly defaultColor: string;
  /** 新建自定义页时的默认行（值由 shared 的 BUBBLE_CUSTOM_DEFAULT_ROWS 提供）。 */
  readonly defaultRows: readonly { readonly text: string; readonly size?: number; readonly align?: string }[];
  /** 预置页的编辑种子：点「编辑」时预填什么（值由 shared 的 bubbleStepSeedTemplate 提供）。 */
  readonly stepSeeds: Record<string, readonly { readonly text: string; readonly size?: number; readonly align?: string }[]>;
}

/** 生成气泡页编辑器脚本片段。 */
export function bubbleTemplateScript(options: BubbleTemplateScriptOptions): string {
  return `
var BUBBLE_PLACEHOLDERS = ${JSON.stringify(options.placeholders)};
var SAMPLE_BUBBLE_CONTEXT = ${JSON.stringify(options.context)};
var DEFAULT_ROW_COLOR = ${JSON.stringify(options.defaultColor)};
var BUBBLE_CUSTOM_DEFAULT_ROWS = ${JSON.stringify(options.defaultRows)};
var BUBBLE_STEP_SEEDS = ${JSON.stringify(options.stepSeeds)};
var BUBBLE_ROW_ALIGNS = ['left', 'center', 'right'];
/** 上一次查到的各预置页真实渲染结果（来自 /standalone-ai/balance 的 previews）。 */
var BUBBLE_LIVE_PREVIEWS = null;
/** 正在查余额；同一时刻只发一次请求。 */
var bubbleLivePreviewLoading = false;
/** 最近一次聚焦的模板行输入框：点占位符时优先插到这一行（点 chip 会先抢走焦点）。 */
var bubbleLastRowInput = null;
/** 上一次查到的真实占位符上下文（来自 /standalone-ai/balance 的 context）；没有就用样本。 */
var BUBBLE_LIVE_CONTEXT = null;

/** 预览填充用的上下文：真实数据优先，查不到才用样本值。 */
function bubblePreviewContext() {
  return BUBBLE_LIVE_CONTEXT || SAMPLE_BUBBLE_CONTEXT;
}

/** 与 shared 的 fillBubbleTemplate 同规则：不认识的占位符原样保留。 */
function fillBubbleTemplateText(text) {
  return String(text).replace(/\\{([a-zA-Z]+)\\}/g, function (whole, token) {
    var value = bubblePreviewContext()[token];
    return value === undefined ? whole : value;
  });
}

/** 复制一份行（新建页/预置页种子时用，避免共用同一个对象）。 */
function copyBubbleRows(rows) {
  var out = [];
  for (var i = 0; i < (rows || []).length; i += 1) out.push(Object.assign({}, rows[i]));
  return out;
}

/** 队列里第 index 步的内容行（没有模板就建一个空数组）。 */
function bubbleStepRows(index) {
  var steps = state.globals.bubbleClickSteps || [];
  var step = steps[index];
  if (!step) return [];
  if (!Array.isArray(step.template)) step.template = [];
  return step.template;
}

/** 队列里第 index 步（没有就 undefined）。 */
function bubbleStepAt(index) {
  var steps = state.globals.bubbleClickSteps || [];
  return steps[index];
}

/** 这一步的名字：自定义页用用户起的名字，预置页按 kind 给默认名。 */
function bubbleStepTitle(step, index) {
  if (step && typeof step.title === 'string' && step.title.trim() !== '') return step.title;
  if (step && step.kind === 'custom') return '自定义页 ' + ((typeof step.id === 'string' && step.id) || index + 1);
  return bubbleStepLabel(step.kind);
}

/**
 * 改一行的某个字段。注意：**不能**在这里调 renderBubblePanel()——重建整个面板会让用户正在输入的
 * input 被替换掉、焦点与光标位置全丢（输入一个字符断一次）。这里只改状态并就地刷新预览。
 */
function setBubbleStepRow(index, rowIndex, patch) {
  var rows = bubbleStepRows(index);
  if (rowIndex < 0 || rowIndex >= rows.length) return;
  var next = Object.assign({}, rows[rowIndex], patch);
  rows[rowIndex] = next;
  markDirty(true);
  refreshBubbleStepPreview(index);
}

/** 改这一步的名字（自定义页可自取名）。 */
function setBubbleStepTitle(index, title) {
  var step = bubbleStepAt(index);
  if (!step) return;
  var value = String(title === undefined || title === null ? '' : title);
  if (value.trim() === '') delete step.title;
  else step.title = value;
  markDirty(true);
}

function addBubbleStepRow(index) {
  var rows = bubbleStepRows(index);
  if (rows.length >= 6) return;
  rows.push({ text: '余额 {balance}', color: DEFAULT_ROW_COLOR, size: 12, align: 'center' });
  markDirty(true);
  renderBubblePanel();
}

function removeBubbleStepRow(index, rowIndex) {
  var rows = bubbleStepRows(index);
  if (rows.length <= 1) return;
  rows.splice(rowIndex, 1);
  markDirty(true);
  renderBubblePanel();
}

function moveBubbleStepRow(index, rowIndex, delta) {
  var rows = bubbleStepRows(index);
  var target = rowIndex + delta;
  if (target < 0 || target >= rows.length) return;
  var tmp = rows[rowIndex];
  rows[rowIndex] = rows[target];
  rows[target] = tmp;
  markDirty(true);
  renderBubblePanel();
}

/** 预览：与气泡同一套替换规则与内联样式，让用户不点宠物也能看到效果。 */
/** 档位字（峰/谷）在预览里也着色，和气泡上的观感对齐。 */
function bubblePreviewTierColor(tier) {
  return tier === 'peak' ? '#e5645f' : '#3aa76d';
}

/** 给一行预览套上模板里的颜色/字号/对齐/加粗。 */
function styleBubblePreviewLine(line, row) {
  if (row.color) line.style.color = row.color;
  if (typeof row.size === 'number') line.style.fontSize = row.size + 'px';
  if (row.align) line.style.textAlign = row.align;
  if (row.bold === true) line.style.fontWeight = '700';
}

/**
 * 这一页预览里要显示什么。
 *
 * 优先用「真实余额算出来的行」（BUBBLE_LIVE_PREVIEWS，来自 /standalone-ai/balance 的 previews），
 * 这样账户金额形态下不会凭空多出「周额度剩」；用户给这一页配了自己的模板才用模板，
 * 两者都没有时才回落到种子模板 + 样本上下文。
 */
function bubbleStepPreviewRows(index) {
  var step = bubbleStepAt(index);
  if (!step) return { source: 'empty', rows: [] };
  var own = bubbleStepRows(index);
  if (own.length > 0) return { source: 'template', rows: own };
  var live = BUBBLE_LIVE_PREVIEWS && BUBBLE_LIVE_PREVIEWS[step.kind];
  if (live && live.length > 0) return { source: 'live', rows: live };
  var seed = BUBBLE_STEP_SEEDS[step.kind];
  if (seed && seed.length > 0) return { source: 'seed', rows: copyBubbleRows(seed) };
  return { source: 'empty', rows: [] };
}

/** 把预览内容画进容器（模板行一行一条；真实行把「余额（谷）¥x」这类片段拼回一行）。 */
function paintBubbleStepPreview(box, index) {
  box.textContent = '';
  var picked = bubbleStepPreviewRows(index);
  if (picked.rows.length === 0) {
    box.appendChild(make('div', { class: 'bubblePreviewLine', text: '（这一页现在没有内容）' }));
    return;
  }
  if (picked.source !== 'live') {
    for (var i = 0; i < picked.rows.length; i += 1) {
      var row = picked.rows[i];
      var line = make('div', { class: 'bubblePreviewLine', text: fillBubbleTemplateText(row.text) });
      styleBubblePreviewLine(line, row);
      box.appendChild(line);
    }
    return;
  }
  // 真实行：role=label / tier 连续拼成一行，sub / error 另起一行——和气泡里的排版一致。
  var current = null;
  for (var j = 0; j < picked.rows.length; j += 1) {
    var item = picked.rows[j];
    if (item.role === 'sub' || item.role === 'error') {
      current = null;
      var sub = make('div', { class: 'bubblePreviewLine', text: item.text });
      styleBubblePreviewLine(sub, item);
      box.appendChild(sub);
      continue;
    }
    if (current === null) {
      current = make('div', { class: 'bubblePreviewLine' });
      box.appendChild(current);
    }
    var span = make('span', { text: item.text });
    if (item.role === 'tier') span.style.color = bubblePreviewTierColor(item.tier);
    styleBubblePreviewLine(span, item);
    current.appendChild(span);
  }
}

function bubbleStepPreview(index) {
  var box = make('div', { class: 'bubblePreview' });
  box.setAttribute('data-bubble-preview', String(index));
  paintBubbleStepPreview(box, index);
  return box;
}

/**
 * 就地重画预览（不动输入框）：编辑时只刷新预览，保证输入焦点与光标不被重建打断。
 */
function refreshBubbleStepPreview(index) {
  var box = document.querySelector('[data-bubble-preview="' + index + '"]');
  if (!box) return;
  paintBubbleStepPreview(box, index);
}

/** 所有已展开的编辑器都按最新余额重画一遍预览（面板重建之后、或查到余额之后调用）。 */
function refreshAllBubbleStepPreviews() {
  var boxes = document.querySelectorAll('[data-bubble-preview]');
  for (var i = 0; i < boxes.length; i += 1) {
    var index = Number(boxes[i].getAttribute('data-bubble-preview'));
    if (!isNaN(index)) paintBubbleStepPreview(boxes[i], index);
  }
}

/** 记下真实余额算出来的预览，并把已展开的编辑器刷新一遍。 */
function setBubbleLivePreviews(previews, context) {
  BUBBLE_LIVE_PREVIEWS = previews && typeof previews === 'object' ? previews : null;
  BUBBLE_LIVE_CONTEXT = context && typeof context === 'object' ? context : null;
  refreshAllBubbleStepPreviews();
}

/**
 * 拉一次真实余额，让预览和桌宠对齐。
 *
 * 只是锦上添花：查不到（没配服务商、网络失败、旧接口没有 previews）就保留模板预览，
 * 绝不能因此打断设置页的其他功能。
 */
function loadBubbleLivePreviews() {
  if (bubbleLivePreviewLoading) return;
  bubbleLivePreviewLoading = true;
  fetch('/standalone-ai/balance', {
    method: 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'X-DSH-Pet-Token': TOKEN },
  })
    .then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      return response.json();
    })
    .then(function (data) {
      if (data && (data.previews || data.context)) setBubbleLivePreviews(data.previews, data.context);
    })
    .catch(function () {
      // 静默：预览退回模板口径。
    })
    .then(function () {
      bubbleLivePreviewLoading = false;
    });
}

/** 占位符说明：页面上直接列出全部 token 与含义（不用去翻文档，也不用猜下拉框）。 */
function bubblePlaceholderHint() {
  var wrap = make('div', { class: 'bubblePlaceholderHint' });
  wrap.appendChild(make('p', { class: 'bubblePlaceholderHintTitle', text: '可用占位符（点击任一项可插入到这一行末尾）：' }));
  var list = make('div', { class: 'bubblePlaceholderChips' });
  for (var i = 0; i < BUBBLE_PLACEHOLDERS.length; i += 1) {
    var item = BUBBLE_PLACEHOLDERS[i];
    var chip = make('button', { type: 'button', class: 'bubbleChip' });
    chip.appendChild(make('code', { class: 'bubbleChipToken', text: '{' + item.token + '}' }));
    chip.appendChild(make('span', { class: 'bubbleChipLabel', text: item.label }));
    chip.title = '{' + item.token + '} → ' + item.label;
    (function (token, el) {
      // 按下时阻止默认行为：不然焦点会从正在编辑的输入框移到按钮上，
      // appendPlaceholderToFocusedRow 就找不到「当前行」了。
      el.addEventListener('mousedown', function (event) {
        event.preventDefault();
      });
      el.addEventListener('click', function () {
        appendPlaceholderToFocusedRow(token);
      });
    })(item.token, chip);
    list.appendChild(chip);
  }
  wrap.appendChild(list);
  return wrap;
}

/** 把占位符追加到当前聚焦行的文本框末尾；没有聚焦行就追加到第一行。 */
function appendPlaceholderToFocusedRow(token) {
  var snippet = '{' + token + '}';
  var active = document.activeElement;
  var input = active && active.classList && active.classList.contains('wideInput') ? active : null;
  // 点 chip 时焦点在按钮上，退回到「最近编辑过的那一行」，而不是永远第一行。
  if (!input && bubbleLastRowInput && document.contains(bubbleLastRowInput)) input = bubbleLastRowInput;
  if (!input) input = document.querySelector('.bubbleStepEditor .wideInput');
  if (!input) return;
  input.value = input.value + snippet;
  var stepIndex = Number(input.getAttribute('data-step'));
  var rowIndex = Number(input.getAttribute('data-row'));
  if (isNaN(stepIndex)) stepIndex = 0;
  if (isNaN(rowIndex)) rowIndex = 0;
  setBubbleStepRow(stepIndex, rowIndex, { text: input.value });
  input.focus();
  var pos = input.value.length;
  if (input.setSelectionRange) input.setSelectionRange(pos, pos);
}

/** 一行模板的编辑控件：文本 + 插入占位符 + 加粗 + 颜色 + 字号 + 对齐 + 排序/删除。 */
function bubbleStepRowEditor(index, row, rowIndex, total) {
  var text = make('input', { type: 'text', class: 'wideInput', value: row.text, maxLength: 120 });
  text.setAttribute('data-row', String(rowIndex));
  text.setAttribute('data-step', String(index));
  text.placeholder = '例如：余额 {balance} · 周额度剩 {weekly}';
  text.addEventListener('focus', function () {
    bubbleLastRowInput = text;
  });
  text.addEventListener('input', function () {
    bubbleLastRowInput = text;
    setBubbleStepRow(index, rowIndex, { text: text.value });
  });

  var insert = make('select', { class: 'bubbleInsert' });
  insert.appendChild(make('option', { value: '', text: '插入占位符…' }));
  for (var i = 0; i < BUBBLE_PLACEHOLDERS.length; i += 1) {
    var item = BUBBLE_PLACEHOLDERS[i];
    insert.appendChild(make('option', { value: item.token, text: item.label + '（{' + item.token + '}）' }));
  }
  insert.addEventListener('change', function () {
    if (!insert.value) return;
    var snippet = '{' + insert.value + '}';
    var start = text.selectionStart === null ? text.value.length : text.selectionStart;
    text.value = text.value.slice(0, start) + snippet + text.value.slice(start);
    insert.value = '';
    setBubbleStepRow(index, rowIndex, { text: text.value });
  });

  var boldBox = make('input', { type: 'checkbox', class: 'bubbleBoldBox', checked: row.bold === true, title: '加粗' });
  boldBox.addEventListener('change', function () {
    setBubbleStepRow(index, rowIndex, { bold: boldBox.checked });
  });
  var bold = make('label', { class: 'bubbleBold', title: '加粗' }, [boldBox, make('span', { text: '粗体' })]);

  var color = make('input', { type: 'color', value: row.color || DEFAULT_ROW_COLOR, title: '文字颜色' });
  color.addEventListener('input', function () {
    setBubbleStepRow(index, rowIndex, { color: color.value });
  });

  var size = make('input', { type: 'number', class: 'bubbleSize', value: String(row.size || 12), min: '8', max: '48', step: '1', title: '字号（px）' });
  size.addEventListener('change', function () {
    var value = clampNumber(size.value, 8, 48, 12);
    setBubbleStepRow(index, rowIndex, { size: value });
  });

  var align = make('select', { class: 'bubbleAlign', title: '对齐' });
  for (var a = 0; a < BUBBLE_ROW_ALIGNS.length; a += 1) {
    var name = BUBBLE_ROW_ALIGNS[a];
    var option = make('option', { value: name, text: name === 'left' ? '左对齐' : name === 'center' ? '居中' : '右对齐' });
    if ((row.align || 'left') === name) option.selected = true;
    align.appendChild(option);
  }
  align.addEventListener('change', function () {
    setBubbleStepRow(index, rowIndex, { align: align.value });
  });

  var up = make('button', { type: 'button', class: 'btn ghost', text: '↑' });
  up.title = '上移';
  up.disabled = rowIndex === 0;
  up.addEventListener('click', function () {
    moveBubbleStepRow(index, rowIndex, -1);
  });
  var down = make('button', { type: 'button', class: 'btn ghost', text: '↓' });
  down.title = '下移';
  down.disabled = rowIndex === total - 1;
  down.addEventListener('click', function () {
    moveBubbleStepRow(index, rowIndex, 1);
  });
  var remove = make('button', { type: 'button', class: 'btn ghost', text: '×' });
  remove.title = '删除这一行';
  remove.disabled = total <= 1;
  remove.addEventListener('click', function () {
    removeBubbleStepRow(index, rowIndex);
  });

  return make('div', { class: 'bubbleRowEditor' }, [text, insert, bold, color, size, align, up, down, remove]);
}

/** 某一步的编辑面板：预览 + 占位符说明 + 逐行编辑 + 加一行。 */
/**
 * 把预置页的默认内容灌进这一页自己的模板（用户点「从默认内容开始改」时才做）。
 *
 * 不在打开编辑器时就自动灌：那样一按保存，预置页就从「内置渲染」变成「模板渲染」，
 * 与实时预览/实际气泡的细节就会悄悄漂移。
 */
function seedBubbleStepContent(index) {
  var step = bubbleStepAt(index);
  if (!step) return;
  var seed = step.kind === 'custom' ? BUBBLE_CUSTOM_DEFAULT_ROWS : BUBBLE_STEP_SEEDS[step.kind];
  if (!seed || seed.length === 0) return;
  step.template = copyBubbleRows(seed);
  markDirty(true);
  renderBubblePanel();
}

function bubbleStepEditor(index) {
  var step = bubbleStepAt(index);
  var wrap = make('div', { class: 'bubbleStepEditor' });
  if (!step) return wrap;
  wrap.appendChild(make('p', { class: 'bubbleStepEditorTitle', text: '正在编辑：' + bubbleStepTitle(step, index) }));

  if (step.kind === 'custom') {
    var title = make('input', { type: 'text', class: 'wideInput', value: step.title || '', maxLength: 40 });
    title.placeholder = '这一页的名字（例如：余额速览）';
    title.addEventListener('input', function () {
      setBubbleStepTitle(index, title.value);
    });
    wrap.appendChild(make('div', { class: 'bubbleStepTitleRow' }, [title]));
  }

  var rows = bubbleStepRows(index);
  wrap.appendChild(make('div', { class: 'bubblePreviewWrap' }, [bubbleStepPreview(index)]));
  if (step.kind !== 'custom' && rows.length === 0) {
    // 预置页还没被改过：预览就是桌宠上的真实内容；要改成自己的文字再点这里。
    var seedBtn = make('button', { type: 'button', class: 'btn ghost', text: '从默认内容开始改' });
    seedBtn.title = '把这一页当前的内容作为起点写进它自己的模板，之后就能逐行改';
    seedBtn.addEventListener('click', function () {
      seedBubbleStepContent(index);
    });
    wrap.appendChild(seedBtn);
  }
  wrap.appendChild(bubblePlaceholderHint());
  for (var i = 0; i < rows.length; i += 1) {
    wrap.appendChild(bubbleStepRowEditor(index, rows[i], i, rows.length));
  }
  var add = make('button', { type: 'button', class: 'btn ghost', text: '＋ 加一行（最多 6 行）' });
  add.disabled = rows.length >= 6;
  add.addEventListener('click', function () {
    addBubbleStepRow(index);
  });
  wrap.appendChild(add);

  if (step.kind !== 'custom') {
    // 预置页被编辑过：给一条「恢复默认」——删掉这一页自己的模板就回到内置内容。
    var reset = make('button', { type: 'button', class: 'btn ghost', text: '恢复这一页的默认内容' });
    reset.addEventListener('click', function () {
      delete step.template;
      markDirty(true);
      renderBubblePanel();
    });
    wrap.appendChild(reset);
  }
  return wrap;
}
`;
}
