import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AiError, callAI, DEFAULT_API_URL, DEFAULT_EXTERNAL_MODEL, DEFAULT_WORKERS_MODEL,
  pickProvider, validateApiUrl
} from '../src/ai.js';

const input = {
  mode: 'grade',
  title: 'A Change in My Life',
  essay: 'My life has changed a lot because of reading. I read every morning.',
  requirements: '',
  wordCount: 14
};

test('validateApiUrl rejects insecure and private destinations', () => {
  assert.equal(validateApiUrl(DEFAULT_API_URL), null);
  assert.equal(validateApiUrl('https://api.openai.com/v1/chat/completions'), null);
  assert.equal(validateApiUrl('http://api.deepseek.com/chat/completions'), 'https_required');
  assert.equal(validateApiUrl('https://localhost/chat'), 'private_host');
  assert.equal(validateApiUrl('https://127.0.0.1/chat'), 'ip_literal');
  assert.equal(validateApiUrl('https://[::1]/chat'), 'ip_literal');
  assert.equal(validateApiUrl('https://user:pass@api.example.com/chat'), 'credentials_not_allowed');
  assert.equal(validateApiUrl('not a url'), 'invalid_url');
});

test('pickProvider prefers fixture, then external key, then Workers AI', () => {
  assert.deepEqual(pickProvider({ DEV_FIXTURE: 'true' }), { kind: 'fixture', model: 'fixture' });
  assert.deepEqual(
    pickProvider({ AI_API_KEY: 'key', AI_MODEL: 'deepseek-chat' }),
    { kind: 'external', model: 'deepseek-chat' }
  );
  assert.deepEqual(
    pickProvider({ AI: { run() {} } }),
    { kind: 'workers-ai', model: DEFAULT_WORKERS_MODEL }
  );
  assert.deepEqual(pickProvider({}), { kind: 'none', model: null });
});

test('fixture provider returns parseable JSON without network access', async () => {
  const result = await callAI({ DEV_FIXTURE: 'true' }, input);
  assert.equal(result.provider, 'fixture');
  assert.equal(result.model, 'fixture');
  const parsed = JSON.parse(result.text);
  assert.equal(parsed.subscores.content, 4);
  assert.equal(parsed.style_check.length, 8);
});

test('external provider sends the expected request and reads usage', async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await callAI({
    AI_API_KEY: 'secret',
    AI_API_URL: 'https://api.deepseek.com/chat/completions',
    AI_MODEL: 'deepseek-chat'
  }, input, { fetchImpl });

  assert.equal(result.provider, 'external');
  assert.equal(result.model, 'deepseek-chat');
  assert.equal(result.text, '{"ok":true}');
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  assert.equal(captured.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.redirect, 'error');
  assert.equal(JSON.parse(captured.init.body).response_format.type, 'json_object');
  assert.match(captured.init.headers.authorization, /^Bearer secret$/);
});

test('external provider maps upstream failures to stable codes', async () => {
  const cases = [
    { status: 401, body: 'bad key', code: 'ai_auth_failed' },
    { status: 429, body: 'slow down', code: 'ai_rate_limited' },
    { status: 500, body: 'boom', code: 'ai_upstream_error' }
  ];
  for (const item of cases) {
    await assert.rejects(callAI({
      AI_API_KEY: 'secret',
      AI_API_URL: DEFAULT_API_URL
    }, input, {
      fetchImpl: async () => new Response(item.body, { status: item.status })
    }), (error) => {
      assert.ok(error instanceof AiError);
      assert.equal(error.code, item.code);
      return true;
    });
  }
});

test('external provider rejects truncated or malformed output', async () => {
  await assert.rejects(callAI({
    AI_API_KEY: 'secret', AI_API_URL: DEFAULT_API_URL
  }, input, {
    fetchImpl: async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"a":1}' }, finish_reason: 'length' }]
    }), { status: 200 })
  }), (error) => error.code === 'ai_truncated');

  await assert.rejects(callAI({
    AI_API_KEY: 'secret', AI_API_URL: DEFAULT_API_URL
  }, input, {
    fetchImpl: async () => new Response('not json', { status: 200 })
  }), (error) => error.code === 'ai_invalid_response');
});

test('external provider maps timeouts', async () => {
  await assert.rejects(callAI({
    AI_API_KEY: 'secret', AI_API_URL: DEFAULT_API_URL
  }, input, {
    fetchImpl: async () => {
      const error = new Error('timed out');
      error.name = 'TimeoutError';
      throw error;
    }
  }), (error) => error.code === 'ai_timeout');
});

test('external provider rejects a non-https configured URL', async () => {
  await assert.rejects(callAI({
    AI_API_KEY: 'secret', AI_API_URL: 'http://api.example.com/chat'
  }, input), (error) => error.code === 'ai_config_invalid');
});

test('Workers AI provider reads the response field with JSON mode', async () => {
  let calls = 0;
  const env = {
    AI: {
      async run(model, options) {
        calls += 1;
        assert.equal(model, DEFAULT_WORKERS_MODEL);
        assert.deepEqual(options.response_format, { type: 'json_object' });
        assert.equal(options.chat_template_kwargs, undefined);
        return { response: '{"ok":true}', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } };
      }
    }
  };
  const result = await callAI(env, input);
  assert.equal(calls, 1);
  assert.equal(result.provider, 'workers-ai');
  assert.equal(result.text, '{"ok":true}');
});

test('Qwen3 Workers AI model retries without chat_template_kwargs', async () => {
  let calls = 0;
  const env = {
    WORKERS_AI_MODEL: '@cf/qwen/qwen3-30b-a3b-fp8',
    AI: {
      async run(model, options) {
        calls += 1;
        assert.equal(model, '@cf/qwen/qwen3-30b-a3b-fp8');
        if (options.chat_template_kwargs) throw new Error('unknown field chat_template_kwargs');
        return { response: '{"ok":true}' };
      }
    }
  };
  const result = await callAI(env, input);
  assert.equal(calls, 2);
  assert.equal(result.provider, 'workers-ai');
  assert.equal(result.text, '{"ok":true}');
});

test('Workers AI provider accepts OpenAI-style choices', async () => {
  const env = {
    AI: {
      async run() {
        return { choices: [{ message: { content: '{"ok":true}' } }] };
      }
    }
  };
  const result = await callAI(env, input);
  assert.equal(result.text, '{"ok":true}');
});

test('no provider returns ai_not_configured', async () => {
  await assert.rejects(callAI({}, input), (error) => error.code === 'ai_not_configured');
});
