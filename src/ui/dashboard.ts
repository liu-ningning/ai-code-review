export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>AI Review Console</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/antd@5.24.7/dist/reset.css" />
    <link rel="stylesheet" href="/assets/dashboard.css" />
  </head>
  <body>
    <div id="app-root"></div>
    <script crossorigin src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
    <script crossorigin src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
    <script crossorigin src="https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js"></script>
    <script crossorigin src="https://cdn.jsdelivr.net/npm/antd@5.24.7/dist/antd.min.js"></script>
    <script type="module" src="/assets/dashboard.js"></script>
  </body>
</html>`;
}

export function dashboardStyles(): string {
  return `
:root {
  color-scheme: light;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  font-family: Inter, "Segoe UI", sans-serif;
  background:
    radial-gradient(circle at top left, rgba(22, 119, 255, 0.12), transparent 24rem),
    radial-gradient(circle at bottom right, rgba(54, 207, 201, 0.09), transparent 28rem),
    linear-gradient(180deg, #f7faff, #f3f6fb);
  color: #1f2937;
}

#app-root {
  min-height: 100vh;
}

.dashboard-shell {
  min-height: 100vh;
}

.dashboard-sider {
  background:
    radial-gradient(circle at top right, rgba(255, 255, 255, 0.12), transparent 20rem),
    linear-gradient(180deg, #35495d, #2e3e4e 42%, #263341);
  color: #f8fbff;
  box-shadow: inset 0 -1px 0 rgba(255, 255, 255, 0.08);
}

.dashboard-sider .ant-layout-sider-children {
  padding: 20px 16px 16px;
}

.hero-eyebrow {
  margin: 0 0 8px;
  font-weight: 600;
  text-transform: uppercase;
  color: rgba(248, 251, 255, 0.66);
}

.hero-title {
  margin: 0 0 12px;
  color: #ffffff;
  font-size: 30px;
  line-height: 1.05;
  font-weight: 700;
}

.hero-copy {
  margin: 0 0 18px;
  color: rgba(248, 251, 255, 0.78);
  line-height: 1.7;
  text-align: justify;
}

.hero-card {
  background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  padding: 14px;
  backdrop-filter: blur(10px);
  box-shadow: 0 16px 32px rgba(15, 23, 42, 0.14);
}

.hero-card .ant-typography,
.hero-card .ant-list-item,
.hero-card .ant-btn {
  color: #f8fbff;
}

.dashboard-content {
  padding: 18px;
}

.section-card {
  border-radius: 18px;
  box-shadow: 0 18px 48px rgba(15, 23, 42, 0.08);
  border: 1px solid rgba(15, 23, 42, 0.08);
}

.code-block {
  margin: 0;
  padding: 14px;
  border-radius: 12px;
  background: #111827;
  color: #f8fafc;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.55;
  font-family: "SFMono-Regular", Consolas, monospace;
}

.raw-preview {
  max-height: 320px;
}

.finding-item {
  padding: 10px 12px;
  border-radius: 12px;
  background: #fafcff;
  border: 1px solid rgba(22, 119, 255, 0.08);
}

.comment-detail {
  padding: 12px;
  border-radius: 14px;
  background: linear-gradient(180deg, #0f172a, #111827);
  border: 1px solid rgba(148, 163, 184, 0.22);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}

.comment-detail-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}

.comment-detail-body {
  margin: 0;
  color: #e2e8f0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
  font-size: 12px;
  font-family: "SFMono-Regular", Consolas, monospace;
}

.agent-card {
  height: 100%;
  border-radius: 16px;
  border: 1px solid rgba(22, 119, 255, 0.08);
}

.agent-stack {
  width: 100%;
}

.agent-top {
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.04);
}

.agent-middle,
.agent-bottom {
  padding: 12px 14px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid rgba(15, 23, 42, 0.06);
}

.agent-columns {
  width: 100%;
}

