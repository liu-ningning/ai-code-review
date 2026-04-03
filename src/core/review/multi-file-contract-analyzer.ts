/**
 * 提供跨文件导出契约与调用方协同迁移的静态校验。
 *
 * 这个文件负责识别“导出符号变了，但调用方没跟上”的问题，
 * 补足单文件 review 和改动簇提示之间的空白。
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Node as TsMorphNode, Project, SourceFile, SyntaxKind } from 'ts-morph';
import {
  FileDiff,
  ISCMProvider,
  ReviewSignal,
  StaticReviewFinding,
} from '../../types/index.js';
import { getErrorMessage, getErrorStderr, getErrorStdout } from '../../shared/error-utils.js';
import { logger } from '../../shared/logger.js';
import { LocalImportResolver } from './local-import-resolver.js';
import { isAnalyzableScriptPath, normalizeRepoPath } from './script-file-utils.js';

const execFileAsync = promisify(execFile);

/**
 * 聚合多文件契约分析输出的 findings 与 signals。
 */
export interface ContractAnalysisResult {
  findingsByPath: Map<string, StaticReviewFinding[]>;
  signalsByPath: Map<string, ReviewSignal[]>;
}

interface ExportContract {
  name: string;
  kind: 'function' | 'class' | 'type' | 'value';
  line: number;
  signatureText: string;
  requiredParamCount: number | null;
  totalParamCount: number | null;
  hasRestParameter: boolean;
}

interface ContractChange {
  symbolName: string;
  changeType: 'removed' | 'signature_changed' | 'kind_changed';
  line: number;
  current?: ExportContract;
  previous?: ExportContract;
}

interface ImportBindingUsage {
  modulePath: string;
  symbolName?: string;
  localName: string;
  line: number;
  namespaceImport?: boolean;
  memberName?: string;
}

interface ReExportBindingTarget {
  modulePath: string;
  symbolName: string;
  exportedName: string;
  exportPath: string[];
}

/**
 * 基于当前 diff 和基线版本，对多文件契约变更进行定向校验。
 */
export class MultiFileContractAnalyzer {
  private readonly project = new Project({ useInMemoryFileSystem: true });
  private analysisCheckoutRoot = '';
  private analysisOwner = '';
  private analysisRepo = '';
  private analysisBaselineRef = '';
  private analysisImportResolver: LocalImportResolver | null = null;
  private analysisKnownModulePaths = new Set<string>();
  private readonly headFileContentCache = new Map<string, Promise<string>>();
  private readonly baselineFileContentCache = new Map<string, Promise<string>>();
  private readonly exportContractCache = new Map<string, Promise<Map<string, ExportContract>>>();
  private readonly reExportTargetCache = new Map<string, Promise<ReExportBindingTarget[]>>();

  /**
   * 创建多文件契约分析器，并绑定 SCM provider 以读取基线版本文件。
   */
  constructor(private readonly scmProvider: ISCMProvider) { }

