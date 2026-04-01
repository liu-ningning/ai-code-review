/**
 * 定义不同文件类型的评审策略。
 *
 * 这个文件不仅负责识别“它是什么文件”，也负责声明“这种文件应该怎么审”：
 * 包括提示词关注点、静态规则组合以及 RAG 上下文抽取预算。
 */
import path from 'node:path';
import type { FileDiff } from '../../types/index.js';

/**
 * 归纳 review 文件在产品层面的类型，用于选择不同的分析策略。
 */
export type ReviewFileKind =
  | 'backend_service'
  | 'backend_module'
  | 'react_component'
  | 'frontend_module'
  | 'ci_pipeline'
  | 'app_config'
  | 'test'
  | 'docs'
  | 'generic';

/**
 * 描述某类文件应该启用的静态检查能力集合。
 */
export interface ReviewFileStaticAnalysisStrategy {
  enableDependencyCycles: boolean;
  eslintRuleIds: string[];
  typedEslintRuleIds: string[];
}

/**
 * 描述某类文件允许注入到提示词中的上下文范围和预算。
 */
export interface ReviewFileRagStrategy {
  allowCodeContext: boolean;
  allowRemoteSymbolSearch: boolean;
  maxRemoteSymbolLookups: number;
  maxSearchResultsPerLookup: number;
  allowTableLookup: boolean;
  maxTableLookups: number;
  maxFunctionContexts: number;
  maxTypeContexts: number;
  maxSemanticSlices: number;
  maxDeletedScopeContexts: number;
}

/**
 * 汇总单个文件的 review 关注点、静态分析开关和 RAG 策略。
 */
export interface ReviewFileStrategy {
  kind: ReviewFileKind;
  label: string;
  focusAreas: string[];
  signalBudget: number;
  codeContextBudget: number;
  tableContextBudget: number;
  preferHunkReview: boolean;
  staticAnalysis: ReviewFileStaticAnalysisStrategy;
  rag: ReviewFileRagStrategy;
}

const JS_CORE_RULE_IDS = [
  'no-async-promise-executor',
  'no-await-in-loop',
  'no-cond-assign',
  'no-constant-binary-expression',
  'no-constructor-return',
  'no-dupe-class-members',
  'no-dupe-else-if',
  'no-dupe-keys',
  'no-duplicate-case',
  'no-new-native-nonconstructor',
  'no-obj-calls',
  'no-promise-executor-return',
  'no-self-assign',
  'no-self-compare',
  'no-unmodified-loop-condition',
  'no-unreachable-loop',
  'use-isnan',
  'valid-typeof',
] as const;

const JS_FRONTEND_RULE_IDS = [
  'no-async-promise-executor',
  'no-cond-assign',
  'no-constant-binary-expression',
  'no-dupe-class-members',
  'no-dupe-else-if',
  'no-dupe-keys',
  'no-duplicate-case',
  'no-obj-calls',
  'no-self-assign',
  'no-self-compare',
  'use-isnan',
  'valid-typeof',
] as const;

const JS_TEST_RULE_IDS = [
  'no-async-promise-executor',
  'no-cond-assign',
  'no-constant-binary-expression',
  'no-obj-calls',
  'no-promise-executor-return',
] as const;

const TYPED_BACKEND_RULE_IDS = [
  '@typescript-eslint/await-thenable',
  '@typescript-eslint/no-base-to-string',
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/no-misused-promises',
  '@typescript-eslint/switch-exhaustiveness-check',
] as const;

const TYPED_FRONTEND_RULE_IDS = [
  '@typescript-eslint/await-thenable',
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/no-misused-promises',
  '@typescript-eslint/switch-exhaustiveness-check',
] as const;

const TYPED_TEST_RULE_IDS = [
  '@typescript-eslint/await-thenable',
  '@typescript-eslint/no-floating-promises',
  '@typescript-eslint/no-misused-promises',
] as const;

/**
 * 预定义的策略字典。
 *
 * 每个条目都同时声明：
 * - 这类文件在产品语义上是什么
 * - review 时要重点关注什么
 * - 静态分析与 RAG 预算应该怎么分配
 */