.agent-card.running {
  background: linear-gradient(180deg, rgba(230, 244, 255, 0.8), #ffffff);
}

.agent-card.success {
  background: linear-gradient(180deg, rgba(246, 255, 237, 0.88), #ffffff);
}

.agent-card.failure {
  background: linear-gradient(180deg, rgba(255, 242, 240, 0.88), #ffffff);
}

.agent-log-item {
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.04);
}

.event-list .ant-list-item {
  padding: 10px 0;
}

.form-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

@media (max-width: 1100px) {
  .dashboard-content {
    padding: 14px;
  }
}
`;
}

export function dashboardScript(): string {
  return `
const { createElement: h, useEffect, useMemo, useState } = React;
const {
  App: AntApp,
  Alert,
  Badge,
  Button,
  Card,
  Col,
  ConfigProvider,
  Descriptions,
  Divider,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Layout,
  List,
  Progress,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
  message,
  Modal,
} = antd;

const { Sider, Content } = Layout;
const { Title, Paragraph, Text } = Typography;
const STORAGE_KEY = 'ai-review-dashboard-form-v2';

const DEFAULT_FORM = {
  scmType: 'github',
  projectPath: '',
  reviewToken: '',
  stream: true,
  mergeRequestIid: undefined,
};

const INITIAL_RUN = {
  requestId: '-',
  statusText: '空闲',
  statusTone: 'default',
  statusNote: '等待发起新的 review 请求',
  progress: 0,
  latestStage: '-',
  conclusion: '-',
  reviewedFileCount: 0,
  commentCount: 0,
  tokenUsagePrompt: 0,
  tokenUsageCompletion: 0,
  tokenUsageTotal: 0,
  rawResult: '等待请求...',
  findings: [],
  events: [],
  agents: {},
};

function safeJsonParse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function restoreFormState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return { ...DEFAULT_FORM };
  }

  return { ...DEFAULT_FORM, ...safeJsonParse(raw, {}) };
}

function persistFormState(snapshot) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

function normalizeConclusion(conclusion, statusCode) {
  if (statusCode >= 500) return '执行失败';
  if (conclusion === 'failure') return '未通过';
  if (conclusion === 'success') return '通过';
  if (conclusion === 'neutral') return '已完成';
  return '已完成';
}

function conclusionTone(conclusion, statusCode) {
  if (statusCode >= 500) return 'error';
  if (conclusion === 'failure') return 'error';
  if (conclusion === 'success' || conclusion === 'neutral') return 'success';
  return 'processing';
}

function badgeStatusFromTone(tone) {
  if (tone === 'success') return 'success';
  if (tone === 'error') return 'error';
  if (tone === 'processing') return 'processing';
  if (tone === 'warning') return 'warning';
  return 'default';
}

function escapeString(value) {
  return String(value ?? '');
}

function buildPayload(form) {
  const payload = {
    scmType: escapeString(form.scmType).trim() || 'github',
    kind: 'merge_request',
    projectPath: escapeString(form.projectPath).trim(),
    mergeRequestIid: Number(form.mergeRequestIid),
  };

  for (const key of Object.keys(payload)) {
    if (payload[key] === '' || Number.isNaN(payload[key])) {
      delete payload[key];
    }
  }

  return payload;
}

function buildCurl(form) {
  const payload = buildPayload(form);
  const token = escapeString(form.reviewToken).trim() || '<CI_REVIEW_TOKEN>';
  const streamSuffix = form.stream ? '?stream=1' : '';
  return [
    "curl -X POST 'http://localhost:9527/ci/review" + streamSuffix + "'",
    "  -H 'Content-Type: application/json'",
    "  -H 'X-Review-Token: " + token + "'",
    "  -d '" + JSON.stringify(payload, null, 2) + "'",
  ].join('\\n');
}

function appendEvent(state, title, message, tone) {
  const nextEvent = {
    key: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    title,
    message,
    tone,
    timestamp: new Date().toLocaleTimeString(),
  };

  return [nextEvent, ...state].slice(0, 60);
}

function humanizeAgentName(id) {
  const value = String(id || '').toLowerCase();
  if (value === 'correctness') return 'Correctness Agent';
  if (value === 'security') return 'Security Agent';
  if (value === 'regression') return 'Regression Agent';
  return id || 'Reviewer Agent';
}