  /**
   * 分析脚本文件导出契约的变更，并检查改动中的调用方是否已经同步迁移。
   */
  async analyze(
    checkoutRoot: string,
    owner: string,
    repo: string,
    diffs: FileDiff[],
    baselineRef?: string
  ): Promise<ContractAnalysisResult> {
    const analyzableDiffs = diffs.filter((diff) => isAnalyzableScriptPath(diff.path) || Boolean(diff.oldPath && isAnalyzableScriptPath(diff.oldPath)));
    if (analyzableDiffs.length <= 1 || !baselineRef) {
      return {
        findingsByPath: new Map(),
        signalsByPath: new Map(),
      };
    }

    const changedPaths = new Set<string>();
    const headSourceFiles = new Map<string, SourceFile>();
    const importUsagesByPath = new Map<string, ImportBindingUsage[]>();
    const contractChangesByModule = new Map<string, ContractChange[]>();
    const searchCache = new Map<string, string[]>();
    const findings: StaticReviewFinding[] = [];
    const signalsByPath = new Map<string, ReviewSignal[]>();
    const importResolver = new LocalImportResolver(
      checkoutRoot,
      `${owner}/${repo}:${baselineRef}:contract`
    );

    await importResolver.initialize();

    for (const diff of analyzableDiffs) {
      changedPaths.add(normalizeRepoPath(diff.path));
      if (diff.oldPath) {
        changedPaths.add(normalizeRepoPath(diff.oldPath));
      }
    }

    this.prepareAnalysisState(checkoutRoot, owner, repo, baselineRef, importResolver, changedPaths);

    try {
      for (const diff of analyzableDiffs) {
        const currentPath = normalizeRepoPath(diff.path);
        const previousPath = normalizeRepoPath(diff.oldPath || diff.path);
        const headContent = diff.status === 'deleted'
          ? ''
          : await this.loadHeadFileContent(currentPath);
        const baseContent = diff.status === 'added'
          ? ''
          : await this.loadBaselineFileContent(previousPath);

        const currentExports = headContent ? this.extractExportContracts(currentPath, headContent) : new Map<string, ExportContract>();
        const previousExports = baseContent ? this.extractExportContracts(previousPath, baseContent) : new Map<string, ExportContract>();
        const contractChanges = this.compareContracts(previousExports, currentExports);

        if (contractChanges.length > 0) {
          contractChangesByModule.set(currentPath, contractChanges);
        }

        if (headContent) {
          const sourceFile = this.project.createSourceFile(currentPath, headContent, { overwrite: true });
          headSourceFiles.set(currentPath, sourceFile);
          importUsagesByPath.set(
            currentPath,
            await this.extractImportBindings(currentPath, sourceFile, changedPaths, importResolver)
          );
        }
      }

      for (const [modulePath, changes] of contractChangesByModule.entries()) {
        const importConsumers = Array.from(importUsagesByPath.entries()).filter(([, usages]) => (
          usages.some((usage) => usage.modulePath === modulePath)
        ));

        for (const change of changes) {
          this.pushSignal(signalsByPath, modulePath, {
            source: 'contract',
            line: change.line,
            summary: this.buildExporterSignalSummary(change),
          });

          for (const [consumerPath, usages] of importConsumers) {
            const matchingUsages = usages.filter((usage) => (
              usage.modulePath === modulePath
              && (usage.symbolName === undefined || usage.symbolName === change.symbolName)
            ));
            if (matchingUsages.length === 0) {
              continue;
            }

            if (change.changeType === 'removed') {
              for (const usage of matchingUsages) {
                findings.push({
                  source: 'contract',
                  ruleId: 'contract-export-removed',
                  severity: 'error',
                  path: consumerPath,
                  line: usage.line,
                  side: 'RIGHT',
                  body: `**[跨文件契约漂移]** \`${modulePath}\` 已移除导出 \`${change.symbolName}\`，但当前文件仍在导入它。这样合并后会直接导致模块加载失败或运行时报错。建议同步迁移调用方，或在导出侧保留兼容层。`,
                });
              }
              continue;
            }

            const consumerSourceFile = headSourceFiles.get(consumerPath);
            if (!consumerSourceFile || !change.current) {
              continue;
            }

            if (change.changeType === 'signature_changed') {
              for (const usage of matchingUsages) {
                const callMismatches = this.findCallArityMismatches(
                  consumerSourceFile,
                  usage,
                  change.current
                );
                for (const mismatch of callMismatches) {
                  findings.push({
                    source: 'contract',
                    ruleId: 'contract-function-signature-drift',
                    severity: 'error',
                    path: consumerPath,
                    line: mismatch.line,
                    side: 'RIGHT',
                    body: `**[跨文件调用方未同步]** \`${modulePath}\` 导出的 \`${change.symbolName}\` 已从 ${change.previous?.signatureText || '旧签名'} 变成 ${change.current.signatureText}，但这里仍按旧调用方式传参。合并后很容易出现必填参数缺失、默认值失效或运行时分支漂移。建议同步更新所有调用点。`,
                  });
                }
              }
              continue;
            }

            if (change.changeType === 'kind_changed') {
              for (const usage of matchingUsages) {
                const kindMismatches = this.findKindUsageMismatches(
                  consumerSourceFile,
                  usage,
                  change.current
                );
                for (const mismatch of kindMismatches) {
                  findings.push({
                    source: 'contract',
                    ruleId: 'contract-export-kind-drift',
                    severity: 'error',
                    path: consumerPath,
                    line: mismatch.line,
                    side: 'RIGHT',
                    body: `**[跨文件调用方式未同步]** \`${modulePath}\` 导出的 \`${change.symbolName}\` 已从 ${change.previous?.kind || '旧类型'} 变为 ${change.current.kind}，但这里仍按${mismatch.usageKind === 'construct' ? '`new` 构造' : '函数调用'}方式使用它。合并后很容易出现运行时报错或语义漂移。建议同步调整调用方式，或在导出侧保留兼容层。`,
                  });
                }
              }
            }
          }

          const externalConsumers = await this.findPotentialExternalConsumers(
            owner,
            repo,
            change.symbolName,
            changedPaths,
            searchCache
          );
          if (externalConsumers.length > 0) {
            this.pushSignal(signalsByPath, modulePath, {
              source: 'contract',
              line: change.line,
              summary: `导出契约 ${this.describeContractChange(change)}，仓库内还有 ${externalConsumers.length} 个疑似外部调用文件未包含在本次 diff 中`,
            });
          }
        }
      }

      return {
        findingsByPath: this.groupFindingsByPath(findings),
        signalsByPath,
      };
    } finally {
      this.clearAnalysisState();
    }
  }

  /**
   * 对比基线与当前导出契约，找出删除、签名变化或符号类型变化。
   */
  private compareContracts(
    previousExports: Map<string, ExportContract>,
    currentExports: Map<string, ExportContract>
  ): ContractChange[] {
    const changes: ContractChange[] = [];
    for (const [name, previousContract] of previousExports.entries()) {
      const currentContract = currentExports.get(name);
      if (!currentContract) {
        changes.push({
          symbolName: name,
          changeType: 'removed',
          line: previousContract.line,
          previous: previousContract,
        });
        continue;
      }

      if (previousContract.kind !== currentContract.kind) {
        changes.push({
          symbolName: name,
          changeType: 'kind_changed',
          line: currentContract.line,
          previous: previousContract,
          current: currentContract,
        });
        continue;
      }

      if (
        previousContract.requiredParamCount !== currentContract.requiredParamCount
        || previousContract.totalParamCount !== currentContract.totalParamCount
        || previousContract.hasRestParameter !== currentContract.hasRestParameter
      ) {
        changes.push({
          symbolName: name,
          changeType: 'signature_changed',
          line: currentContract.line,
          previous: previousContract,
          current: currentContract,
        });
      }
    }

    return changes;
  }

