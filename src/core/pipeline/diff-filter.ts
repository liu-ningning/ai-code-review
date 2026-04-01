/**
 * 提供 review 前的 diff 过滤能力。
 *
 * 这个文件负责在进入后续分析流程前，剔除依赖、构建产物、锁文件、
 * 图片等低价值或不适合 AI review 的变更文件。
 */
import { FileDiff } from '../../types/index.js';
import { isWhitespaceOnlyDiff } from '../review/diff-utils.js';

/**
 * 在 review 主链开始前过滤噪音 diff、超大文件和无需评审的路径。
 */
export class DiffFilter {
  private static readonly IGNORE_PATTERNS = [
    /node_modules\//,
    /dist\//,
    /build\//,
    /coverage\//,
    /\.next\//,
    /storybook-static\//,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /bun\.lockb$/,
    /\.min\.(js|css)$/,
    /\.map$/,
    /\.snap$/,
    /\.pdf$/,
    /\.woff2?$/,
    /\.ttf$/,
    /\.eot$/,
    /\.ico$/,
    /\.mp4$/,
    /\.mp3$/,
    /\.zip$/,
    /\.gz$/,
    /\.png$/,
    /\.jpg$/,
    /\.jpeg$/,
    /\.gif$/,
    /\.svg$/,
  ];
  private static readonly DEPLOYMENT_PATH_PATTERNS = [
    /^\.gitlab-ci\.ya?ml$/,
    /^dockerfile(?:\.[^.]+)?$/,
    /(^|\/)\.gitlab\//,
    /(^|\/)\.github\/workflows\//,
    /(^|\/)\.circleci\//,
    /(^|\/)\.buildkite\//,
    /(^|\/)(deploy|deployment|release|runbook|ops|operation|infra|infrastructure|k8s|kubernetes|helm|charts|terraform|tfvars|manifests)(\/|[.-])/,
    /(^|\/)(docker-compose|compose)\.ya?ml$/,
    /(^|\/)(azure-pipelines|bitrise)\.ya?ml$/,
    /\.tf$/,
    /\.tfvars$/,
  ];

  /**
   * 过滤掉无需进入 review 流程的 diff，只保留有实际内容的可评审文件。
   */
  static filter(diffs: FileDiff[]): FileDiff[] {
    return diffs.filter(diff => {
      const isIgnored = this.IGNORE_PATTERNS.some(pattern => pattern.test(diff.path));
      const hasContent = diff.chunks.length > 0;
      const isWhitespaceOnly = hasContent && isWhitespaceOnlyDiff(diff);
      if (isIgnored || !hasContent || isWhitespaceOnly) {
        return false;
      }

      if (this.isDocumentationFile(diff.path) || this.isDeploymentFile(diff.path)) {
        return false;
      }

      return true;
    });
  }

  /**
   * 判断当前路径是否属于文档文件。
   */
  private static isDocumentationFile(filePath: string): boolean {
    return /\.(md|mdx|txt)$/i.test(filePath);
  }

  /**
   * 判断当前路径是否属于部署、流水线或基础设施文件。
   */
  private static isDeploymentFile(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
    return this.DEPLOYMENT_PATH_PATTERNS.some((pattern) => pattern.test(normalizedPath));
  }
}