function updateAgentMap(current, event) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const next = { ...current };

  if (event.stage === 'review_started' && Array.isArray(data.reviewerAgents)) {
    for (const id of data.reviewerAgents) {
      const key = String(id);
      if (!next[key]) {
        next[key] = {
          id: key,
          label: humanizeAgentName(key),
          tone: 'default',
          status: '等待执行',
          currentPath: '-',
          completedSegments: 0,
          commentCount: 0,
          failureCount: 0,
          tokenUsagePrompt: 0,
          tokenUsageCompletion: 0,
          tokenUsageTotal: 0,
          logs: [],
          comments: [],
        };
      }
    }
  }

  const agentId = data.agentId || event.agentId;
  if (!agentId) {
    return next;
  }

  const key = String(agentId);
  const existing = next[key] || {
    id: key,
    label: humanizeAgentName(data.agentLabel || agentId),
    tone: 'default',
    status: '等待执行',
    currentPath: '-',
    completedSegments: 0,
    commentCount: 0,
    failureCount: 0,
    tokenUsagePrompt: 0,
    tokenUsageCompletion: 0,
    tokenUsageTotal: 0,
    logs: [],
    comments: [],
  };

  const updated = { ...existing };
  if (data.agentLabel) {
    updated.label = String(data.agentLabel);
  }
  if (data.path) {
    updated.currentPath = String(data.path);
  }

  if (event.stage === 'agent_review_started') {
    updated.tone = 'processing';
    updated.status = '运行中';
  } else if (event.stage === 'agent_review_completed') {
    updated.tone = 'success';
    updated.status = '已完成';
    updated.completedSegments += 1;
    updated.commentCount += Number(data.agentCommentCount || 0);
    updated.tokenUsagePrompt += Number(data.tokenUsagePrompt || 0);
    updated.tokenUsageCompletion += Number(data.tokenUsageCompletion || 0);
    updated.tokenUsageTotal = updated.tokenUsagePrompt + updated.tokenUsageCompletion;
  } else if (event.stage === 'agent_review_failed') {
    updated.tone = 'error';
    updated.status = '失败';
    updated.failureCount += 1;
  }

  if (event.message) {
    updated.logs = [String(event.message), ...updated.logs].slice(0, 4);
  }

  if (event.stage === 'agent_review_completed' && Array.isArray(data.comments) && data.comments.length > 0) {
    updated.comments = [...data.comments, ...updated.comments].slice(0, 30);
  }

  next[key] = updated;
  return next;
}

function HealthPanel(props) {
  return h(Card, {
    className: 'hero-card',
    bordered: false,
    size: 'small',
    title: h(Text, { style: { color: '#f8fbff' } }, '服务状态'),
    extra: h(Badge, {
      status: badgeStatusFromTone(props.health.tone),
      text: h(Text, { style: { color: '#52c41a' } }, props.health.text),
    }),
  }, h(Space, { direction: 'vertical', size: 12, style: { width: '100%' } }, [
    h(Button, {
      key: 'button',
      block: true,
      size: 'small',
      onClick: props.onCheck,
      style: { color: '#ef4452' },
    }, '检查 /healthz'),
    h(List, {
      key: 'features',
      size: 'small',
      split: false,
      dataSource: [
        '多Agent并行评审',
        '实时NDJSON状态流',
        'Reviewer Agent独立运行面板',
        '结果摘要与Raw输出联动',
      ],
      renderItem: (item) => h(List.Item, { style: { paddingInline: 0, fontSize: 12 } }, item),
    }),
  ]));
}

function AgentBoard(props) {
  const entries = Object.values(props.agents || {});
  if (entries.length === 0) {
    return h(Empty, {
      image: Empty.PRESENTED_IMAGE_SIMPLE,
      description: '多 Agent 运行流会显示在这里',
    });
  }

  return h(Row, { gutter: [12, 12] }, entries.sort((a, b) => a.label.localeCompare(b.label)).map((agent) =>
    h(Col, { key: agent.id, xs: 24, lg: 12, xl: 8 }, h(Card, {
      className: 'agent-card ' + (agent.tone === 'processing' ? 'running' : agent.tone === 'error' ? 'failure' : agent.tone === 'success' ? 'success' : ''),
      hoverable: true,
      size: 'small',
      onClick: () => props.onSelect(agent.id),
    }, h(Space, { direction: 'vertical', size: 12, className: 'agent-stack' }, [
      h('div', { key: 'top', className: 'agent-top' }, h(Space, { direction: 'vertical', size: 10, style: { width: '100%' } }, [
        h(Flex, { key: 'title-row', justify: 'space-between', align: 'center', gap: 12, wrap: true }, [
          h(Space, { key: 'title', size: 8 }, [
            h(Badge, { key: 'badge', status: badgeStatusFromTone(agent.tone) }),
            h(Text, { strong: true }, agent.label),
          ]),
          h(Tag, {
            key: 'status',
            color: agent.tone === 'success' ? 'success' : agent.tone === 'error' ? 'error' : agent.tone === 'processing' ? 'processing' : 'default',
          }, agent.status),
        ]),
        h(Button, {
          key: 'detail',
          block: true,
          size: 'small',
          onClick: (event) => {
            event.stopPropagation();
            props.onSelect(agent.id);
          },
        }, '查看明细'),
      ])),
      h('div', { key: 'middle', className: 'agent-middle' }, h(Descriptions, {
        size: 'small',
        column: 1,
        items: [
          { key: 'path', label: '当前文件', children: agent.currentPath || '-' },
          { key: 'segments', label: '完成段数', children: String(agent.completedSegments) },
          { key: 'comments', label: '评论条数', children: String(agent.commentCount) },
          { key: 'failures', label: '失败次数', children: String(agent.failureCount) },
          { key: 'token-total', label: '总 Tokens', children: String(agent.tokenUsageTotal || 0) },
        ],
      })),
      h('div', { key: 'bottom', className: 'agent-bottom' }, h(List, {
        size: 'small',
        className: 'event-list',
        header: h(Text, { type: 'secondary' }, '最近日志'),
        dataSource: agent.logs,
        locale: { emptyText: '暂无日志' },
        renderItem: (item) => h(List.Item, {}, h('div', { className: 'agent-log-item' }, item)),
      })),
    ])),
  )));
}

