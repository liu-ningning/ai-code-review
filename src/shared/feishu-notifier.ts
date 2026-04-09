import axios from 'axios';
import { ReviewRunResult, SCMType } from '../types/index.js';

interface FeishuNotificationContext {
  requestId: string;
  projectPath: string;
  scmType: SCMType;
  webhookUrl?: string;
}

/**
 * 将一次 review 的最终结果发送到飞书机器人 webhook。
 *
 * 这里按“单次请求可选通知”设计：
 * - 不依赖全局环境变量
 * - 只有当前请求显式传了 webhook 才发送
 * - 发送失败不应反向打断 review 主链
 */
export async function notifyFeishuReviewResult(
  result: ReviewRunResult,
  context: FeishuNotificationContext
): Promise<void> {
  const webhookUrl = normalizeWebhookUrl(context.webhookUrl);
  if (!webhookUrl) {
    return;
  }

  const findings = result.comments.slice(0, 5).map((comment) => {
    const firstLine = comment.body.split('\n')[0]?.trim() || 'AI review finding';
    return `${comment.path}:${comment.line} ${firstLine}`;
  });

  const summaryLines = [
    `请求 ID：${context.requestId}`,
    `代码平台：${context.scmType}`,
    `项目：${context.projectPath}`,
    `评审对象：${result.metadata.displayId}`,
    `标题：${result.metadata.title || '-'}`,
    `结论：${result.conclusion}`,
    `评审文件数：${result.reviewedFileCount}`,
    `评论数：${result.comments.length}`,
    `错误文件数：${result.errorCount}`,
    `输入 Tokens：${result.tokenUsage.promptTokens}`,
    `输出 Tokens：${result.tokenUsage.completionTokens}`,
    `总 Tokens：${result.tokenUsage.totalTokens}`,
    `详情链接：${result.metadata.htmlUrl || '-'}`,
  ];

  if (findings.length > 0) {
    summaryLines.push('', 'Top Findings:');
    for (const finding of findings) {
      summaryLines.push(`- ${finding}`);
    }
  }

  await axios.post(
    webhookUrl,
    {
      msg_type: 'post',
      content: {
        post: {
          zh_cn: {
            title: `AI Review ${result.conclusion.toUpperCase()} - ${context.projectPath}`,
            content: summaryLines.map((line) => [{ tag: 'text', text: `${line}\n` }]),
          },
        },
      },
    },
    {
      timeout: 10_000,
    }
  );
}

/**
 * 发送 review 执行失败通知。
 *
 * 当 pipeline 直接抛错、拿不到 ReviewRunResult 时，仍然给调用方一个最小告警。
 */
export async function notifyFeishuReviewFailure(
  errorMessage: string,
  context: FeishuNotificationContext & {
    reviewKind: 'commit' | 'merge_request';
    reviewDisplay: string;
  }
): Promise<void> {
  const webhookUrl = normalizeWebhookUrl(context.webhookUrl);
  if (!webhookUrl) {
    return;
  }

  const lines = [
    `请求 ID：${context.requestId}`,
    `代码平台：${context.scmType}`,
    `项目：${context.projectPath}`,
    `评审类型：${context.reviewKind}`,
    `评审对象：${context.reviewDisplay}`,
    `执行结果：failed`,
    `错误信息：${errorMessage}`,
  ];

  await axios.post(
    webhookUrl,
    {
      msg_type: 'post',
      content: {
        post: {
          zh_cn: {
            title: `AI Review FAILED - ${context.projectPath}`,
            content: lines.map((line) => [{ tag: 'text', text: `${line}\n` }]),
          },
        },
      },
    },
    {
      timeout: 10_000,
    }
  );
}

function normalizeWebhookUrl(rawValue?: string): string | null {
  if (!rawValue) {
    return null;
  }

  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  if (!/^https?:\/\//i.test(value)) {
    throw new Error('Feishu webhook must be a valid http(s) URL');
  }

  return value;
}
