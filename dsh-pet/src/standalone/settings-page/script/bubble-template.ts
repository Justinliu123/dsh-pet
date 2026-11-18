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

function setBubbleTemplateRow(index, patch) {
  var rows = bubbleTemplate();
  if (index < 0 || index >= rows.length) return;
  var next = Object.assign({}, rows[index], patch);
  rows[index] = next;
  markDirty(true);
  renderBubblePanel();
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

/** 一行模板的编辑控件：文本 + 插入占位符 + 颜色 + 字号 + 对齐 + 排序/删除。 */
function bubbleTemplateRowEditor(row, index, total) {
  var text = make('input', { type: 'text', class: 'wideInput', value: row.text, maxLength: 120 });
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
    '「点击编排」里加一步「自定义页」后，这一页就按下面的行渲染。文本里可以插入 {占位符}，渲染时替换成实时数据；颜色只收 #rgb/#rrggbb，字号 8~48，最多 6 行。',
    [
      make('div', { class: 'bubblePreviewWrap' }, [bubbleTemplatePreview()]),
    ].concat(editors).concat([add]),
  );
}
`;
}