const STRATEGIES: Record<ReviewFileKind, ReviewFileStrategy> = {
  backend_service: {
    kind: 'backend_service',
    label: '后端服务入口/业务处理代码',
    focusAreas: [
      '优先检查鉴权、输入校验、异常处理、幂等性、事务边界和资源释放。',
      '重点关注数据库写路径、并发竞争、缓存一致性、外部调用失败后的回滚，以及删除保护逻辑后的回归风险。',
      '如果改动涉及 controller、service、route、handler 或 job，要优先判断它会不会直接影响线上请求与任务执行路径。',
    ],
    signalBudget: 760,
    codeContextBudget: 2600,
    tableContextBudget: 2200,
    preferHunkReview: true,
    staticAnalysis: {
      enableDependencyCycles: true,
      eslintRuleIds: [...JS_CORE_RULE_IDS],
      typedEslintRuleIds: [...TYPED_BACKEND_RULE_IDS],
    },
    rag: {
      allowCodeContext: true,
      allowRemoteSymbolSearch: true,
      maxRemoteSymbolLookups: 4,
      maxSearchResultsPerLookup: 6,
      allowTableLookup: true,
      maxTableLookups: 3,
      maxFunctionContexts: 3,
      maxTypeContexts: 3,
      maxSemanticSlices: 3,
      maxDeletedScopeContexts: 3,
    },
  },
  backend_module: {
    kind: 'backend_module',
    label: '后端模块/共享逻辑',
    focusAreas: [
      '优先检查边界条件、错误处理、状态同步和被多个调用方复用时的行为一致性。',
      '重点关注工具函数、领域模型、SDK 封装和数据转换层是否引入隐蔽回归。',
      '如果改动删除了校验、兜底、序列化规则或兼容分支，要优先判断下游受影响范围。',
    ],
    signalBudget: 680,
    codeContextBudget: 2100,
    tableContextBudget: 1400,
    preferHunkReview: true,
    staticAnalysis: {
      enableDependencyCycles: true,
      eslintRuleIds: [...JS_CORE_RULE_IDS],
      typedEslintRuleIds: [...TYPED_BACKEND_RULE_IDS],
    },
    rag: {
      allowCodeContext: true,
      allowRemoteSymbolSearch: true,
      maxRemoteSymbolLookups: 3,
      maxSearchResultsPerLookup: 5,
      allowTableLookup: true,
      maxTableLookups: 1,
      maxFunctionContexts: 2,
      maxTypeContexts: 3,
      maxSemanticSlices: 3,
      maxDeletedScopeContexts: 2,
    },
  },
  react_component: {
    kind: 'react_component',
    label: 'React 组件/页面代码',
    focusAreas: [
      '优先检查 props、状态来源、异步副作用、空态/错误态、受控切换和权限展示逻辑。',
      '重点关注 hooks 依赖、陈旧闭包、条件渲染删除后的空白页风险，以及事件回调里的 Promise 误用。',
      '如果改动直接影响页面组件、弹窗、表单或列表，要优先判断用户是否会看到破损 UI 或错误交互。',
    ],
    signalBudget: 700,
    codeContextBudget: 2500,
    tableContextBudget: 0,
    preferHunkReview: true,
    staticAnalysis: {
      enableDependencyCycles: false,
      eslintRuleIds: [...JS_FRONTEND_RULE_IDS],
      typedEslintRuleIds: [...TYPED_FRONTEND_RULE_IDS],
    },
    rag: {
      allowCodeContext: true,
      allowRemoteSymbolSearch: true,
      maxRemoteSymbolLookups: 3,
      maxSearchResultsPerLookup: 5,
      allowTableLookup: false,
      maxTableLookups: 0,
      maxFunctionContexts: 3,
      maxTypeContexts: 2,
      maxSemanticSlices: 3,
      maxDeletedScopeContexts: 2,
    },
  },
  frontend_module: {
    kind: 'frontend_module',
    label: '前端状态/Hook/客户端模块',
    focusAreas: [
      '优先检查状态流转、数据缓存、客户端容错和浏览器环境依赖是否安全。',
      '重点关注 hooks、store、请求封装和共享 UI 逻辑中的生命周期错位与 Promise 误用。',
      '如果改动删除了判空、fallback、节流防抖或权限过滤，要优先判断前端行为是否会回归。',
    ],
    signalBudget: 640,
    codeContextBudget: 2200,
    tableContextBudget: 0,
    preferHunkReview: true,
    staticAnalysis: {
      enableDependencyCycles: false,
      eslintRuleIds: [...JS_FRONTEND_RULE_IDS],
      typedEslintRuleIds: [...TYPED_FRONTEND_RULE_IDS],
    },
    rag: {
      allowCodeContext: true,
      allowRemoteSymbolSearch: true,
      maxRemoteSymbolLookups: 2,
      maxSearchResultsPerLookup: 4,
      allowTableLookup: false,
      maxTableLookups: 0,
      maxFunctionContexts: 2,
      maxTypeContexts: 2,
      maxSemanticSlices: 2,
      maxDeletedScopeContexts: 2,
    },
  },
  ci_pipeline: {
    kind: 'ci_pipeline',
    label: 'CI/CD 流水线配置',
    focusAreas: [
      '优先检查触发条件、环境变量传递、镜像 tag 选择、手动 gate 和回滚链路是否符合预期。',
      '重点关注 job 依赖、缓存/制品、部署幂等性、凭据暴露风险和会不会把流水线卡成阻塞态。',
      '如果改动删除了校验、保护步骤或回滚入口，要优先判断发布安全性是否下降。',
    ],
    signalBudget: 620,
    codeContextBudget: 900,
    tableContextBudget: 0,
    preferHunkReview: true,
    staticAnalysis: {
      enableDependencyCycles: false,
      eslintRuleIds: [],
      typedEslintRuleIds: [],
    },
    rag: {
      allowCodeContext: false,
      allowRemoteSymbolSearch: false,
      maxRemoteSymbolLookups: 0,
      maxSearchResultsPerLookup: 0,
      allowTableLookup: false,
      maxTableLookups: 0,
      maxFunctionContexts: 0,
      maxTypeContexts: 0,
      maxSemanticSlices: 0,
      maxDeletedScopeContexts: 0,
    },
  },
  app_config: {
    kind: 'app_config',
    label: '应用配置文件',
    focusAreas: [
      '优先检查默认值、环境差异、超时/重试、路径引用、开关项和安全配置是否合理。',
      '重点关注会影响部署、路由、鉴权、缓存、日志或第三方连接行为的参数变化。',
    ],
    signalBudget: 420,
    codeContextBudget: 700,
    tableContextBudget: 0,
    preferHunkReview: false,
    staticAnalysis: {
      enableDependencyCycles: false,
      eslintRuleIds: [],
      typedEslintRuleIds: [],
    },
    rag: {
      allowCodeContext: false,
      allowRemoteSymbolSearch: false,
      maxRemoteSymbolLookups: 0,
      maxSearchResultsPerLookup: 0,
      allowTableLookup: false,
      maxTableLookups: 0,
      maxFunctionContexts: 0,
      maxTypeContexts: 0,
      maxSemanticSlices: 0,
      maxDeletedScopeContexts: 0,
    },
  },
  test: {
    kind: 'test',
    label: '测试代码',
    focusAreas: [
      '优先检查断言是否覆盖真实风险点，而不是只验证实现细节或 happy path。',
      '重点关注并发、权限、空值、异常路径和边界输入是否被测试到。',
      '如果改动只新增样例数据、fixture 或 mock，却没有新增有效断言，要优先指出保护力不足。',
    ],
    signalBudget: 520,
    codeContextBudget: 1500,
    tableContextBudget: 600,
    preferHunkReview: true,
    staticAnalysis: {
      enableDependencyCycles: false,
      eslintRuleIds: [...JS_TEST_RULE_IDS],
      typedEslintRuleIds: [...TYPED_TEST_RULE_IDS],
    },
    rag: {
      allowCodeContext: true,
      allowRemoteSymbolSearch: true,
      maxRemoteSymbolLookups: 2,
      maxSearchResultsPerLookup: 4,
      allowTableLookup: true,
      maxTableLookups: 1,
      maxFunctionContexts: 2,
      maxTypeContexts: 1,
      maxSemanticSlices: 2,
      maxDeletedScopeContexts: 1,
    },
  },
  docs: {
    kind: 'docs',
    label: '文档文件',
    focusAreas: [
      '仅在文档直接影响接入方式、运行步骤、权限配置或发布流程时给出评论。',
      '不要评论措辞、排版、语气或风格类问题。',
    ],
    signalBudget: 260,
    codeContextBudget: 400,
    tableContextBudget: 0,
    preferHunkReview: false,
    staticAnalysis: {
      enableDependencyCycles: false,
      eslintRuleIds: [],
      typedEslintRuleIds: [],
    },
    rag: {
      allowCodeContext: false,
      allowRemoteSymbolSearch: false,
      maxRemoteSymbolLookups: 0,
      maxSearchResultsPerLookup: 0,
      allowTableLookup: false,
      maxTableLookups: 0,
      maxFunctionContexts: 0,
      maxTypeContexts: 0,
      maxSemanticSlices: 0,
      maxDeletedScopeContexts: 0,
    },
  },
  generic: {
    kind: 'generic',
    label: '通用代码',
    focusAreas: [
      '优先检查会影响运行时行为的逻辑缺陷、状态错位、边界条件和错误处理。',
      '如果改动删除了校验、分支、过滤条件或保护逻辑，要优先确认是否会造成回归。',
    ],
    signalBudget: 560,
    codeContextBudget: 1500,
    tableContextBudget: 800,
    preferHunkReview: true,
    staticAnalysis: {
      enableDependencyCycles: false,
      eslintRuleIds: [...JS_FRONTEND_RULE_IDS],
      typedEslintRuleIds: [...TYPED_FRONTEND_RULE_IDS],
    },
    rag: {
      allowCodeContext: true,
      allowRemoteSymbolSearch: true,
      maxRemoteSymbolLookups: 2,
      maxSearchResultsPerLookup: 4,
      allowTableLookup: false,
      maxTableLookups: 0,
      maxFunctionContexts: 2,
      maxTypeContexts: 2,
      maxSemanticSlices: 2,
      maxDeletedScopeContexts: 2,
    },
  },
};

