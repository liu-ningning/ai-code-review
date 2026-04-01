export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Review Console</title>
    <link rel="stylesheet" href="/assets/dashboard.css" />
  </head>
  <body>
    <div class="page-shell">
      <aside class="hero-panel">
        <p class="eyebrow">AI REVIEW SERVER</p>
        <h1>可视化操作界面</h1>
        <p class="hero-copy">
          用一个控制台页面触发 CI Review、观察流式进度、查看结果摘要，并生成可直接复用的请求样例。
        </p>

        <div class="hero-ribbon">
          <span class="hero-chip">GitHub / GitLab</span>
          <span class="hero-chip">NDJSON Stream</span>
          <span class="hero-chip">Inline Findings</span>
        </div>

        <div class="hero-grid">
          <section class="mini-card">
            <span class="mini-label">服务状态</span>
            <strong id="health-badge" class="status-badge pending">待检测</strong>
            <button id="health-check-button" class="ghost-button" type="button">检查 /healthz</button>
          </section>

          <section class="mini-card">
            <span class="mini-label">当前能力</span>
            <ul class="feature-list">
              <li>触发 Pull Request / Merge Request Review</li>
              <li>触发 Commit Review</li>
              <li>实时显示 NDJSON 进度</li>
              <li>查看结果摘要与原始响应</li>
            </ul>
          </section>
        </div>
      </aside>

      <main class="workspace">
        <section class="panel form-panel">
          <div class="panel-head">
            <div>
              <p class="eyebrow">RUN REVIEW</p>
              <h2>发起一次评审</h2>
            </div>
            <div id="request-mode-indicator" class="mode-pill">流式模式</div>
          </div>

          <form id="review-form" class="review-form">
            <label class="field">
              <span>Review 类型</span>
              <select id="kind" name="kind">
                <option value="merge_request">merge_request</option>
                <option value="commit">commit</option>
              </select>
              <small class="field-hint">推荐优先使用 <code>merge_request</code>，结果回写更完整。</small>
            </label>

            <label class="field span-2">
              <span>项目路径</span>
              <input id="projectPath" name="projectPath" placeholder="group/project" required />
              <small class="field-hint">GitHub 填 <code>owner/repo</code>，GitLab 填 <code>group/project</code>。</small>
            </label>

            <label class="field span-2">
              <span>Review Token</span>
              <input id="reviewToken" name="reviewToken" type="password" placeholder="CI_REVIEW_TOKEN" required />
              <small class="field-hint">仅用于调用 <code>/ci/review</code>，不会发送到 LLM。</small>
            </label>

            <label class="field">
              <span>流式返回</span>
              <label class="switch">
                <input id="stream" name="stream" type="checkbox" checked />
                <span class="switch-ui"></span>
                <span>启用 NDJSON 进度</span>
              </label>
            </label>

            <label class="field">
              <span>PR / MR 编号</span>
              <input id="mergeRequestIid" name="mergeRequestIid" type="number" min="1" placeholder="123" />
              <small class="field-hint">例如 PR 链接 <code>/pull/2</code>，这里填 <code>2</code>。</small>
            </label>

            <label class="field commit-only">
              <span>分支</span>
              <input id="branch" name="branch" placeholder="feature/demo" />
            </label>

            <label class="field commit-only">
              <span>Head SHA</span>
              <input id="headSha" name="headSha" placeholder="a1b2c3d4" />
            </label>

            <label class="field commit-only">
              <span>Base SHA</span>
              <input id="baseSha" name="baseSha" placeholder="optional" />
            </label>

            <label class="field commit-only">
              <span>作者</span>
              <input id="author" name="author" placeholder="optional" />
            </label>

            <label class="field span-2 commit-only">
              <span>标题</span>
              <input id="title" name="title" placeholder="optional" />
            </label>

            <label class="field span-2 commit-only">
              <span>页面地址</span>
              <input id="htmlUrl" name="htmlUrl" type="url" placeholder="optional" />
            </label>

            <label class="field span-2 commit-only">
              <span>描述</span>
              <textarea id="description" name="description" rows="3" placeholder="optional"></textarea>
            </label>

            <div class="form-actions span-2">
              <button id="submit-button" class="primary-button" type="submit">开始评审</button>
              <button id="reset-button" class="ghost-button" type="button">重置结果</button>
            </div>
          </form>
        </section>

        <section class="panel status-panel">
          <div class="panel-head compact">
            <div>
              <p class="eyebrow">LIVE STATUS</p>
              <h2>执行进度</h2>
            </div>
            <strong id="run-status" class="status-badge idle">空闲</strong>
          </div>

          <div class="status-hero">
            <div>
              <p class="status-kicker">当前状态</p>
              <p id="status-note" class="status-note">等待发起新的 review 请求</p>
            </div>
            <div class="progress-meta">
              <span>进度</span>
              <strong id="progress-label">0%</strong>
            </div>
          </div>

          <div class="progress-strip">
            <div id="progress-bar" class="progress-bar"></div>
          </div>

          <div class="section-label">运行概览</div>

          <dl class="stats-grid">
            <div>
              <dt>Request ID</dt>
              <dd id="request-id">-</dd>
            </div>
            <div>
              <dt>结论</dt>
              <dd id="conclusion">-</dd>
            </div>
            <div>
              <dt>评审文件</dt>
              <dd id="reviewed-file-count">0</dd>
            </div>
            <div>
              <dt>评论数量</dt>
              <dd id="comment-count">0</dd>
            </div>
            <div>
              <dt>最近阶段</dt>
              <dd id="latest-stage">-</dd>
            </div>
            <div>
              <dt>运行模式</dt>
              <dd id="request-mode-label">NDJSON</dd>
            </div>
          </dl>

          <div class="section-label">事件时间线</div>
          <div id="event-log" class="event-log"></div>
        </section>

        <section class="panel result-panel">
          <div class="panel-head compact">
            <div>
              <p class="eyebrow">OUTPUT</p>
              <h2>响应结果</h2>
            </div>
          </div>

          <div class="result-summary">
            <div class="result-pill">
              <span>结论</span>
              <strong id="summary-conclusion">-</strong>
            </div>
            <div class="result-pill">
              <span>评论</span>
              <strong id="summary-comments">0</strong>
            </div>
            <div class="result-pill">
              <span>文件</span>
              <strong id="summary-files">0</strong>
            </div>
          </div>

          <div id="finding-list" class="finding-list empty">还没有结果</div>
          <pre id="raw-result" class="code-block">等待请求...</pre>
        </section>

        <section class="panel recipe-panel">
          <div class="panel-head compact">
            <div>
              <p class="eyebrow">REQUEST RECIPE</p>
              <h2>请求样例</h2>
            </div>
            <button id="copy-curl-button" class="ghost-button" type="button">复制命令</button>
          </div>
          <p class="recipe-note">切换表单字段后会实时更新，适合直接粘贴到终端验证。</p>
          <pre id="curl-preview" class="code-block">curl 预览将在这里生成</pre>
        </section>
      </main>
    </div>

    <script type="module" src="/assets/dashboard.js"></script>
  </body>
