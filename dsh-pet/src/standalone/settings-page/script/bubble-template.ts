/**
 * 「气泡」分区里的自定义页编辑器与预览。
 *
 * 占位符目录与预览数据由 `settingsPage.ts` 从 shared 注入（页面脚本不能 import），
 * 渲染规则与气泡完全同源：文本里的 `{token}` 用同一份上下文替换，颜色/字号/对齐直接映射成
 * 内联样式，所以这里看到的预览与桌宠上看到的一致。
 * @module dsh-pet/src/standalone/settings-page/script/bubble-template
 */

export interface BubbleTemplateScriptOptions {
  /** 可插入的占位符（值由 shared 的 BUBBLE_PLACEHOLDERS 提供）。 */
  readonly placeholders: readonly { readonly token: string; readonly label: string }[];
  /** 预览用上下文：键为占位符名，值为显示文本。 */
  readonly context: Record<string, string>;
  /** 颜色输入的默认值（新增行时用）。 */
  readonly defaultColor: string;
}

/** 生成自定义页编辑器脚本片段。 */
export function bubbleTemplateScript(options: BubbleTemplateScriptOptions): string {
  return `
var BUBBLE_PLACEHOLDERS = ${JSON.stringify(options.placeholders)};
var SAMPLE_BUBBLE_CONTEXT = ${JSON.stringify(options.context)};
var DEFAULT_ROW_COLOR = ${JSON.stringify(options.defaultColor)};
var BUBBLE_ROW_ALIGNS = ['left', 'center', 'right'];

/** 与 shared 的 fillBubbleTemplate 同规则：不认识的占位符原样保留。 */
function fillBubbleTemplateText(text) {
  return String(text).replace(/\\{([a-zA-Z]+)\\}/g, function (whole, token) {
    var value = SAMPLE_BUBBLE_CONTEXT[token];
    return value === undefined ? whole : value;
  });
}

function bubbleTemplate() {
  if (!Array.isArray(state.globals.bubbleTemplate)) state.globals.bubbleTemplate = [];
  return state.globals.bubbleTemplate;
}

/**
 * 改一行的某个字段。注意：**不能**在这里调 renderBubblePanel()——重建整个面板会让用户正在输入的
 * input 被替换掉、焦点与光标位置全丢（输入一个字符断一次）。这里只改状态并就地刷新预览。
 */
function setBubbleTemplateRow(index, patch) {
  var rows = bubbleTemplate();
  if (index < 0 || index >= rows.length) return;
  var next = Object.assign({}, rows[index], patch);
  rows[index] = next;
  markDirty(true);
  refreshBubblePreview();
}

function addBubbleTemplateRow() {
  var rows = bubbleTemplate();
  if (rows.length >= 6) return;
  rows.push({ text: '余额 {balance}', color: DEFAULT_ROW_COLOR, size: 12, align: 'center' });
  markDirty(true);
  renderBubblePanel();
}

function removeBubbleTemplateRow(index) {
  var rows = bubbleTemplate();
  if (rows.length <= 1) return;
  rows.splice(index, 1);
  markDirty(true);
  renderBubblePanel();
}

function moveBubbleTemplateRow(index, delta) {
  var rows = bubbleTemplate();
  var target = index + delta;
  if (target < 0 || target >= rows.length) return;
  var tmp = rows[index];
  rows[index] = rows[target];
  rows[target] = tmp;
  markDirty(true);
  renderBubblePanel();
}

/** 预览：与气泡同一套替换规则与内联样式，让用户不点宠物也能看到效果。 */
function bubbleTemplatePreview() {
  var rows = bubbleTemplate();
  var box = make('div', { class: 'bubblePreview' });
  box.setAttribute('data-bubble-preview', '1');
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var line = make('div', { class: 'bubblePreviewLine', text: fillBubbleTemplateText(row.text) });
    if (row.color) line.style.color = row.color;
    if (typeof row.size === 'number') line.style.fontSize = row.size + 'px';
    if (row.align) line.style.textAlign = row.align;
    box.appendChild(line);
  }
  return box;
}

/**
 * 就地重画预览（不动输入框）：编辑时只刷新预览，保证输入焦点与光标不被重建打断。
 */
function refreshBubblePreview() {
  var box = document.querySelector('[data-bubble-preview]');
  if (!box) return;
  box.textContent = '';
  var rows = bubbleTemplate();
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var line = make('div', { class: 'bubblePreviewLine', text: fillBubbleTemplateText(row.text) });
    if (row.color) line.style.color = row.color;
    if (typeof row.size === 'number') line.style.fontSize = row.size + 'px';
    if (row.align) line.style.textAlign = row.align;
    box.appendChild(line);
  }
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
  if (!input) input = document.querySelector('.bubbleRowEditor .wideInput');
  if (!input) return;
  input.value = input.value + snippet;
  var index = Number(input.getAttribute('data-row'));
  if (isNaN(index)) index = 0;
  setBubbleTemplateRow(index, { text: input.value });
  input.focus();
  var pos = input.value.length;
  if (input.setSelectionRange) input.setSelectionRange(pos, pos);
}

/** 一行模板的编辑控件：文本 + 插入占位符 + 颜色 + 字号 + 对齐 + 排序/删除。 */
function bubbleTemplateRowEditor(row, index, total) {
  var text = make('input', { type: 'text', class: 'wideInput', value: row.text, maxLength: 120 });
  text.setAttribute('data-row', String(index));
  text.placeholder = '例如：余额 {balance} · 周额度剩 {weekly}';
  text.addEventListener('input', function () {
    setBubbleTemplateRow(index, { text: text.value });
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
    setBubbleTemplateRow(index, { text: text.value });
  });

  var color = make('input', { type: 'color', value: row.color || DEFAULT_ROW_COLOR, title: '文字颜色' });
  color.addEventListener('input', function () {
    setBubbleTemplateRow(index, { color: color.value });
  });

  var size = make('input', { type: 'number', class: 'bubbleSize', value: String(row.size || 12), min: '8', max: '48', step: '1', title: '字号（px）' });
  size.addEventListener('change', function () {
    var value = clampNumber(size.value, 8, 48, 12);
    setBubbleTemplateRow(index, { size: value });
  });

  var align = make('select', { class: 'bubbleAlign', title: '对齐' });
  for (var a = 0; a < BUBBLE_ROW_ALIGNS.length; a += 1) {
    var name = BUBBLE_ROW_ALIGNS[a];
    var option = make('option', { value: name, text: name === 'left' ? '左对齐' : name === 'center' ? '居中' : '右对齐' });
    if ((row.align || 'left') === name) option.selected = true;
    align.appendChild(option);
  }
  align.addEventListener('change', function () {
    setBubbleTemplateRow(index, { align: align.value });
  });

  var up = make('button', { type: 'button', class: 'btn ghost', text: '↑' });
  up.title = '上移';
  up.disabled = index === 0;
  up.addEventListener('click', function () {
    moveBubbleTemplateRow(index, -1);
  });
  var down = make('button', { type: 'button', class: 'btn ghost', text: '↓' });
  down.title = '下移';
  down.disabled = index === total - 1;
  down.addEventListener('click', function () {
    moveBubbleTemplateRow(index, 1);
  });
  var remove = make('button', { type: 'button', class: 'btn ghost', text: '×' });
  remove.title = '删除这一行';
  remove.disabled = total <= 1;
  remove.addEventListener('click', function () {
    removeBubbleTemplateRow(index);
  });

  return make('div', { class: 'bubbleRowEditor' }, [text, insert, color, size, align, up, down, remove]);
}

/** 自定义页卡片：行编辑器 + 实时预览 + 「加一行」。 */
function bubbleTemplateCard() {
  var rows = bubbleTemplate();
  var editors = rows.map(function (row, index) {
    return bubbleTemplateRowEditor(row, index, rows.length);
  });
  var add = make('button', { type: 'button', class: 'btn ghost', text: '＋ 加一行（最多 6 行）' });
  add.disabled = rows.length >= 6;
  add.addEventListener('click', function () {
    addBubbleTemplateRow();
  });
  return card(
    '自定义页',
    '「点击编排」里加一步「自定义页」后，这一页就按下面的行渲染：每行是一段文本，占位符渲染时替换成实时数据，颜色只收 #rgb/#rrggbb，字号 8~48，最多 6 行。编辑时上面的预览会实时更新。',
    [
      make('div', { class: 'bubblePreviewWrap' }, [bubbleTemplatePreview()]),
      bubblePlaceholderHint(),
    ].concat(editors).concat([add]),
  );
}
`;
}
