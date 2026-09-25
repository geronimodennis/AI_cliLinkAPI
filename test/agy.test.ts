import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequest } from '../src/requests.js';
import { parseToolBridgeResult, toolBridgeSchema } from '../src/providers/agy.js';

const tools = parseRequest({ messages: [{ role: 'user', content: 'What is the weather?' }], tools: [{ type: 'function', function: { name: 'weather', description: 'Read weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }] }).tools!;

test('Antigravity tool bridge accepts an enforced final answer or one known tool call', () => {
  const schema = JSON.parse(toolBridgeSchema(tools));
  assert.equal(schema.oneOf.length, 2);
  assert.deepEqual(parseToolBridgeResult('{"type":"final","content":"Sunny"}', tools), { kind: 'final', content: 'Sunny' });
  const call = parseToolBridgeResult('{"type":"tool_call","name":"weather","arguments":{"city":"Taipei"}}', tools);
  assert.equal(call.kind, 'tool');
  if (call.kind === 'tool') { assert.equal(call.call.function.name, 'weather'); assert.equal(call.call.function.arguments, '{"city":"Taipei"}'); }
  const objectCall = parseToolBridgeResult({ tool_calls: [{ function: { name: 'weather', arguments: '{"city":"Taipei"}' } }] }, tools);
  assert.equal(objectCall.kind, 'tool');
  assert.deepEqual(parseToolBridgeResult('```json\n{"type":"final","content":"Done"}\n```', tools), { kind: 'final', content: 'Done' });
  assert.deepEqual(parseToolBridgeResult('{"type":"tool_call","name":"unknown","arguments":{}}', tools), { kind: 'final', content: '{"type":"tool_call","name":"unknown","arguments":{}}' });
});