</html>`;
}

export function dashboardStyles(): string {
  return `
:root {
  --bg: #f3efe6;
  --panel: rgba(255, 252, 246, 0.86);
  --panel-strong: #fffaf0;
  --ink: #182126;
  --muted: #5f6b71;
  --line: rgba(24, 33, 38, 0.14);
  --accent: #d95d39;
  --accent-deep: #ad4020;
  --accent-soft: rgba(217, 93, 57, 0.14);
  --accent-wash: rgba(217, 93, 57, 0.08);
  --success: #226f54;
  --warning: #b56a00;
  --danger: #9b2226;
  --surface-dark: rgba(23, 29, 33, 0.94);
  --shadow: 0 20px 60px rgba(63, 47, 31, 0.14);
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  color: var(--ink);
  font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
  background:
    radial-gradient(circle at top left, rgba(217, 93, 57, 0.12), transparent 22rem),
    radial-gradient(circle at bottom right, rgba(34, 111, 84, 0.12), transparent 24rem),
    linear-gradient(135deg, #ede3d0, var(--bg));
}

.page-shell {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  min-height: 100vh;
}

.hero-panel {
  padding: 40px 28px;
  background:
    linear-gradient(180deg, rgba(24, 33, 38, 0.94), rgba(43, 52, 57, 0.88)),
    linear-gradient(135deg, rgba(217, 93, 57, 0.3), transparent);
  color: #f8f2e8;
}

.hero-panel h1,
.workspace h2 {
  margin: 0;
  font-family: "IBM Plex Serif", Georgia, serif;
  letter-spacing: -0.02em;
}

.hero-panel h1 {
  font-size: 2.5rem;
  line-height: 1;
  margin-bottom: 16px;
}

.hero-copy {
  margin: 0 0 28px;
  color: rgba(248, 242, 232, 0.82);
  line-height: 1.6;
}

.hero-ribbon {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 22px;
}

.hero-chip {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 0 12px;
  border-radius: 999px;
  background: rgba(255, 248, 238, 0.1);
  border: 1px solid rgba(255, 248, 238, 0.12);
  color: rgba(248, 242, 232, 0.92);
  font-size: 0.86rem;
}

.eyebrow {
  margin: 0 0 10px;
  font-size: 0.78rem;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: inherit;
  opacity: 0.78;
}

.hero-grid {
  display: grid;
  gap: 16px;
}

.mini-card,
.panel {
  border: 1px solid var(--line);
  border-radius: 24px;
  backdrop-filter: blur(14px);
  box-shadow: var(--shadow);
}

.mini-card {
  padding: 18px;
  background: rgba(255, 248, 238, 0.08);
}

.mini-label {
  display: block;
  margin-bottom: 10px;
  color: rgba(248, 242, 232, 0.72);
}

.feature-list {
  margin: 0;
  padding-left: 18px;
  line-height: 1.8;
}

.workspace {
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.9fr);
  gap: 20px;
  padding: 24px;
}