  /**
   * 从单个源码文件中提取已导出的主要契约信息。
   */
  private extractExportContracts(filePath: string, content: string): Map<string, ExportContract> {
    const sourceFile = this.project.createSourceFile(filePath, content, { overwrite: true });
    const contracts = new Map<string, ExportContract>();

    for (const declaration of sourceFile.getFunctions()) {
      if (!declaration.isExported()) {
        continue;
      }

      const name = declaration.isDefaultExport() ? 'default' : declaration.getName();
      if (!name) {
        continue;
      }

      contracts.set(name, {
        name,
        kind: 'function',
        line: declaration.getStartLineNumber(),
        signatureText: `${name}(${declaration.getParameters().map((parameter) => parameter.getText()).join(', ')})`,
        requiredParamCount: declaration.getParameters().filter((parameter) => !parameter.isOptional() && !parameter.isRestParameter()).length,
        totalParamCount: declaration.getParameters().length,
        hasRestParameter: declaration.getParameters().some((parameter) => parameter.isRestParameter()),
      });
    }

    for (const declaration of sourceFile.getVariableDeclarations()) {
      const statement = declaration.getVariableStatement();
      if (!statement?.isExported()) {
        continue;
      }

      const initializer = declaration.getInitializer();
      const name = declaration.getName();
      const callableInitializer = initializer && (
        TsMorphNode.isArrowFunction(initializer) || TsMorphNode.isFunctionExpression(initializer)
      )
        ? initializer
        : null;
      const parameters = callableInitializer ? callableInitializer.getParameters() : [];

      contracts.set(name, {
        name,
        kind: callableInitializer ? 'function' : 'value',
        line: declaration.getStartLineNumber(),
        signatureText: callableInitializer
          ? `${name}(${parameters.map((parameter) => parameter.getText()).join(', ')})`
          : declaration.getText(),
        requiredParamCount: callableInitializer
          ? parameters.filter((parameter) => !parameter.isOptional() && !parameter.isRestParameter()).length
          : null,
        totalParamCount: callableInitializer ? parameters.length : null,
        hasRestParameter: callableInitializer ? parameters.some((parameter) => parameter.isRestParameter()) : false,
      });
    }

    for (const declaration of sourceFile.getClasses()) {
      if (!declaration.isExported()) {
        continue;
      }

      const name = declaration.isDefaultExport() ? 'default' : declaration.getName();
      if (!name) {
        continue;
      }

      contracts.set(name, {
        name,
        kind: 'class',
        line: declaration.getStartLineNumber(),
        signatureText: declaration.getName() ? `class ${declaration.getName()}` : 'default class',
        requiredParamCount: null,
        totalParamCount: null,
        hasRestParameter: false,
      });
    }

    for (const declaration of [...sourceFile.getInterfaces(), ...sourceFile.getTypeAliases(), ...sourceFile.getEnums()]) {
      if (!declaration.isExported()) {
        continue;
      }

      const name = declaration.getName();
      contracts.set(name, {
        name,
        kind: 'type',
        line: declaration.getStartLineNumber(),
        signatureText: declaration.getText().split('\n')[0].trim(),
        requiredParamCount: null,
        totalParamCount: null,
        hasRestParameter: false,
      });
    }

    for (const exportDeclaration of sourceFile.getExportDeclarations()) {
      if (exportDeclaration.getModuleSpecifierValue()) {
        continue;
      }

      for (const namedExport of exportDeclaration.getNamedExports()) {
        const exportName = namedExport.getAliasNode()?.getText() || namedExport.getName();
        const localDeclaration = namedExport.getLocalTargetDeclarations()[0];
        if (!localDeclaration) {
          continue;
        }

        const contract = this.createContractFromDeclaration(exportName, localDeclaration);
        if (contract) {
          contracts.set(exportName, contract);
        }
      }
    }

    return contracts;
  }