function DashboardApp() {
  const [formState, setFormState] = useState(restoreFormState);
  const [runState, setRunState] = useState(INITIAL_RUN);
  const [health, setHealth] = useState({ text: '待检测', tone: 'default' });
  const [submitting, setSubmitting] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState(null);

  useEffect(() => {
    persistFormState(formState);
  }, [formState]);

  useEffect(() => {
    void checkHealth();
  }, []);

  const curlPreview = useMemo(() => buildCurl(formState), [formState]);

  function setField(key, value) {
    setFormState((current) => ({ ...current, [key]: value }));
  }

  async function checkHealth() {
    setHealth({ text: '检测中', tone: 'processing' });
    try {
      const response = await fetch('/healthz');
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }

      const payload = await response.json();
      const next = payload.status === 'ok'
        ? { text: '在线', tone: 'success' }
        : { text: '异常', tone: 'warning' };
      setHealth(next);
      message.success('服务健康检查完成');
    } catch (error) {
      setHealth({ text: '不可达', tone: 'error' });
      message.error(error instanceof Error ? error.message : '服务健康检查失败');
    }
  }

  function resetOutput() {
    setRunState(INITIAL_RUN);
    setSelectedAgentId(null);
  }

  function patchRunState(recipe) {
    setRunState((current) => recipe(current));
  }

  function applyProgressEvent(event) {
    patchRunState((current) => {
      const nextConclusion = event.stage === 'completed'
        ? normalizeConclusion(event.conclusion, 200)
        : event.stage === 'failed'
          ? '执行失败'
          : current.conclusion;
      const nextTone = event.stage === 'completed'
        ? conclusionTone(event.conclusion, 200)
        : event.stage === 'failed'
          ? 'error'
          : 'processing';

      return {
        ...current,
        requestId: event.requestId || current.requestId,
        statusText: event.stage === 'completed'
          ? normalizeConclusion(event.conclusion, 200)
          : event.stage === 'failed'
            ? '执行失败'
            : '运行中',
        statusTone: nextTone,
        statusNote: event.message || current.statusNote,
        progress: event.progress && typeof event.progress.percent === 'number'
          ? event.progress.percent
          : current.progress,
        latestStage: event.stage || event.type || current.latestStage,
        conclusion: nextConclusion,
        reviewedFileCount: Number(event.data && event.data.reviewedFileCount) || current.reviewedFileCount,
        commentCount: Number(event.data && event.data.commentCount) || current.commentCount,
        tokenUsagePrompt: Number(event.data && event.data.tokenUsagePrompt) || current.tokenUsagePrompt,
        tokenUsageCompletion: Number(event.data && event.data.tokenUsageCompletion) || current.tokenUsageCompletion,
        tokenUsageTotal: Number(event.data && event.data.tokenUsageTotal) || current.tokenUsageTotal,
        events: appendEvent(
          current.events,
          event.stage || event.type || 'progress',
          event.message || JSON.stringify(event),
          nextTone
        ),
        agents: updateAgentMap(current.agents, event),
      };
    });
  }

  function applyResult(payload, statusCode) {
    const normalized = normalizeConclusion(payload.conclusion, statusCode || 200);
    const tone = conclusionTone(payload.conclusion, statusCode || 200);

    patchRunState((current) => {
      const nextAgents = { ...current.agents };
      for (const key of Object.keys(nextAgents)) {
        if (nextAgents[key].tone === 'processing' || nextAgents[key].tone === 'default') {
          nextAgents[key] = {
            ...nextAgents[key],
            tone: tone,
            status: '执行结束',
          };
        }
      }

      return {
        ...current,
        requestId: payload.requestId || current.requestId,
        statusText: normalized,
        statusTone: tone,
        statusNote: payload.message || '评审完成',
        progress: payload.progress && typeof payload.progress.percent === 'number' ? payload.progress.percent : 100,
        latestStage: payload.type || 'result',
        conclusion: normalized,
        reviewedFileCount: payload.reviewedFileCount ?? 0,
        commentCount: payload.commentCount ?? 0,
        tokenUsagePrompt: payload.tokenUsagePrompt ?? 0,
        tokenUsageCompletion: payload.tokenUsageCompletion ?? 0,
        tokenUsageTotal: payload.tokenUsageTotal ?? 0,
        rawResult: JSON.stringify(payload, null, 2),
        findings: Array.isArray(payload.findings) ? payload.findings : [],
        events: appendEvent(current.events, 'result', payload.message || '评审完成', tone),
        agents: nextAgents,
      };
    });

    if (Array.isArray(payload.comments)) {
      patchRunState((current) => {
        const enrichedAgents = { ...current.agents };
        for (const comment of payload.comments) {
          if (!comment.agentId) {
            continue;
          }

          const key = String(comment.agentId);
          const existing = enrichedAgents[key] || {
            id: key,
            label: comment.agentLabel || humanizeAgentName(key),
            tone,
            status: '执行结束',
            currentPath: comment.path,
            completedSegments: 0,
            commentCount: 0,
            failureCount: 0,
            tokenUsagePrompt: 0,
            tokenUsageCompletion: 0,
            tokenUsageTotal: 0,
            logs: [],
            comments: [],
          };

          enrichedAgents[key] = {
            ...existing,
            label: comment.agentLabel || existing.label,
            comments: [...existing.comments, comment].slice(0, 50),
            commentCount: Math.max(existing.commentCount, [...existing.comments, comment].length),
          };
        }

        return {
          ...current,
          agents: enrichedAgents,
        };
      });
    }
  }

  async function handleStreamResponse(response) {
    const reader = response.body && response.body.getReader ? response.body.getReader() : null;
    if (!reader) {
      throw new Error('浏览器不支持流式读取');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
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
          applyResult(payload, payload.statusCode || 200);
          message.success('评审完成：' + normalizeConclusion(payload.conclusion, payload.statusCode || 200));
          continue;
        }

        if (payload.type === 'error') {
          patchRunState((current) => ({
            ...current,
            statusText: '执行失败',
            statusTone: 'error',
            statusNote: payload.message || '请求失败',
            latestStage: 'error',
            rawResult: JSON.stringify(payload, null, 2),
            events: appendEvent(current.events, 'error', payload.message || '请求失败', 'error'),
          }));
          message.error(payload.message || '请求失败');
        }
      }
    }
  }

  async function handleSubmit() {
    resetOutput();
    setSubmitting(true);
    patchRunState((current) => ({
      ...current,
      statusText: '运行中',
      statusTone: 'processing',
      statusNote: '请求已发送，等待服务返回执行进度',
      progress: 4,
      events: appendEvent(current.events, 'request', '已发起 review 请求', 'processing'),
    }));

    try {
      const payload = buildPayload(formState);
      const token = escapeString(formState.reviewToken).trim();
      const url = formState.stream ? '/ci/review?stream=1' : '/ci/review';
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Review-Token': token,
          ...(formState.stream ? { Accept: 'application/x-ndjson' } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (formState.stream) {
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok && !contentType.includes('application/x-ndjson')) {
          const errorPayload = await response.json().catch(() => ({ error: 'Request failed' }));
          throw new Error(errorPayload.error || errorPayload.message || 'Request failed');
        }
        await handleStreamResponse(response);
      } else {
        const data = await response.json();
        applyResult(data, response.status);
        if (response.status >= 500) {
          message.error(data.message || '请求失败');
        } else {
          message.success(data.message || '请求完成');
        }
      }
    } catch (error) {
      patchRunState((current) => ({
        ...current,
        statusText: '执行失败',
        statusTone: 'error',
        statusNote: error instanceof Error ? error.message : String(error),
        latestStage: 'error',
        rawResult: error instanceof Error ? error.stack || error.message : String(error),
        events: appendEvent(current.events, 'error', error instanceof Error ? error.message : String(error), 'error'),
      }));
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
    }
  }

  function openRawModal() {
    Modal.info({
      title: 'Raw Result',
      width: 960,
      content: h('pre', { className: 'code-block', style: { maxHeight: '60vh' } }, runState.rawResult || '等待请求...'),
    });
  }

  async function copyCurl() {
    try {
      await navigator.clipboard.writeText(curlPreview);
      message.success('curl 命令已复制到剪贴板');
    } catch (error) {
      message.warning(error instanceof Error ? error.message : '复制失败');
    }
  }

  const topStats = [
    { key: 'requestId', label: 'Request ID', value: runState.requestId },
    { key: 'conclusion', label: '结论', value: runState.conclusion },
    { key: 'latestStage', label: '最近阶段', value: runState.latestStage },
    { key: 'mode', label: '运行模式', value: formState.stream ? 'NDJSON' : 'JSON' },
    { key: 'reviewedFileCount', label: '评审文件', value: String(runState.reviewedFileCount) },
    { key: 'commentCount', label: '评论数量', value: String(runState.commentCount) },
    { key: 'tokenUsageTotal', label: '总 Tokens', value: String(runState.tokenUsageTotal) },
    { key: 'tokenUsagePrompt', label: '输入 Tokens', value: String(runState.tokenUsagePrompt) },
    { key: 'tokenUsageCompletion', label: '输出 Tokens', value: String(runState.tokenUsageCompletion) },
  ];
  const selectedAgent = selectedAgentId ? runState.agents[selectedAgentId] : null;

  return h(Layout, { className: 'dashboard-shell' }, [
    h(Sider, {
      key: 'sider',
      breakpoint: 'lg',
      collapsedWidth: 0,
      width: 200,
      className: 'dashboard-sider',
    }, h(Space, { direction: 'vertical', size: 16, style: { width: '100%' } }, [
      h('div', { key: 'intro' }, [
        h('h2', { className: 'hero-eyebrow' }, 'AI REVIEW CODE'),
        h('p', { className: 'hero-copy' }, '发起 review、观察多 Agent 运行流，并查看结果摘要与原始输出。'),
        h(Space, { wrap: true }, [
          h(Tag, { key: 'gh', color: 'blue' }, 'GitHub / GitLab'),
          h(Tag, { key: 'ndjson', color: 'cyan' }, 'NDJSON Stream'),
          h(Tag, { key: 'agent', color: 'geekblue' }, 'Multi Agent'),
        ]),
      ]),
      h(HealthPanel, { key: 'health', health, onCheck: checkHealth }),
    ])),
    h(Content, { key: 'content', className: 'dashboard-content' }, h(Space, {
      direction: 'vertical',
      size: 16,
      style: { width: '100%' },
    }, [
      h(Row, { key: 'top-layout', gutter: [16, 16] }, [
        h(Col, { xs: 24, xl: 12 }, h(Card, {
          key: 'form',
          className: 'section-card',
          size: 'small',
          title: '发起一次评审',
          extra: h(Space, { size: 8 }, [
            h(Tag, { key: 'scm', color: formState.scmType === 'github' ? 'geekblue' : 'orange' }, formState.scmType === 'github' ? 'GitHub' : 'GitLab'),
            h(Tag, { key: 'mode', color: formState.stream ? 'processing' : 'default' }, formState.stream ? '流式模式' : '同步模式'),
          ]),
        }, h(Form, {
          layout: 'vertical',
          size: 'small',
          onFinish: handleSubmit,
        }, [
          h(Form.Item, { key: 'scm-type', label: '代码平台' }, h(Select, {
            value: formState.scmType,
            options: [
              { label: 'GitHub', value: 'github' },
              { label: 'GitLab', value: 'gitlab' },
            ],
            onChange: (value) => setField('scmType', value),
          })),
          h(Form.Item, { key: 'kind-fixed', label: 'Review 类型' }, h(Input, {
            value: 'merge_request',
            readOnly: true,
          })),
          h(Form.Item, { key: 'project-path', label: '项目路径' }, h(Input, {
            value: formState.projectPath,
            placeholder: formState.scmType === 'github' ? 'owner/repo' : 'group/project',
            onChange: (event) => setField('projectPath', event.target.value),
          })),
          h(Form.Item, { key: 'mr-number', label: 'PR / MR 编号' }, h(InputNumber, {
            style: { width: '100%' },
            value: formState.mergeRequestIid,
            min: 1,
            placeholder: '123',
            onChange: (value) => setField('mergeRequestIid', value),
          })),
          h(Form.Item, { key: 'review-token', label: 'Review Token' }, h(Input.Password, {
            value: formState.reviewToken,
            placeholder: 'CI_REVIEW_TOKEN',
            onChange: (event) => setField('reviewToken', event.target.value),
          })),
          h(Form.Item, { key: 'stream-switch', label: '流式返回' }, h(Card, {
            size: 'small',
            bordered: false,
            style: { background: '#fafcff' },
          }, h(Flex, { gap: 10, align: 'center', justify: 'space-between' }, [
            h(Text, { type: 'secondary' }, formState.stream ? '启用 NDJSON 进度' : '同步 JSON 返回'),
            h(Switch, {
              checked: formState.stream,
              onChange: (checked) => setField('stream', checked),
            }),
          ]))),
          h(Flex, { key: 'actions', gap: 10, justify: 'space-between', className: 'form-toolbar' }, [
            h(Space, { key: 'left' }, [
              h(Button, {
                key: 'submit',
                type: 'primary',
                htmlType: 'submit',
                loading: submitting,
              }, '开始评审'),
              h(Button, {
                key: 'reset',
                onClick: resetOutput,
              }, '重置结果'),
            ]),
            h(Text, { key: 'hint', type: 'secondary' }, '当前面板仅保留 merge_request 评审入口。'),
          ]),
        ]))),
        h(Col, { xs: 24, xl: 12 }, h(Card, {
          key: 'status',
          className: 'section-card',
          size: 'small',
          title: '执行进度',
          extra: h(Badge, {
            status: badgeStatusFromTone(runState.statusTone),
            text: runState.statusText,
          }),
        }, h(Space, { direction: 'vertical', size: 14, style: { width: '100%' } }, [
          h(Flex, { key: 'hero', justify: 'space-between', align: 'center' }, [
            h('div', { key: 'note' }, [
              h(Text, { type: 'secondary' }, '当前状态'),
              h(Paragraph, { style: { margin: '4px 0 0', fontSize: 15, fontWeight: 600 } }, runState.statusNote),
            ]),
            h('div', { key: 'progress' }, [
              h(Text, { type: 'secondary' }, '进度'),
              h(Title, { level: 4, style: { margin: '4px 0 0', textAlign: 'right' } }, String(runState.progress) + '%'),
            ]),
          ]),
          h(Progress, {
            key: 'bar',
            percent: runState.progress,
            size: [0, 12],
            showInfo: false,
            status: runState.statusTone === 'error' ? 'exception' : runState.statusTone === 'success' ? 'success' : 'active',
          }),
          h(Descriptions, {
            key: 'stats',
            size: 'small',
            bordered: true,
            column: 1,
            items: topStats.map((item) => ({ key: item.key, label: item.label, children: item.value })),
          }),
        ]))),
      ]),
      h(Row, { key: 'workspace', gutter: [16, 16] }, [
        h(Col, { xs: 24, xl: 24 }, h(Card, {
          key: 'agents',
          className: 'section-card',
          size: 'small',
          title: 'Agent 实时运行流',
        }, h(AgentBoard, { agents: runState.agents, onSelect: setSelectedAgentId }))),
        h(Col, { xs: 24, xl: 12 }, h(Space, { direction: 'vertical', size: 16, style: { width: '100%' } }, [
          h(Card, {
            key: 'events',
            className: 'section-card',
            size: 'small',
            title: '事件时间线',
          }, h(List, {
            size: 'small',
            className: 'event-list',
            locale: { emptyText: '事件流会从最新状态开始显示在这里。' },
            dataSource: runState.events,
            renderItem: (item) => h(List.Item, {
              actions: [h(Tag, {
                key: 'tag',
                color: item.tone === 'success' ? 'success' : item.tone === 'error' ? 'error' : item.tone === 'warning' ? 'warning' : 'processing',
              }, item.timestamp)],
            }, h(List.Item.Meta, {
              title: h(Text, { strong: true }, item.title),
              description: item.message,
            })),
          })),
        ])),
        h(Col, { xs: 24, xl: 12 }, h(Space, { direction: 'vertical', size: 16, style: { width: '100%' } }, [
          h(Card, {
            key: 'result',
            className: 'section-card',
            size: 'small',
            title: '响应结果',
            extra: h(Button, { onClick: openRawModal }, '弹窗查看 Raw'),
          }, h(Space, { direction: 'vertical', size: 14, style: { width: '100%' } }, [
            h(Row, { key: 'pills', gutter: 12 }, [
              h(Col, { xs: 12, md: 8 }, h(Card, { size: 'small', bordered: false }, [
                h(Text, { type: 'secondary' }, '结论'),
                h(Title, { level: 5, style: { margin: '4px 0 0' } }, runState.conclusion),
              ])),
              h(Col, { xs: 12, md: 8 }, h(Card, { size: 'small', bordered: false }, [
                h(Text, { type: 'secondary' }, '评论'),
                h(Title, { level: 5, style: { margin: '4px 0 0' } }, String(runState.commentCount)),
              ])),
              h(Col, { xs: 12, md: 8 }, h(Card, { size: 'small', bordered: false }, [
                h(Text, { type: 'secondary' }, '文件'),
                h(Title, { level: 5, style: { margin: '4px 0 0' } }, String(runState.reviewedFileCount)),
              ])),
              h(Col, { xs: 12, md: 8 }, h(Card, { size: 'small', bordered: false }, [
                h(Text, { type: 'secondary' }, '输入 Tokens'),
                h(Title, { level: 5, style: { margin: '4px 0 0' } }, String(runState.tokenUsagePrompt)),
              ])),
              h(Col, { xs: 12, md: 8 }, h(Card, { size: 'small', bordered: false }, [
                h(Text, { type: 'secondary' }, '输出 Tokens'),
                h(Title, { level: 5, style: { margin: '4px 0 0' } }, String(runState.tokenUsageCompletion)),
              ])),
              h(Col, { xs: 12, md: 8 }, h(Card, { size: 'small', bordered: false }, [
                h(Text, { type: 'secondary' }, '总 Tokens'),
                h(Title, { level: 5, style: { margin: '4px 0 0' } }, String(runState.tokenUsageTotal)),
              ])),
            ]),
            h(Divider, { key: 'divider', style: { margin: '4px 0' } }),
            runState.findings.length === 0
              ? h(Empty, { key: 'empty-findings', image: Empty.PRESENTED_IMAGE_SIMPLE, description: '本次没有返回 findings 预览' })
              : h(List, {
                  key: 'findings',
                  size: 'small',
                  dataSource: runState.findings,
                  renderItem: (item) => h(List.Item, {}, h('div', { className: 'finding-item' }, item)),
                }),
            h('pre', {
              key: 'raw',
              className: 'code-block raw-preview',
              onDoubleClick: openRawModal,
            }, runState.rawResult),
          ])),
          h(Card, {
            key: 'recipe',
            className: 'section-card',
            size: 'small',
            title: '请求样例',
            extra: h(Button, { onClick: copyCurl }, '复制命令'),
          }, h(Space, { direction: 'vertical', size: 12, style: { width: '100%' } }, [
            h(Alert, {
              key: 'note',
              type: 'info',
              showIcon: true,
              message: '切换表单字段后会实时更新，适合直接粘贴到终端验证。',
            }),
            h('pre', { key: 'curl', className: 'code-block' }, curlPreview),
          ])),
        ])),
      ]),
      h(Drawer, {
        key: 'agent-drawer',
        open: Boolean(selectedAgent),
        width: 520,
        title: selectedAgent ? selectedAgent.label + ' 明细' : 'Agent 明细',
        onClose: () => setSelectedAgentId(null),
      }, selectedAgent ? h(Space, { direction: 'vertical', size: 16, style: { width: '100%' } }, [
        h(Descriptions, {
          key: 'agent-overview',
          size: 'small',
          bordered: true,
          column: 1,
          items: [
            { key: 'status', label: '当前状态', children: selectedAgent.status },
            { key: 'path', label: '当前文件', children: selectedAgent.currentPath || '-' },
            { key: 'segments', label: '完成段数', children: String(selectedAgent.completedSegments) },
            { key: 'comments', label: '评论条数', children: String(selectedAgent.commentCount) },
            { key: 'failures', label: '失败次数', children: String(selectedAgent.failureCount) },
            { key: 'token-prompt', label: '输入 Tokens', children: String(selectedAgent.tokenUsagePrompt || 0) },
            { key: 'token-completion', label: '输出 Tokens', children: String(selectedAgent.tokenUsageCompletion || 0) },
            { key: 'token-total', label: '总 Tokens', children: String(selectedAgent.tokenUsageTotal || 0) },
          ],
        }),
        h(Card, {
          key: 'comment-card',
          size: 'small',
          title: '评论明细',
        }, selectedAgent.comments && selectedAgent.comments.length > 0
          ? h(List, {
              size: 'small',
              dataSource: selectedAgent.comments,
              renderItem: (item) => h(List.Item, {}, h(Space, { direction: 'vertical', size: 6, style: { width: '100%' } }, [
                h('div', { key: 'body', className: 'comment-detail' }, [
                  h('div', { key: 'meta', className: 'comment-detail-meta' }, [
                    h(Tag, { key: 'path', color: 'blue' }, item.path + ':' + item.line),
                    h(Tag, { key: 'side' }, item.side || 'RIGHT'),
                    item.agentLabel
                      ? h(Tag, { key: 'agent', color: 'geekblue' }, item.agentLabel)
                      : null,
                  ].filter(Boolean)),
                  h('pre', { key: 'text', className: 'comment-detail-body' }, item.body),
                ]),
              ])),
            })
          : h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: '该 Agent 暂无评论明细' })),
        h(Card, {
          key: 'log-card',
          size: 'small',
          title: '运行日志',
        }, selectedAgent.logs && selectedAgent.logs.length > 0
          ? h(List, {
              size: 'small',
              dataSource: selectedAgent.logs,
              renderItem: (item) => h(List.Item, {}, h('div', { className: 'agent-log-item' }, item)),
            })
          : h(Empty, { image: Empty.PRESENTED_IMAGE_SIMPLE, description: '该 Agent 暂无运行日志' })),
      ]) : null),
    ])),
  ]);
}

const root = ReactDOM.createRoot(document.getElementById('app-root'));

root.render(
  h(ConfigProvider, {
    componentSize: 'small',
    theme: {
      token: {
        colorPrimary: '#1677ff',
        borderRadius: 14,
        colorBgLayout: '#f5f7fb',
      },
    },
  }, h(AntApp, null, h(DashboardApp)))
);
`;
}