.panel {
  background: var(--panel);
  padding: 22px;
  position: relative;
  overflow: hidden;
}

.panel::before {
  content: "";
  position: absolute;
  inset: 0 auto auto 0;
  width: 100%;
  height: 1px;
  background: linear-gradient(90deg, rgba(217, 93, 57, 0.45), transparent 45%);
  pointer-events: none;
}

.form-panel {
  grid-column: 1 / 2;
}

.status-panel,
.result-panel,
.recipe-panel {
  grid-column: 2 / 3;
}

.recipe-panel {
  grid-column: 1 / 3;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 22px;
}

.panel-head.compact {
  margin-bottom: 18px;
}

.mode-pill,
.status-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 0.92rem;
  font-weight: 700;
}

.mode-pill {
  background: var(--accent-soft);
  color: var(--accent-deep);
}

.status-badge {
  border: 1px solid var(--line);
  background: rgba(255, 255, 255, 0.7);
}

.status-badge.pending,
.status-badge.idle {
  color: var(--muted);
}

.status-badge.running {
  background: rgba(217, 93, 57, 0.14);
  color: var(--accent-deep);
}

.status-badge.success {
  background: rgba(34, 111, 84, 0.14);
  color: var(--success);
}

.status-badge.failure {
  background: rgba(155, 34, 38, 0.14);
  color: var(--danger);
}

.status-badge.warning {
  background: rgba(181, 106, 0, 0.14);
  color: var(--warning);
}

.review-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.field {
  display: grid;
  gap: 8px;
}

.span-2 {
  grid-column: 1 / 3;
}

.field span {
  font-size: 0.9rem;
  color: var(--muted);
}

.field-hint {
  font-size: 0.78rem;
  line-height: 1.5;
  color: rgba(95, 107, 113, 0.92);
}

.field-hint code {
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(24, 33, 38, 0.08);
  font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
  font-size: 0.76rem;
}

input,
select,
textarea,
button {
  font: inherit;
}

input,
select,
textarea {
  width: 100%;
  padding: 12px 14px;
  border: 1px solid rgba(24, 33, 38, 0.16);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.72);
  color: var(--ink);
  transition: border-color 140ms ease, transform 140ms ease, background 140ms ease;
}

input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: var(--accent);
  background: #fffef9;
  transform: translateY(-1px);
}

.switch {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 8px 0;
}

.switch input {
  display: none;
}

.switch-ui {
  position: relative;
  width: 52px;
  height: 30px;
  border-radius: 999px;
  background: rgba(24, 33, 38, 0.18);
}

.switch-ui::after {
  content: "";
  position: absolute;
  top: 4px;
  left: 4px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #fff;
  transition: transform 160ms ease;
}

.switch input:checked + .switch-ui {
  background: rgba(217, 93, 57, 0.48);
}

.switch input:checked + .switch-ui::after {
  transform: translateX(22px);
}

.form-actions {
  display: flex;
  gap: 12px;
}