/**
 * 根据仓库内路径、扩展名和 diff 语义线索推断当前文件的最佳评审策略。
 */
export function resolveReviewFileStrategy(filePath: string, diff?: FileDiff): ReviewFileStrategy {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const lowerPath = normalizedPath.toLowerCase();
  const basename = path.posix.basename(lowerPath);
  const extension = path.posix.extname(lowerPath);
  const diffContent = buildDiffText(diff);
  const scriptFile = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(extension);

  // 识别顺序有意从“高特异性”到“低特异性”，
  // 这样能尽量避免普通配置或脚本文件误落到 generic。
  if (isCiPipelineFile(lowerPath, extension, diffContent)) {
    return STRATEGIES.ci_pipeline;
  }

  if (isTestFile(lowerPath)) {
    return STRATEGIES.test;
  }

  if (isDocsFile(extension, basename)) {
    return STRATEGIES.docs;
  }

  if (isAppConfigFile(lowerPath, basename, extension)) {
    return STRATEGIES.app_config;
  }

  if (scriptFile && isReactComponentFile(lowerPath, extension, diffContent)) {
    return STRATEGIES.react_component;
  }

  if (scriptFile && isFrontendModuleFile(lowerPath, diffContent)) {
    return STRATEGIES.frontend_module;
  }

  if (scriptFile && isBackendServiceFile(lowerPath, diffContent)) {
    return STRATEGIES.backend_service;
  }

  if (scriptFile) {
    return STRATEGIES.backend_module;
  }

  return STRATEGIES.generic;
}