  /**
   * 提取当前文件对本次改动中其他模块的导入绑定。
   */
  private async extractImportBindings(
    filePath: string,
    sourceFile: SourceFile,
    knownModulePaths: Set<string>,
    importResolver: LocalImportResolver
  ): Promise<ImportBindingUsage[]> {
    const bindings: ImportBindingUsage[] = [];
    const seen = new Set<string>();

    const pushBinding = (binding: ImportBindingUsage): boolean => {
      const key = [
        binding.modulePath,
        binding.symbolName || '*',
        binding.localName,
        binding.namespaceImport ? 'ns' : 'direct',
        binding.memberName || '',
        String(binding.line),
      ].join(':');
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      bindings.push(binding);
      return true;
    };

    for (const declaration of sourceFile.getImportDeclarations()) {
      const moduleSpecifier = declaration.getModuleSpecifierValue();
      const resolvedModulePath = importResolver.resolveImport(filePath, moduleSpecifier);
      if (!resolvedModulePath) {
        continue;
      }

      const line = declaration.getStartLineNumber();
      const transitiveTargets = await this.resolveTransitiveReExportTargets(resolvedModulePath);
      const defaultImport = declaration.getDefaultImport();
      if (defaultImport) {
        if (knownModulePaths.has(resolvedModulePath)) {
          pushBinding({
            modulePath: resolvedModulePath,
            symbolName: 'default',
            localName: defaultImport.getText(),
            line,
          });
        }

        for (const target of transitiveTargets.filter((target) => target.exportPath.length === 1 && target.exportedName === 'default')) {
          pushBinding({
            modulePath: target.modulePath,
            symbolName: target.symbolName,
            localName: defaultImport.getText(),
            line,
          });
        }
      }

      const namespaceImport = declaration.getNamespaceImport();
      if (namespaceImport) {
        if (knownModulePaths.has(resolvedModulePath)) {
          pushBinding({
            modulePath: resolvedModulePath,
            localName: namespaceImport.getText(),
            line,
            namespaceImport: true,
          });
        }

        for (const target of transitiveTargets) {
          pushBinding({
            modulePath: target.modulePath,
            symbolName: target.symbolName,
            localName: this.buildNamespaceAccessBase(namespaceImport.getText(), target.exportPath),
            line,
            namespaceImport: true,
            memberName: target.exportPath[target.exportPath.length - 1],
          });
        }
      }

      for (const namedImport of declaration.getNamedImports()) {
        const importedName = namedImport.getName();
        const localName = namedImport.getAliasNode()?.getText() || importedName;

        if (knownModulePaths.has(resolvedModulePath)) {
          pushBinding({
            modulePath: resolvedModulePath,
            symbolName: importedName,
            localName,
            line,
          });
        }

        for (const target of transitiveTargets.filter((target) => target.exportedName === importedName)) {
          if (target.exportPath.length === 1) {
            pushBinding({
              modulePath: target.modulePath,
              symbolName: target.symbolName,
              localName,
              line,
            });
            continue;
          }

          pushBinding({
            modulePath: target.modulePath,
            symbolName: target.symbolName,
            localName: this.buildNamespaceAccessBase(localName, target.exportPath, true),
            line,
            namespaceImport: true,
            memberName: target.exportPath[target.exportPath.length - 1],
          });
        }
      }
    }

    this.collectStaticBindingAliases(sourceFile, bindings, pushBinding);
    return bindings;
  }

  /**
   * 为静态可判定的一跳/两跳转发补充导入绑定，覆盖 `const fn = api.run`、`registry['run']()` 这类常见包装。
   */
  private collectStaticBindingAliases(
    sourceFile: SourceFile,
    initialBindings: ImportBindingUsage[],
    pushBinding: (binding: ImportBindingUsage) => boolean
  ): void {
    const knownBindings = [...initialBindings];
    const resolveMatchedBinding = (expression: TsMorphNode): ImportBindingUsage | null => {
      for (let index = knownBindings.length - 1; index >= 0; index -= 1) {
        const binding = knownBindings[index];
        const fallbackMemberName = binding.memberName || binding.symbolName || 'default';
        if (this.matchesImportedUsageExpression(expression, binding, fallbackMemberName)) {
          return binding;
        }
      }
      return this.resolveNamespaceMemberBinding(expression, knownBindings);
    };
    const registerDirectAlias = (binding: ImportBindingUsage, localName: string, line: number) => {
      const aliasBinding: ImportBindingUsage = {
        modulePath: binding.modulePath,
        symbolName: binding.symbolName,
        localName,
        line,
      };
      if (pushBinding(aliasBinding)) {
        knownBindings.push(aliasBinding);
      }
    };
    const registerObjectMemberAlias = (
      binding: ImportBindingUsage,
      objectName: string,
      memberName: string,
      line: number
    ) => {
      const aliasBinding: ImportBindingUsage = {
        modulePath: binding.modulePath,
        symbolName: binding.symbolName,
        localName: objectName,
        line,
        namespaceImport: true,
        memberName,
      };
      if (pushBinding(aliasBinding)) {
        knownBindings.push(aliasBinding);
      }
    };

    for (let round = 0; round < 2; round += 1) {
      const startCount = knownBindings.length;

      for (const declaration of sourceFile.getVariableDeclarations()) {
        const initializer = declaration.getInitializer();
        if (!initializer) {
          continue;
        }

        const nameNode = declaration.getNameNode();
        if (TsMorphNode.isIdentifier(nameNode)) {
          const matchedBinding = resolveMatchedBinding(initializer);
          if (matchedBinding) {
            registerDirectAlias(matchedBinding, nameNode.getText(), declaration.getStartLineNumber());
          }
        }

        if (!TsMorphNode.isIdentifier(nameNode) || !TsMorphNode.isObjectLiteralExpression(initializer)) {
          continue;
        }

        for (const property of initializer.getProperties()) {
          const memberName = this.getStaticObjectMemberName(property);
          const memberExpression = this.getStaticObjectMemberExpression(property);
          if (!memberName || !memberExpression) {
            continue;
          }

          const matchedBinding = resolveMatchedBinding(memberExpression);
          if (!matchedBinding) {
            continue;
          }

          registerObjectMemberAlias(
            matchedBinding,
            nameNode.getText(),
            memberName,
            property.getStartLineNumber()
          );
        }
      }

      for (const binaryExpression of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (binaryExpression.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) {
          continue;
        }

        const left = binaryExpression.getLeft();
        const right = binaryExpression.getRight();
        if (!TsMorphNode.isIdentifier(left)) {
          continue;
        }

        const matchedBinding = resolveMatchedBinding(right);
        if (matchedBinding) {
          registerDirectAlias(matchedBinding, left.getText(), binaryExpression.getStartLineNumber());
        }
      }

      if (knownBindings.length === startCount) {
        break;
      }
    }
  }