.primary-button,
.ghost-button {
  border: 0;
  border-radius: 14px;
  padding: 12px 16px;
  cursor: pointer;
  transition: transform 140ms ease, opacity 140ms ease;
}

.primary-button {
  background: linear-gradient(135deg, var(--accent), #ef7d4f);
  color: #fffdf9;
  font-weight: 700;
}

.ghost-button {
  background: rgba(255, 255, 255, 0.72);
  color: var(--ink);
  border: 1px solid rgba(24, 33, 38, 0.12);
}

.primary-button:hover,
.ghost-button:hover {
  transform: translateY(-1px);
}

.progress-strip {
  overflow: hidden;
  height: 14px;
  border-radius: 999px;
  background: rgba(24, 33, 38, 0.08);
  margin-bottom: 18px;
}

.progress-bar {
  width: 0%;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), #f2a65a);
  transition: width 180ms ease;
}

.status-hero {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 16px 18px;
  margin-bottom: 16px;
  border-radius: 18px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.8), rgba(255, 247, 240, 0.9)),
    linear-gradient(135deg, var(--accent-wash), transparent 60%);
  border: 1px solid rgba(24, 33, 38, 0.08);
}

.status-kicker {
  margin: 0 0 6px;
  font-size: 0.78rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
}

.status-note {
  margin: 0;
  font-size: 1rem;
  line-height: 1.5;
  font-weight: 600;
}

.progress-meta {
  min-width: 82px;
  text-align: right;
}

.progress-meta span {
  display: block;
  font-size: 0.78rem;
  color: var(--muted);
  margin-bottom: 4px;
}

.progress-meta strong {
  font-size: 1.3rem;
  font-weight: 700;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin: 0 0 18px;
}

.stats-grid div {
  padding: 14px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.6);
}

.stats-grid dt {
  font-size: 0.84rem;
  color: var(--muted);
  margin-bottom: 8px;
}

.stats-grid dd {
  margin: 0;
  font-size: 1.06rem;
  font-weight: 700;
}

.section-label {
  margin: 0 0 12px;
  font-size: 0.78rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
}

.result-summary {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.result-pill {
  padding: 14px 16px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.68);
  border: 1px solid rgba(24, 33, 38, 0.08);
}

.result-pill span {
  display: block;
  font-size: 0.78rem;
  color: var(--muted);
  margin-bottom: 6px;
}

.result-pill strong {
  display: block;
  font-size: 1.08rem;
  font-weight: 700;
}

.event-log,
.code-block,
.finding-list {
  border-radius: 18px;
  background: var(--surface-dark);
  color: #edf4f1;
  padding: 16px;
}

.event-log {
  min-height: 300px;
  max-height: 500px;
  overflow: auto;
}

.event-log:empty::before {
  content: "事件流会从最新状态开始显示在这里。";
  color: rgba(237, 244, 241, 0.45);
}

.event-entry {
  padding: 12px 0;
  border-bottom: 1px solid rgba(237, 244, 241, 0.08);
}

.event-entry:last-child {
  border-bottom: 0;
}

.event-meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: rgba(237, 244, 241, 0.56);
  font-size: 0.8rem;
  margin-bottom: 4px;
}

.event-message {
  line-height: 1.5;
}

.event-message[data-tone="running"] {
  color: #fff0df;
}

.event-message[data-tone="success"] {
  color: #bff3db;
}

.event-message[data-tone="warning"] {
  color: #ffd99a;
}

.event-message[data-tone="failure"] {
  color: #ffb8bb;
}

.finding-list {
  min-height: 120px;
  margin-bottom: 16px;
  background: rgba(255, 250, 240, 0.88);
  color: var(--ink);
}

.finding-list.empty {
  display: flex;
  align-items: center;
  color: var(--muted);
}

.finding-item {
  padding: 12px 0;
  border-bottom: 1px solid rgba(24, 33, 38, 0.08);
}

.finding-item:first-child {
  padding-top: 0;
}

.finding-item:last-child {
  border-bottom: 0;
}