/**
 * 把 diff 内容压平成小写文本，便于做轻量语义判断。
 */
function buildDiffText(diff?: FileDiff): string {
  if (!diff) {
    return '';
  }

  return diff.chunks.map((chunk) => chunk.content).join('\n').toLowerCase();
}

/**
 * 判断当前文件是否更像 CI/CD 流水线配置，而不是普通 YAML。
 *
 * 这里除了看固定路径，还会看 diff 内容中的典型流水线关键字，
 * 以覆盖一些非常规命名的 CI 文件。
 */
function isCiPipelineFile(lowerPath: string, extension: string, diffContent: string): boolean {
  if (
    lowerPath === '.gitlab-ci.yml'
    || lowerPath.startsWith('.gitlab/')
    || lowerPath.startsWith('.github/workflows/')
    || lowerPath.startsWith('.circleci/')
    || lowerPath.startsWith('.buildkite/')
    || /(^|\/)(azure-pipelines|bitrise)\.ya?ml$/.test(lowerPath)
  ) {
    return true;
  }

  if (extension !== '.yml' && extension !== '.yaml') {
    return false;
  }

  return [
    'stages:',
    'jobs:',
    'script:',
    'before_script:',
    'after_script:',
    'workflow:',
    'workflow_dispatch',
    'needs:',
    'artifacts:',
    'rules:',
    'only:',
    'except:',
  ].some((token) => diffContent.includes(token));
}