  private getStaticObjectMemberName(property: TsMorphNode): string | null {
    if (
      TsMorphNode.isPropertyAssignment(property)
      || TsMorphNode.isShorthandPropertyAssignment(property)
      || TsMorphNode.isMethodDeclaration(property)
    ) {
      const nameNode = property.getNameNode();
      if (TsMorphNode.isIdentifier(nameNode)) {
        return nameNode.getText();
      }
      if (TsMorphNode.isStringLiteral(nameNode) || TsMorphNode.isNumericLiteral(nameNode)) {
        return nameNode.getLiteralText();
      }
    }

    return null;
  }

  private getStaticObjectMemberExpression(property: TsMorphNode): TsMorphNode | null {
    if (TsMorphNode.isPropertyAssignment(property)) {
      return property.getInitializer() ?? null;
    }

    if (TsMorphNode.isShorthandPropertyAssignment(property)) {
      return property.getNameNode();
    }

    return null;
  }

  private resolveNamespaceMemberBinding(
    expression: TsMorphNode,
    bindings: ImportBindingUsage[]
  ): ImportBindingUsage | null {
    const memberAccess = this.getStaticMemberAccess(expression);
    if (!memberAccess) {
      return null;
    }

    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const binding = bindings[index];
      if (!binding.namespaceImport || binding.memberName || binding.localName !== memberAccess.baseExpression) {
        continue;
      }

      return {
        modulePath: binding.modulePath,
        symbolName: memberAccess.memberName,
        localName: binding.localName,
        line: binding.line,
        namespaceImport: true,
        memberName: memberAccess.memberName,
      };
    }