.code-block {
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

.recipe-note {
  margin: -4px 0 14px;
  color: var(--muted);
  line-height: 1.6;
}

@media (max-width: 1100px) {
  .page-shell {
    grid-template-columns: 1fr;
  }

  .workspace {
    grid-template-columns: 1fr;
  }

  .form-panel,
  .status-panel,
  .result-panel,
  .recipe-panel {
    grid-column: auto;
  }
}

@media (max-width: 720px) {
  .workspace,
  .hero-panel {
    padding: 18px;
  }

  .review-form,
  .stats-grid,
  .result-summary {
    grid-template-columns: 1fr;
  }

  .status-hero {
    flex-direction: column;
    align-items: flex-start;
  }

  .progress-meta {
    text-align: left;
  }

  .span-2 {
    grid-column: auto;
  }

  .form-actions {
    flex-direction: column;
  }
}
`;
}

export function dashboardScript(): string {
  return `
const form = document.getElementById('review-form');
const kindField = document.getElementById('kind');
const streamField = document.getElementById('stream');
const submitButton = document.getElementById('submit-button');
const resetButton = document.getElementById('reset-button');
const healthButton = document.getElementById('health-check-button');
const healthBadge = document.getElementById('health-badge');
const modeIndicator = document.getElementById('request-mode-indicator');
const runStatus = document.getElementById('run-status');
const progressBar = document.getElementById('progress-bar');
const requestIdNode = document.getElementById('request-id');
const conclusionNode = document.getElementById('conclusion');
const reviewedFileCountNode = document.getElementById('reviewed-file-count');
const commentCountNode = document.getElementById('comment-count');
const latestStageNode = document.getElementById('latest-stage');
const requestModeLabelNode = document.getElementById('request-mode-label');
const statusNote = document.getElementById('status-note');
const progressLabel = document.getElementById('progress-label');
const summaryConclusionNode = document.getElementById('summary-conclusion');
const summaryCommentsNode = document.getElementById('summary-comments');
const summaryFilesNode = document.getElementById('summary-files');
const eventLog = document.getElementById('event-log');
const rawResult = document.getElementById('raw-result');
const findingList = document.getElementById('finding-list');
const curlPreview = document.getElementById('curl-preview');
const copyCurlButton = document.getElementById('copy-curl-button');
const STORAGE_KEY = 'ai-review-dashboard-form';

function getCommitOnlyFields() {
  return Array.from(document.querySelectorAll('.commit-only'));
}

function setBadge(node, text, tone) {
  node.textContent = text;
  node.className = 'status-badge ' + tone;
}

function setStatusNote(message) {
  statusNote.textContent = message;
}

function setProgress(percent) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  progressBar.style.width = safePercent + '%';
  progressLabel.textContent = safePercent + '%';
}

function normalizeConclusion(conclusion, statusCode) {
  if (statusCode >= 500) return '执行失败';
  if (conclusion === 'failure') return '未通过';
  if (conclusion === 'success') return '通过';
  if (conclusion === 'neutral') return '已完成';
  return '已完成';
}

function getConclusionTone(conclusion, statusCode) {
  if (statusCode >= 500) return 'failure';
  if (conclusion === 'failure') return 'failure';
  if (conclusion === 'success' || conclusion === 'neutral') return 'success';
  return 'warning';
}

