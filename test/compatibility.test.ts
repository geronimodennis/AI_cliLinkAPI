import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChatCompletionRequest, type CompatibilityDiagnostic } from '../src/chat-compatibility.js';
import { parseRequest } from '../src/requests.js';
import { AIcliToAIapiError, errorBody } from '../src/errors.js';

const basic = { model: 'gpt-6-astra', messages: [{ role: 'user', content: 'Hello' }] };
const schema = {
  type: 'object', additionalProperties: false,
  properties: { cities: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', enum: ['Taipei', 'Tokyo'] } }, required: ['name'], additionalProperties: false } } },
  required: ['cities'], $defs: { custom: { type: 'string' } },
};

test('basic request and optional controls normalize without mutating the caller', () => {
  const controls = { temperature: 0.7, top_p: 1, max_tokens: 1000, max_completion_tokens: 1200, n: 1, seed: 42, frequency_penalty: 0.4, presence_penalty: -0.2, user: 'private-user' };
  const input = { ...basic, ...controls };
  const snapshot = structuredClone(input);
  const entries: CompatibilityDiagnostic[] = [];
  const result = normalizeChatCompletionRequest(input, entry => entries.push(entry));
  assert.deepEqual(result, { ...basic, stream: false });
  assert.deepEqual(input, snapshot);
  assert.equal(entries.filter(e => e.action === 'ignored').length, 8);
  assert.ok(!JSON.stringify(entries).includes('private-user'));
  assert.ok(!JSON.stringify(entries).includes('Hello'));
});

test('strict hints are removed while nested JSON Schema remains complete', () => {
  for (const strict of [true, false, null]) {
    const input = { ...basic, tools: [{ type: 'function', function: { name: 'weather', description: 'Forecast', parameters: schema, strict } }], tool_choice: 'auto' };
    const result = parseRequest(input);
    assert.deepEqual(result.tools, [{ type: 'function', function: { name: 'weather', description: 'Forecast', parameters: schema } }]);
    assert.equal(result.tool_choice, 'auto');
    assert.equal(input.tools[0]!.function.strict, strict);
  }
  assert.equal(parseRequest({ ...basic, tool_choice: 'none' }).tool_choice, 'none');
});

test('unsupported semantics identify their parameter and never silently downgrade', () => {
  for (const [param, values] of Object.entries({ n: [2, 5], stop: ['END', ['END']], tool_choice: ['required', { type: 'function', function: { name: 'weather' } }], response_format: [{ type: 'json_object' }, { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } }], logprobs: [true] })) {
    for (const value of values) for (const stream of [false, true]) {
      const diagnostics: CompatibilityDiagnostic[] = [];
      assert.throws(() => normalizeChatCompletionRequest({ ...basic, stream, [param]: value }, entry => diagnostics.push(entry)), (e: unknown) => {
        assert.ok(e instanceof AIcliToAIapiError);
        assert.equal(e.status, 400);
        assert.deepEqual(errorBody(e).error, { message: e.message, type: 'invalid_request_error', param, code: 'unsupported_value' });
        return true;
      });
      assert.equal(diagnostics.at(-1)?.action, 'rejected');
    }
  }
});

test('default text format, nullable controls and empty stop preserve text behavior', () => {
  for (const response_format of [null, { type: 'text' }]) {
    assert.deepEqual(parseRequest({ ...basic, response_format, temperature: null, max_tokens: null, n: null, stop: [], logprobs: false, tool_choice: null }), { ...basic, stream: false });
  }
});

test('invalid types, out-of-range controls and unknown fields remain rejected without data leaks', () => {
  for (const invalid of [{ temperature: 'secret-value' }, { temperature: 3 }, { top_p: -1 }, { max_tokens: 0 }, { max_completion_tokens: 1.5 }, { presence_penalty: 3 }, { seed: 0.1 }, { user: 42 }, { 'secret-key': 'secret-value' }, { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'secret-value' } }] }] }]) {
    const entries: CompatibilityDiagnostic[] = [];
    assert.throws(() => normalizeChatCompletionRequest({ ...basic, ...invalid }, entry => entries.push(entry)), (e: unknown) => {
      assert.ok(e instanceof AIcliToAIapiError);
      assert.ok(!JSON.stringify(errorBody(e)).includes('secret-'));
      return true;
    });
    assert.ok(!JSON.stringify(entries).includes('secret-'));
  }
});
