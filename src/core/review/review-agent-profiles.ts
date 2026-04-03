/**
 * 定义多 reviewer agent 的角色配置。
 *
 * 这些 agent 共享同一个基础模型，但通过不同的关注面和提示词约束，
 * 让一次 review 从多个视角并行审查同一段代码。
 */
export interface ReviewAgentProfile {
  id: 'correctness' | 'security' | 'regression';
  label: string;
  focus: string;
  instructions: string[];
}

const AGENT_PROFILES: Record<ReviewAgentProfile['id'], ReviewAgentProfile> = {
  correctness: {
    id: 'correctness',
    label: 'Correctness Agent',
    focus: '重点检查运行时正确性、边界条件、异常处理、状态更新与副作用是否一致。',
    instructions: [
      '优先关注真实会导致错误结果、状态错乱、异常漏处理或接口契约不一致的问题。',
      '如果变更涉及分支、返回值、异步流程或状态写入，优先判断是否存在遗漏路径。',
    ],
  },
  security: {
    id: 'security',
    label: 'Security Agent',
    focus: '重点检查鉴权、输入校验、注入、敏感信息暴露和不安全配置放宽。',
    instructions: [
      '只输出高置信度安全问题，不要把普通代码味道包装成安全风险。',
      '如果改动涉及权限判断、请求参数、模板渲染、重定向或配置开关，优先审查攻击面变化。',
    ],
  },
  regression: {
    id: 'regression',
    label: 'Regression Agent',
    focus: '重点检查删除旧逻辑、条件放宽、兼容性变化和多文件联动带来的回归风险。',
    instructions: [
      '优先关注被删除的判断、过滤条件、保护分支、兼容处理或回滚路径。',
      '如果当前变更依赖外部符号或跨文件契约，优先判断调用方是否会被破坏。',
    ],
  },
};

/**
 * 根据配置解析启用的 reviewer agent 列表。
 */
export function resolveReviewAgentProfiles(rawValue?: string): ReviewAgentProfile[] {
  const requestedIds = String(rawValue ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  const normalizedIds = requestedIds.length > 0
    ? requestedIds
    : ['correctness', 'security', 'regression'];
  const resolved: ReviewAgentProfile[] = [];
  const seen = new Set<string>();

  for (const candidateId of normalizedIds) {
    if (seen.has(candidateId)) {
      continue;
    }

    const profile = AGENT_PROFILES[candidateId as ReviewAgentProfile['id']];
    if (!profile) {
      continue;
    }

    seen.add(candidateId);
    resolved.push(profile);
  }

  return resolved.length > 0 ? resolved : [AGENT_PROFILES.correctness];
}