function appendEvent(title, message, tone = 'idle') {
  const item = document.createElement('article');
  item.className = 'event-entry';
  item.innerHTML = [
    '<div class="event-meta">',
    '<span>' + escapeHtml(title) + '</span>',
    '<span>' + new Date().toLocaleTimeString() + '</span>',
    '</div>',
    '<div class="event-message" data-tone="' + escapeHtml(tone) + '">' + escapeHtml(message) + '</div>',
  ].join('');
  eventLog.prepend(item);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function updateKindVisibility() {
  const isCommit = kindField.value === 'commit';
  for (const field of getCommitOnlyFields()) {
    field.style.display = isCommit ? 'grid' : 'none';
  }
}

function updateModeLabel() {
  const label = streamField.checked ? '流式模式' : '同步模式';
  modeIndicator.textContent = label;
  requestModeLabelNode.textContent = streamField.checked ? 'NDJSON' : 'JSON';
}

function resetOutput() {
  setBadge(runStatus, '空闲', 'idle');
  setStatusNote('等待发起新的 review 请求');
  requestIdNode.textContent = '-';
  conclusionNode.textContent = '-';
  reviewedFileCountNode.textContent = '0';
  commentCountNode.textContent = '0';
  latestStageNode.textContent = '-';
  summaryConclusionNode.textContent = '-';
  summaryCommentsNode.textContent = '0';
  summaryFilesNode.textContent = '0';
  setProgress(0);
  rawResult.textContent = '等待请求...';
  findingList.className = 'finding-list empty';
  findingList.textContent = '还没有结果';
  eventLog.innerHTML = '';
}

function buildPayload() {
  const formData = new FormData(form);
  const kind = formData.get('kind');
  const payload = {
    kind,
    projectPath: String(formData.get('projectPath') || '').trim(),
  };

  if (kind === 'merge_request') {
    payload.mergeRequestIid = Number(formData.get('mergeRequestIid'));
  } else {
    payload.branch = String(formData.get('branch') || '').trim();
    payload.headSha = String(formData.get('headSha') || '').trim();
    payload.baseSha = String(formData.get('baseSha') || '').trim();
    payload.author = String(formData.get('author') || '').trim();
    payload.title = String(formData.get('title') || '').trim();
    payload.description = String(formData.get('description') || '').trim();
    payload.htmlUrl = String(formData.get('htmlUrl') || '').trim();
  }

  for (const key of Object.keys(payload)) {
    if (payload[key] === '' || Number.isNaN(payload[key])) {
      delete payload[key];
    }
  }

  return payload;
}

function persistFormState() {
  const snapshot = {
    kind: kindField.value,
    stream: streamField.checked,
    projectPath: document.getElementById('projectPath').value,
    reviewToken: document.getElementById('reviewToken').value,
    mergeRequestIid: document.getElementById('mergeRequestIid').value,
    branch: document.getElementById('branch').value,
    headSha: document.getElementById('headSha').value,
    baseSha: document.getElementById('baseSha').value,
    author: document.getElementById('author').value,
    title: document.getElementById('title').value,
    htmlUrl: document.getElementById('htmlUrl').value,
    description: document.getElementById('description').value,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

function restoreFormState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;

  try {
    const snapshot = JSON.parse(raw);
    for (const [key, value] of Object.entries(snapshot)) {
      const field = document.getElementById(key);
      if (!field) continue;
      if (field.type === 'checkbox') {
        field.checked = Boolean(value);
      } else if (typeof value === 'string') {
        field.value = value;
      }
    }
  } catch {}
}

function updateCurlPreview() {
  const payload = buildPayload();
  const token = String(new FormData(form).get('reviewToken') || '').trim() || '<CI_REVIEW_TOKEN>';
  const stream = streamField.checked ? '?stream=1' : '';
  curlPreview.textContent = [
    "curl -X POST 'http://localhost:3000/ci/review" + stream + "'",
    "  -H 'Content-Type: application/json'",
    "  -H 'X-Review-Token: " + token + "'",
    "  -d '" + JSON.stringify(payload, null, 2) + "'",
  ].join('\\n');
}

async function checkHealth() {
  setBadge(healthBadge, '检测中', 'running');
  try {
    const response = await fetch('/healthz');
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const data = await response.json();
    setBadge(healthBadge, data.status === 'ok' ? '在线' : '异常', data.status === 'ok' ? 'success' : 'warning');
    appendEvent('Health', '服务健康检查完成：' + JSON.stringify(data), 'success');
  } catch (error) {
    setBadge(healthBadge, '不可达', 'failure');
    appendEvent('Health', '服务健康检查失败：' + (error instanceof Error ? error.message : String(error)), 'failure');
  }
}

function applyResult(payload) {
  const normalizedConclusion = normalizeConclusion(payload.conclusion, payload.statusCode || 200);
  rawResult.textContent = JSON.stringify(payload, null, 2);
  requestIdNode.textContent = payload.requestId || '-';
  conclusionNode.textContent = normalizedConclusion;
  reviewedFileCountNode.textContent = String(payload.reviewedFileCount ?? 0);
  commentCountNode.textContent = String(payload.commentCount ?? 0);
  latestStageNode.textContent = payload.type || 'result';
  summaryConclusionNode.textContent = normalizedConclusion;
  summaryCommentsNode.textContent = String(payload.commentCount ?? 0);
  summaryFilesNode.textContent = String(payload.reviewedFileCount ?? 0);
  setStatusNote(payload.message || '评审完成');
  setProgress(payload.progress?.percent ?? 100);

  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  if (findings.length === 0) {
    findingList.className = 'finding-list empty';
    findingList.textContent = '本次没有返回 findings 预览';
    return;
  }

  findingList.className = 'finding-list';
  findingList.innerHTML = findings
    .map((finding) => '<div class="finding-item">' + escapeHtml(finding) + '</div>')
    .join('');
}

function applyProgressEvent(event) {
  if (event.requestId) {
    requestIdNode.textContent = event.requestId;
  }

  if (event.progress && typeof event.progress.percent === 'number') {
    setProgress(event.progress.percent);
  }

  latestStageNode.textContent = event.stage || event.type || '-';
  setStatusNote(event.message || 'Review 执行中');

  if (event.stage === 'completed') {
    const tone = getConclusionTone(event.conclusion, 200);
    setBadge(runStatus, normalizeConclusion(event.conclusion, 200), tone);
    conclusionNode.textContent = normalizeConclusion(event.conclusion, 200);
  } else if (event.stage === 'failed') {
    setBadge(runStatus, '执行失败', 'failure');
    conclusionNode.textContent = '执行失败';
  }

  appendEvent(event.stage || event.type || 'progress', event.message || JSON.stringify(event), 'running');
}

async function handleStreamResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('浏览器不支持流式读取');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const payload = JSON.parse(line);
      if (payload.type === 'progress' || payload.type === 'heartbeat' || payload.type === 'accepted') {
        applyProgressEvent(payload);
        continue;
      }

      if (payload.type === 'result') {
        applyResult(payload);
        const normalizedConclusion = normalizeConclusion(payload.conclusion, payload.statusCode || 200);
        const tone = getConclusionTone(payload.conclusion, payload.statusCode || 200);
        setBadge(runStatus, normalizedConclusion, tone);
        appendEvent('result', '评审完成，结论：' + normalizedConclusion, tone);
        continue;
      }

      if (payload.type === 'error') {
        setBadge(runStatus, '执行失败', 'failure');
        conclusionNode.textContent = '执行失败';
        latestStageNode.textContent = 'error';
        setStatusNote(payload.message || '请求失败');
        rawResult.textContent = JSON.stringify(payload, null, 2);
        appendEvent('error', payload.message || '请求失败', 'failure');
      }
    }
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  updateCurlPreview();
  resetOutput();
  setBadge(runStatus, '运行中', 'running');
  setStatusNote('请求已发送，等待服务返回执行进度');
  setProgress(4);
  submitButton.disabled = true;
  appendEvent('request', '已发起 review 请求', 'running');

  try {
    const payload = buildPayload();
    const token = String(new FormData(form).get('reviewToken') || '').trim();
    const stream = streamField.checked;
    const url = stream ? '/ci/review?stream=1' : '/ci/review';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Review-Token': token,
        ...(stream ? { Accept: 'application/x-ndjson' } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (stream) {
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok && !contentType.includes('application/x-ndjson')) {
        const errorPayload = await response.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(errorPayload.error || errorPayload.message || 'Request failed');
      }
      await handleStreamResponse(response);
    } else {
      const data = await response.json();
      applyResult(data);
      const tone = getConclusionTone(data.conclusion, response.status);
      setBadge(runStatus, normalizeConclusion(data.conclusion, response.status), tone);
      appendEvent('result', data.message || '请求完成', tone);
    }
  } catch (error) {
    setBadge(runStatus, '执行失败', 'failure');
    conclusionNode.textContent = '执行失败';
    latestStageNode.textContent = 'error';
    setStatusNote(error instanceof Error ? error.message : String(error));
    rawResult.textContent = String(error instanceof Error ? error.stack || error.message : error);
    appendEvent('error', error instanceof Error ? error.message : String(error), 'failure');
  } finally {
    submitButton.disabled = false;
  }
}

kindField.addEventListener('change', () => {
  updateKindVisibility();
  updateCurlPreview();
});

streamField.addEventListener('change', () => {
  updateModeLabel();
  updateCurlPreview();
});

form.addEventListener('input', () => {
  persistFormState();
  updateCurlPreview();
});
form.addEventListener('submit', handleSubmit);
resetButton.addEventListener('click', resetOutput);
healthButton.addEventListener('click', checkHealth);
copyCurlButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(curlPreview.textContent || '');
    appendEvent('copy', 'curl 命令已复制到剪贴板', 'success');
  } catch (error) {
    appendEvent('copy', error instanceof Error ? error.message : '复制失败', 'warning');
  }
});

restoreFormState();
updateKindVisibility();
updateModeLabel();
updateCurlPreview();
resetOutput();
checkHealth();
`;
}
