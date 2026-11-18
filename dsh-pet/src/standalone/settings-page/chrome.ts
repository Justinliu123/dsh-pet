/**
 * 设置页 HTML 外壳：左侧固定分区导航 + 右侧内容区，桌宠与 AI 各占一个分区、各有自己的保存按钮。
 *
 * 页面只在本机回环上由 ./server 提供；CSP 是 `style-src 'self'`，所以这里不许出现内联样式，
 * 也不许内联脚本。桌宠配置面板的内容依赖 GET /config，初始只有一句占位文案。
 * 图标走设置页自己的公开资源路径（/standalone-ai/icon.png），内容读自包内 assets/logo.png，
 * 不复制第二份图；不能用插件路由 /logo——浏览器取 favicon 不带 Origin 也不带令牌，会被判成文件来源而 403。
 * 导航项以 `data-tab` 声明，脚本按约定找 `panel-<tab>`，新增分区只需照此加一对按钮与面板。
 * 桌宠配置、气泡编排与 AI 配置必须分成独立分区：每块各有自己的保存动作，合在一起容易点错保存按钮。
 * @module dsh-pet/src/standalone/settings-page/chrome
 */

/** 设置页 HTML。 */
export const settingsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><base href="/"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠设置</title><link rel="icon" type="image/png" href="/standalone-ai/icon.png"><link rel="stylesheet" href="/standalone-ai/settings.css">
<script src="/standalone-ai/settings.js" defer></script><script src="/standalone-ai/chat-panel.js" defer></script></head><body>
<main class="shell">
<aside class="side">
<div class="brand"><img class="brandLogo" src="/standalone-ai/icon.png" alt=""><span>桌宠</span></div>
<nav class="nav" aria-label="设置分区"><div class="navList" role="tablist">
<button type="button" class="navCell" role="tab" id="tab-chat" data-tab="chat" data-title="对话" aria-controls="panel-chat" aria-selected="true"><svg class="navGlyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.4h10a1.1 1.1 0 0 1 1.1 1.1v5.6A1.1 1.1 0 0 1 13 11.2H8.2L5 13.6v-2.4H3a1.1 1.1 0 0 1-1.1-1.1V4.5A1.1 1.1 0 0 1 3 3.4Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg><span class="navLabel">对话</span></button>
<button type="button" class="navCell" role="tab" id="tab-pet" data-tab="pet" data-title="桌宠" aria-controls="panel-pet" aria-selected="false"><svg class="navGlyph" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5.4 5.6a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4M10.6 5.6a1.2 1.2 0 1 0 0-2.4 1.2 1.2 0 0 0 0 2.4M3.6 9a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2M12.4 9a1.1 1.1 0 1 0 0-2.2 1.1 1.1 0 0 0 0 2.2"/><path d="M8 12.6c-1.9 0-3.2-1-3.2-2.3 0-1.4 1.3-2.7 3.2-2.7s3.2 1.3 3.2 2.7c0 1.3-1.3 2.3-3.2 2.3Z"/></g></svg><span class="navLabel">桌宠</span></button>
<button type="button" class="navCell" role="tab" id="tab-bubble" data-tab="bubble" data-title="气泡" aria-controls="panel-bubble" aria-selected="false"><svg class="navGlyph" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M2.4 3.2h11.2v6.4H7.6L4.4 12v-2.4H2.4Z"/><path d="M5 6.2h6M5 8.2h3.6" stroke-linecap="round"/></g></svg><span class="navLabel">气泡</span></button>
<button type="button" class="navCell" role="tab" id="tab-ai" data-tab="ai" data-title="AI 服务" aria-controls="panel-ai" aria-selected="false"><svg class="navGlyph" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M8 2.6 9.1 6l3.4 1.1-3.4 1.1L8 11.6 6.9 8.2 3.5 7.1 6.9 6Z"/><path d="M12.2 10.6l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5Z"/></g></svg><span class="navLabel">AI 服务</span></button>
</div></nav>
<div class="sideFoot">独立模式</div>
</aside>
<div class="main">
<div class="topbar"><h1 class="pageTitle" id="page-title">对话</h1><span class="dirty" id="dirty" hidden>有未保存的改动</span></div>
<div class="options">
<section class="panel" id="panel-pet" role="tabpanel" aria-labelledby="tab-pet" hidden>
<div class="scroll">
<div id="pet-cards"><p class="empty">正在读取本机配置…</p></div>
<div class="footer"><p class="status" id="pet-status" role="status" aria-live="polite"></p><button class="btn primary" id="pet-save" type="button" disabled>保存桌宠设置</button></div>
</div>
</section>
<section class="panel" id="panel-bubble" role="tabpanel" aria-labelledby="tab-bubble" hidden>
<div class="scroll">
<div id="bubble-cards"><p class="empty">正在读取本机配置…</p></div>
<div class="footer"><p class="status" id="bubble-status" role="status" aria-live="polite"></p><button class="btn primary" id="bubble-save" type="button" disabled>保存气泡设置</button></div>
</div>
</section>
<section class="panel" id="panel-ai" role="tabpanel" aria-labelledby="tab-ai" hidden>
<div class="scroll">
<form id="settings" aria-describedby="privacy">
<div class="card"><div class="cardHead"><h2 class="cardTitle">模型连接</h2></div>
<p class="cardHint">独立模式自己连服务商，不经过 DSH；所有配置只保存在当前机器。</p>
<div class="field"><span class="fieldLabel" id="service-label">服务商</span><div id="service-host"></div><p class="fieldHint" id="service-note">选定后自动填好协议与地址，密钥和模型按服务分开保存，换服务不会互相覆盖。自定义服务商没有余额接口。</p></div>
<div class="field"><span class="fieldLabel" id="protocol-label">接口协议</span><div id="protocol-host"></div></div>
<div class="field"><label for="baseUrl">接口地址（Base URL）</label><input id="baseUrl" name="baseUrl" type="url" placeholder="https://example.com/v1" maxlength="2048" spellcheck="false" aria-describedby="endpoint-note"><p class="fieldHint" id="endpoint-note">服务商提供的基础接口地址，支持 HTTP 与 HTTPS，通常以 /v1 结尾。不要把密钥放进地址。</p></div>
<div class="field"><label for="model">模型名称</label><div class="combo" id="model-combo"><input id="model" name="model" type="text" maxlength="200" placeholder="填写或拉取服务商的模型 ID，例如 deepseek-chat" spellcheck="false" aria-describedby="model-note"><button id="model-toggle" class="comboToggle" type="button" aria-label="拉取并选择模型" aria-haspopup="listbox" aria-expanded="false"></button></div><p class="fieldHint" id="model-note">可以直接手填；点右侧箭头向端点拉取可用列表后选择。拉取只用本次填写的地址与密钥，不会保存。</p><p class="status" id="model-result" role="status" aria-live="polite"></p></div>
<div class="field"><label for="apiKey"><span id="key-label">API 密钥</span> <span class="hintInline" id="key-state">尚未读取</span></label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已保存的密钥" aria-describedby="key-note"><div class="keyActions" id="key-actions" hidden><button id="key-delete" class="btn ghost" type="button">删除已保存的密钥</button></div><p id="key-note" class="fieldHint">密钥只写入本机配置，不会回显。留空会保留这个服务商已保存的那把；要彻底删除请点上面的按钮。</p></div>
<div class="field"><label for="deepseekApiKey">DeepSeek 语音密钥 <span class="hintInline" id="deepseek-key-state">尚未读取</span></label><input id="deepseekApiKey" name="deepseekApiKey" type="password" autocomplete="new-password" maxlength="4096" placeholder="留空保留已保存的密钥" aria-describedby="deepseek-key-note"><div class="keyActions" id="deepseek-key-actions" hidden><button id="deepseek-key-delete" class="btn ghost" type="button">删除已保存的语音密钥</button></div><p id="deepseek-key-note" class="fieldHint">只给 DeepSeek 语音合成与识别用，和上面的对话密钥分开存——对话走别家服务商时也能单独用 DeepSeek 语音。留空则依次沿用「服务商选 DeepSeek 官方时的那把密钥」，最后才回落 DSH 凭据。</p></div>
<div class="field"><p class="fieldHint" id="balance-note">余额查询跟随上方服务商，用的是这个服务已保存的那把密钥；自定义服务商没有余额接口。</p><div class="testRow"><button id="balance-btn" class="btn ghost" type="button" disabled>查询余额</button><span id="balance-result" class="status" role="status" aria-live="polite"></span></div></div>
<div class="testRow"><button id="test-btn" class="btn" type="button">测试连接</button><span id="test-result" class="status" role="status" aria-live="polite"></span></div>
</div>
<p id="privacy" class="fineprint">所有配置与密钥仅保存在当前机器。</p>
<div class="footer"><p class="status" id="status" role="status" aria-live="polite">正在读取本机设置…</p><button id="save" class="btn primary" type="submit" disabled>保存 AI 设置</button></div>
</form>
</div>
</section>
<section class="panel" id="panel-chat" role="tabpanel" aria-labelledby="tab-chat">
<div class="pet-chat-host" id="pet-chat-root"></div>
</section>
</div>
</div>
</main>
<noscript>需要启用 JavaScript 才能保存设置。请从桌宠右键菜单打开本页。</noscript>
</body></html>`;