/**
 * 判断当前文件是否为测试或测试支撑目录。
 *
 * 既看目录名，也看 `*.spec.ts` / `*.test.ts` 这种常见命名。
 */
function isTestFile(lowerPath: string): boolean {
  return /(^|\/)(__tests__|tests?|spec|e2e|fixtures?|mocks?)(\/|$)/.test(lowerPath)
    || /\.(spec|test)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lowerPath);
}

/**
 * 判断当前文件是否为文档类文件。
 */
function isDocsFile(extension: string, basename: string): boolean {
  return extension === '.md' || extension === '.mdx' || extension === '.txt' || basename === 'readme';
}

/**
 * 判断当前文件是否为应用配置文件。
 *
 * 这里偏宽松，宁愿把可疑配置识别成 app_config，也不要把它们误判成 generic。
 */
function isAppConfigFile(lowerPath: string, basename: string, extension: string): boolean {
  if (basename === '.env' || basename.startsWith('.env.')) {
    return true;
  }

  if (lowerPath.includes('/.env') || lowerPath.endsWith('/.npmrc') || lowerPath.endsWith('/.yarnrc')) {
    return true;
  }

  return ['.json', '.jsonc', '.toml', '.ini', '.conf', '.properties', '.yml', '.yaml'].includes(extension);
}

/**
 * 判断当前脚本是否更像 React 组件或页面入口。
 *
 * 会综合扩展名、目录路径和 diff 中出现的 React 关键片段。
 */
function isReactComponentFile(lowerPath: string, extension: string, diffContent: string): boolean {
  if (extension === '.tsx' || extension === '.jsx') {
    return true;
  }

  if (/(^|\/)(components?|pages?|views?|screens|layouts)(\/|$)/.test(lowerPath)) {
    return true;
  }

  return [
    "from 'react'",
    'from "react"',
    'usestate(',
    'useeffect(',
    'usememo(',
    'usereducer(',
    '<div',
    '</',
  ].some((token) => diffContent.includes(token));
}

/**
 * 判断当前脚本是否更像前端状态、Hook 或客户端模块。
 *
 * 这类文件通常不是直接渲染组件，但会深度影响前端运行时状态和交互。
 */
function isFrontendModuleFile(lowerPath: string, diffContent: string): boolean {
  if (/(^|\/)(hooks|store|state|client|ui|web)(\/|$)/.test(lowerPath)) {
    return true;
  }

  return [
    'window.',
    'document.',
    'localstorage',
    'sessionstorage',
    'navigator.',
    'queryclient',
    'usequery(',
    'usemutation(',
  ].some((token) => diffContent.includes(token));
}

/**
 * 判断当前脚本是否位于请求处理、任务执行或后端服务入口路径上。
 *
 * 这类文件通常更靠近线上主链路，因此在 scale 和 prompt 上会更保守。
 */
function isBackendServiceFile(lowerPath: string, diffContent: string): boolean {
  if (/(^|\/)(controllers?|services?|routes?|handlers?|api|server|jobs?|workers?|consumers?|repositories?)(\/|$)/.test(lowerPath)) {
    return true;
  }

  return [
    'req,',
    'res,',
    'ctx.',
    'router.',
    'app.get(',
    'app.post(',
    'select ',
    'insert ',
    'update ',
    'delete ',
    'transaction',
  ].some((token) => diffContent.includes(token));
}