    return null;
  }

  private getStaticMemberAccess(expression: TsMorphNode): { baseExpression: string; memberName: string } | null {
    if (TsMorphNode.isPropertyAccessExpression(expression)) {
      return {
        baseExpression: expression.getExpression().getText(),
        memberName: expression.getName(),
      };
    }

    if (TsMorphNode.isElementAccessExpression(expression)) {
      const argumentExpression = expression.getArgumentExpression();
      if (argumentExpression && TsMorphNode.isStringLiteral(argumentExpression)) {
        return {
          baseExpression: expression.getExpression().getText(),
          memberName: argumentExpression.getLiteralText(),
        };
      }
    }

    return null;
  }

  /**
   * 在调用方源码中寻找对指定导入绑定的直接调用，并检查参数个数是否过时。
   */
  private findCallArityMismatches(
    sourceFile: SourceFile,
    usage: ImportBindingUsage,
    contract: ExportContract
  ): Array<{ line: number }> {
    if (contract.requiredParamCount === null) {
      return [];
    }

    const mismatches: Array<{ line: number }> = [];
    for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expression = callExpression.getExpression();
      if (!this.matchesImportedUsageExpression(expression, usage, contract.name)) {
        continue;
      }

      const argCount = callExpression.getArguments().length;
      const missingRequiredArgs = argCount < contract.requiredParamCount;
      const tooManyArgs = !contract.hasRestParameter
        && contract.totalParamCount !== null
        && argCount > contract.totalParamCount;

      if (!missingRequiredArgs && !tooManyArgs) {
        continue;
      }

      mismatches.push({
        line: callExpression.getStartLineNumber(),
      });
    }

    return mismatches;
  }

  /**
   * 当导出从 function/class 漂移成其他类型时，检查调用方是否仍按旧方式调用。
   */
  private findKindUsageMismatches(
    sourceFile: SourceFile,
    usage: ImportBindingUsage,
    contract: ExportContract
  ): Array<{ line: number; usageKind: 'call' | 'construct' }> {
    const mismatches: Array<{ line: number; usageKind: 'call' | 'construct' }> = [];

    if (contract.kind !== 'function') {
      for (const callExpression of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!this.matchesImportedUsageExpression(callExpression.getExpression(), usage, contract.name)) {
          continue;
        }

        mismatches.push({
          line: callExpression.getStartLineNumber(),
          usageKind: 'call',
        });
      }
    }

    if (contract.kind !== 'class') {
      for (const newExpression of sourceFile.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        if (!this.matchesImportedUsageExpression(newExpression.getExpression(), usage, contract.name)) {
          continue;
        }

        mismatches.push({
          line: newExpression.getStartLineNumber(),
          usageKind: 'construct',
        });
      }
    }

    return mismatches;
  }

  /**
   * 统计仓库里疑似仍在使用该导出符号、但不在本次 diff 中的外部调用文件。
   */
  private async findPotentialExternalConsumers(
    owner: string,
    repo: string,
    symbolName: string,
    changedPaths: Set<string>,
    searchCache: Map<string, string[]>
  ): Promise<string[]> {
    if (!symbolName || symbolName === 'default') {
      return [];
    }

    if (!searchCache.has(symbolName)) {
      searchCache.set(symbolName, await this.scmProvider.searchCode(owner, repo, symbolName));
    }

    return (searchCache.get(symbolName) ?? [])
      .map((item) => normalizeRepoPath(item))
      .filter((item) => !changedPaths.has(item))
      .filter((item) => isAnalyzableScriptPath(item))
      .slice(0, 10);
  }

  /**
   * 生成导出侧的摘要信号，帮助 prompt 理解这是一处契约变更。
   */
  private buildExporterSignalSummary(change: ContractChange): string {
    return `检测到跨文件契约变更：${this.describeContractChange(change)}`;
  }

  /**
   * 把契约变更描述成适合日志和提示词消费的一句话。
   */
  private describeContractChange(change: ContractChange): string {
    switch (change.changeType) {
      case 'removed':
        return `导出符号 ${change.symbolName} 已被移除`;
      case 'kind_changed':
        return `导出符号 ${change.symbolName} 的类型已从 ${change.previous?.kind || '旧类型'} 变为 ${change.current?.kind || '新类型'}`;
      case 'signature_changed':
        return `导出函数 ${change.symbolName} 的签名已从 ${change.previous?.signatureText || '旧签名'} 变为 ${change.current?.signatureText || '新签名'}`;
      default:
        return `导出符号 ${change.symbolName} 发生了契约变化`;
    }
  }

  /**
   * 按文件聚合契约分析产生的发现。
   */
  private groupFindingsByPath(findings: StaticReviewFinding[]): Map<string, StaticReviewFinding[]> {
    const grouped = new Map<string, StaticReviewFinding[]>();
    for (const finding of findings) {
      const bucket = grouped.get(finding.path) ?? [];
      bucket.push(finding);
      grouped.set(finding.path, bucket);
    }
    return grouped;
  }

  /**
   * 以文件为粒度收集契约信号，供静态分析结果直接并入主链。
   */
  private pushSignal(
    signalsByPath: Map<string, ReviewSignal[]>,
    filePath: string,
    signal: ReviewSignal
  ): void {
    const bucket = signalsByPath.get(filePath) ?? [];
    bucket.push(signal);
    signalsByPath.set(filePath, bucket);
  }

  /**
   * 统一初始化本轮分析所需的临时状态与缓存。
   */
  private prepareAnalysisState(
    checkoutRoot: string,
    owner: string,
    repo: string,
    baselineRef: string,
    importResolver: LocalImportResolver,
    knownModulePaths: Set<string>
  ): void {
    this.analysisCheckoutRoot = checkoutRoot;
    this.analysisOwner = owner;
    this.analysisRepo = repo;
    this.analysisBaselineRef = baselineRef;
    this.analysisImportResolver = importResolver;
    this.analysisKnownModulePaths = new Set(knownModulePaths);
    this.headFileContentCache.clear();
    this.baselineFileContentCache.clear();
    this.exportContractCache.clear();
    this.reExportTargetCache.clear();
  }

  /**
   * 清空本轮分析用到的临时状态，避免不同 review 之间串缓存。
   */
  private clearAnalysisState(): void {
    this.analysisCheckoutRoot = '';
    this.analysisOwner = '';
    this.analysisRepo = '';
    this.analysisBaselineRef = '';
    this.analysisImportResolver = null;
    this.analysisKnownModulePaths.clear();
    this.headFileContentCache.clear();
    this.baselineFileContentCache.clear();
    this.exportContractCache.clear();
    this.reExportTargetCache.clear();
  }

  /**
   * 读取当前 checkout 中的源码文件，并在单轮分析中复用结果。
   */
  private async loadHeadFileContent(filePath: string): Promise<string> {
    const normalizedPath = normalizeRepoPath(filePath);
    if (!this.headFileContentCache.has(normalizedPath)) {
      this.headFileContentCache.set(
        normalizedPath,
        readFile(path.join(this.analysisCheckoutRoot, normalizedPath), 'utf8').catch(() => '')
      );
    }

    return this.headFileContentCache.get(normalizedPath)!;
  }

  /**
   * 优先从本地 git ref 读取基线版本内容，失败时再回退到 SCM 拉取。
   */
  private async loadBaselineFileContent(filePath: string): Promise<string> {
    const normalizedPath = normalizeRepoPath(filePath);
    if (!this.baselineFileContentCache.has(normalizedPath)) {
      this.baselineFileContentCache.set(normalizedPath, (async () => {
        const localContent = await this.readBaselineFileFromGitRef(normalizedPath);
        if (localContent !== null) {
          return localContent;
        }

        return this.scmProvider.getFileContent(
          this.analysisOwner,
          this.analysisRepo,
          normalizedPath,
          this.analysisBaselineRef
        );
      })());
    }

    return this.baselineFileContentCache.get(normalizedPath)!;
  }

  /**
   * 通过本地 checkout 的 git 对象数据库读取基线文件，避免为每个文件额外打远程 API。
   */
  private async readBaselineFileFromGitRef(filePath: string): Promise<string | null> {
    if (!this.analysisCheckoutRoot || !this.analysisBaselineRef) {
      return null;
    }

    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        this.analysisCheckoutRoot,
        'show',
        `${this.analysisBaselineRef}:${filePath.replace(/\\/g, '/')}`,
      ], {
        env: process.env,
        maxBuffer: 8 * 1024 * 1024,
      });

      return stdout;
    } catch (error: unknown) {
      const stderr = getErrorStderr(error)?.toLowerCase() ?? '';
      const stdout = getErrorStdout(error)?.toLowerCase() ?? '';
      const message = getErrorMessage(error).toLowerCase();
      const missingRefOrFile = [
        'does not exist in',
        'exists on disk, but not in',
        'invalid object name',
        'bad object',
        'pathspec',
      ].some((token) => stderr.includes(token) || stdout.includes(token) || message.includes(token));
      const missingGitContext = [
        'not a git repository',
      ].some((token) => stderr.includes(token) || stdout.includes(token) || message.includes(token));

      if (missingRefOrFile) {
        return '';
      }

      if (missingGitContext) {
        return null;
      }

      logger.warn(`⚠️ Failed to read contract baseline from git ref: ${filePath}@${this.analysisBaselineRef}`, {
        error: getErrorMessage(error),
      });
      return null;
    }
  }

  /**
   * 解析某个本地模块经由 barrel / re-export 暴露到调用方的符号映射。
   */
  private async resolveTransitiveReExportTargets(
    modulePath: string,
    depth = 0,
    visited = new Set<string>()
  ): Promise<ReExportBindingTarget[]> {
    const normalizedPath = normalizeRepoPath(modulePath);
    if (depth === 0 && this.reExportTargetCache.has(normalizedPath)) {
      return this.reExportTargetCache.get(normalizedPath)!;
    }

    const task = this.resolveTransitiveReExportTargetsUncached(normalizedPath, depth, visited);
    if (depth === 0) {
      this.reExportTargetCache.set(normalizedPath, task);
    }

    return task;
  }

  /**
   * 递归展开 export 声明，把 barrel 暴露出来的符号还原到底层变更模块。
   */
  private async resolveTransitiveReExportTargetsUncached(
    modulePath: string,
    depth: number,
    visited: Set<string>
  ): Promise<ReExportBindingTarget[]> {
    if (!this.analysisImportResolver || depth > 4 || visited.has(modulePath)) {
      return [];
    }

    const nextVisited = new Set(visited);
    nextVisited.add(modulePath);

    const content = await this.loadHeadFileContent(modulePath);
    if (!content) {
      return [];
    }

    const sourceFile = this.project.createSourceFile(modulePath, content, { overwrite: true });
    const targets: ReExportBindingTarget[] = [];
    const seen = new Set<string>();
    const pushTarget = (target: ReExportBindingTarget) => {
      const key = `${target.modulePath}:${target.symbolName}:${target.exportPath.join('.')}`;
      if (seen.has(key)) {
        return;
      }

      seen.add(key);
      targets.push(target);
    };

    for (const exportDeclaration of sourceFile.getExportDeclarations()) {
      const moduleSpecifier = exportDeclaration.getModuleSpecifierValue();
      if (!moduleSpecifier) {
        continue;
      }

      const resolvedModulePath = this.analysisImportResolver.resolveImport(modulePath, moduleSpecifier);
      if (!resolvedModulePath) {
        continue;
      }

      const namespaceExport = exportDeclaration.getNamespaceExport();
      if (namespaceExport) {
        const namespaceTargets = this.analysisKnownModulePaths.has(resolvedModulePath)
          ? await this.getDirectExportTargets(resolvedModulePath)
          : await this.resolveTransitiveReExportTargets(resolvedModulePath, depth + 1, nextVisited);
        const namespaceName = namespaceExport.getName();

        for (const target of namespaceTargets) {
          if (target.exportedName === 'default') {
            continue;
          }

          pushTarget({
            modulePath: target.modulePath,
            symbolName: target.symbolName,
            exportedName: namespaceName,
            exportPath: [namespaceName, ...target.exportPath],
          });
        }
        continue;
      }

      if (exportDeclaration.hasNamedExports()) {
        for (const namedExport of exportDeclaration.getNamedExports()) {
          const sourceName = namedExport.getName();
          const exportedName = namedExport.getAliasNode()?.getText() || sourceName;
          const resolvedTargets = await this.resolveNamedExportTargets(
            resolvedModulePath,
            sourceName,
            depth + 1,
            nextVisited
          );
          for (const target of resolvedTargets) {
            pushTarget({
              modulePath: target.modulePath,
              symbolName: target.symbolName,
              exportedName,
              exportPath: [exportedName, ...target.exportPath.slice(1)],
            });
          }
        }
        continue;
      }

      const wildcardTargets = this.analysisKnownModulePaths.has(resolvedModulePath)
        ? await this.getDirectExportTargets(resolvedModulePath)
        : await this.resolveTransitiveReExportTargets(resolvedModulePath, depth + 1, nextVisited);
      for (const target of wildcardTargets) {
        if (target.exportedName === 'default') {
          continue;
        }
        pushTarget(target);
      }
    }

    return targets;
  }

  /**
   * 把命名 re-export 对应回底层的真实变更符号。
   */
  private async resolveNamedExportTargets(
    modulePath: string,
    exportedName: string,
    depth: number,
    visited: Set<string>
  ): Promise<ReExportBindingTarget[]> {
    if (this.analysisKnownModulePaths.has(modulePath)) {
      const contracts = await this.getHeadExportContracts(modulePath);
      if (!contracts.has(exportedName)) {
        return [];
      }

      return [{
        modulePath,
        symbolName: exportedName,
        exportedName,
        exportPath: [exportedName],
      }];
    }

    return (await this.resolveTransitiveReExportTargets(modulePath, depth, visited))
      .filter((target) => target.exportedName === exportedName);
  }

  /**
   * 读取一个模块当前 head 版本的导出契约，供 export * 展开使用。
   */
  private async getHeadExportContracts(modulePath: string): Promise<Map<string, ExportContract>> {
    const normalizedPath = normalizeRepoPath(modulePath);
    if (!this.exportContractCache.has(normalizedPath)) {
      this.exportContractCache.set(normalizedPath, (async () => {
        const content = await this.loadHeadFileContent(normalizedPath);
        return content ? this.extractExportContracts(normalizedPath, content) : new Map<string, ExportContract>();
      })());
    }

    return this.exportContractCache.get(normalizedPath)!;
  }

  /**
   * 把一个模块直接暴露的导出名展开成可供 barrel 传递的目标列表。
   */
  private async getDirectExportTargets(modulePath: string): Promise<ReExportBindingTarget[]> {
    const contracts = await this.getHeadExportContracts(modulePath);
    return Array.from(contracts.values())
      .filter((contract) => contract.name !== 'default')
      .map((contract) => ({
        modulePath,
        symbolName: contract.name,
        exportedName: contract.name,
        exportPath: [contract.name],
      }));
  }

  /**
   * 把 namespace re-export 的访问链压平成 `foo.bar` 这种 property-access 基底。
   */
  private buildNamespaceAccessBase(localName: string, exportPath: string[], skipRoot = false): string {
    if (exportPath.length <= 1) {
      return localName;
    }

    const pathSegments = skipRoot ? exportPath.slice(1, -1) : exportPath.slice(0, -1);
    if (pathSegments.length === 0) {
      return localName;
    }

    return `${localName}.${pathSegments.join('.')}`;
  }

  /**
   * 把局部导出声明绑定回实际声明节点，补齐 `export { foo }` 这种写法。
   */
  private createContractFromDeclaration(
    name: string,
    declaration: TsMorphNode
  ): ExportContract | null {
    if (TsMorphNode.isFunctionDeclaration(declaration)) {
      return {
        name,
        kind: 'function',
        line: declaration.getStartLineNumber(),
        signatureText: `${name}(${declaration.getParameters().map((parameter) => parameter.getText()).join(', ')})`,
        requiredParamCount: declaration.getParameters().filter((parameter) => !parameter.isOptional() && !parameter.isRestParameter()).length,
        totalParamCount: declaration.getParameters().length,
        hasRestParameter: declaration.getParameters().some((parameter) => parameter.isRestParameter()),
      };
    }

    if (TsMorphNode.isVariableDeclaration(declaration)) {
      const initializer = declaration.getInitializer();
      const callableInitializer = initializer && (
        TsMorphNode.isArrowFunction(initializer) || TsMorphNode.isFunctionExpression(initializer)
      )
        ? initializer
        : null;
      const parameters = callableInitializer ? callableInitializer.getParameters() : [];

      return {
        name,
        kind: callableInitializer ? 'function' : 'value',
        line: declaration.getStartLineNumber(),
        signatureText: callableInitializer
          ? `${name}(${parameters.map((parameter) => parameter.getText()).join(', ')})`
          : declaration.getText(),
        requiredParamCount: callableInitializer
          ? parameters.filter((parameter) => !parameter.isOptional() && !parameter.isRestParameter()).length
          : null,
        totalParamCount: callableInitializer ? parameters.length : null,
        hasRestParameter: callableInitializer ? parameters.some((parameter) => parameter.isRestParameter()) : false,
      };
    }

    if (TsMorphNode.isClassDeclaration(declaration)) {
      return {
        name,
        kind: 'class',
        line: declaration.getStartLineNumber(),
        signatureText: declaration.getName() ? `class ${declaration.getName()}` : `class ${name}`,
        requiredParamCount: null,
        totalParamCount: null,
        hasRestParameter: false,
      };
    }

    if (TsMorphNode.isInterfaceDeclaration(declaration) || TsMorphNode.isTypeAliasDeclaration(declaration) || TsMorphNode.isEnumDeclaration(declaration)) {
      return {
        name,
        kind: 'type',
        line: declaration.getStartLineNumber(),
        signatureText: declaration.getText().split('\n')[0].trim(),
        requiredParamCount: null,
        totalParamCount: null,
        hasRestParameter: false,
      };
    }

    return null;
  }

  /**
   * 统一判断一个调用表达式是否命中当前 import 绑定。
   */
  private matchesImportedUsageExpression(
    expression: TsMorphNode,
    usage: ImportBindingUsage,
    fallbackMemberName: string
  ): boolean {
    if (!usage.namespaceImport) {
      return TsMorphNode.isIdentifier(expression) && expression.getText() === usage.localName;
    }

    const memberName = usage.memberName || fallbackMemberName;
    if (
      TsMorphNode.isPropertyAccessExpression(expression)
      && expression.getExpression().getText() === usage.localName
      && expression.getName() === memberName
    ) {
      return true;
    }

    return TsMorphNode.isElementAccessExpression(expression)
      && expression.getExpression().getText() === usage.localName
      && (() => {
        const argumentExpression = expression.getArgumentExpression();
        return Boolean(
          argumentExpression
          && TsMorphNode.isStringLiteral(argumentExpression)
          && argumentExpression.getLiteralText() === memberName
        );
      })();
  }
}
