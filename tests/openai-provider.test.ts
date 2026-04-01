/**
 * 验证 OpenAI provider 的请求拼装、响应解析和错误处理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../src/providers/llm/openai.provider.js';
import { LLMError } from '../src/shared/errors.js';

interface StubbedCompletionResponse {
  choices: Array<{
    message: {
      content: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    total_tokens?: number | null;
  } | null;
}

/**
 * 创建一个返回固定 completion 响应的 OpenAI provider。
 */
function createProviderWithStubbedResponse(
  responseOrFactory: StubbedCompletionResponse | (() => Promise<StubbedCompletionResponse>),
  options: ConstructorParameters<typeof OpenAIProvider>[3] = {}
): OpenAIProvider {
  const provider = new OpenAIProvider('test-key', 'test-model', 'https://example.com/v1', options);
  const providerWithClient = provider as unknown as {
    client: {
      chat: {
        completions: {
          create: () => Promise<StubbedCompletionResponse>;
        };
      };
    };
  };
  providerWithClient.client = {
    chat: {
      completions: {
        create: async () => (
          typeof responseOrFactory === 'function'
            ? responseOrFactory()
            : responseOrFactory
        ),
      },
    },
  };
  return provider;
}

test('throws when the LLM returns an empty review payload', async () => {
  const provider = createProviderWithStubbedResponse({
    choices: [
      {
        message: {
          content: null,
        },
        finish_reason: 'stop',
      },
    ],
    usage: null,
  });

  await assert.rejects(
    () => provider.generateReview('review this', 'src/example.ts'),
    (error: unknown) => error instanceof LLMError && /empty review payload/i.test(error.message)
  );
});

test('throws when the LLM returns invalid review json', async () => {
  const provider = createProviderWithStubbedResponse({
    choices: [
      {
        message: {
          content: '{not-valid-json}',
        },
        finish_reason: 'stop',
      },
    ],
    usage: null,
  });

  await assert.rejects(
    () => provider.generateReview('review this', 'src/example.ts'),
    (error: unknown) => error instanceof LLMError && /invalid json/i.test(error.message)
  );
});

test('keeps accepting valid empty review payloads', async () => {
  const provider = createProviderWithStubbedResponse({
    choices: [
      {
        message: {
          content: '{"comments":[]}',
        },
        finish_reason: 'stop',
      },
    ],
    usage: null,
  });

  const comments = await provider.generateReview('review this', 'src/example.ts');
  assert.deepEqual(comments, []);
});

test('retries transient rate-limit errors before succeeding', async () => {
  let attempts = 0;
  const provider = createProviderWithStubbedResponse(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw {
        status: 429,
        headers: {
          'retry-after': '0',
        },
        message: 'rate limit exceeded',
      };
    }

    return {
      choices: [
        {
          message: {
            content: '{"comments":[]}',
          },
          finish_reason: 'stop',
        },
      ],
      usage: null,
    };
  }, {
    maxRetries: 2,
    retryBaseDelayMs: 0,
  });

  const comments = await provider.generateReview('review this', 'src/example.ts');
  assert.deepEqual(comments, []);
  assert.equal(attempts, 2);
});

test('retries timeout errors before succeeding', async () => {
  let attempts = 0;
  const provider = createProviderWithStubbedResponse(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw {
        name: 'APIConnectionTimeoutError',
        code: 'ETIMEDOUT',
        message: 'Request timed out',
      };
    }

    return {
      choices: [
        {
          message: {
            content: '{"comments":[]}',
          },
          finish_reason: 'stop',
        },
      ],
      usage: null,
    };
  }, {
    maxRetries: 2,
    retryBaseDelayMs: 0,
  });

  const comments = await provider.generateReview('review this', 'src/example.ts');
  assert.deepEqual(comments, []);
  assert.equal(attempts, 2);
});
