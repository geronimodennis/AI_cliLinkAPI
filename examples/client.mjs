// npm install openai in your client project. Do not log the private config.
import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(process.env.AICLITOAIAPI_CONFIG, 'utf8'));
const client = new OpenAI({ baseURL: 'http://127.0.0.1:3000/v1', apiKey: config.auth.apiKey, maxRetries: 0 });
const catalog = await client.models.list();
const model = catalog.data[0]?.id;
if (!model) throw new Error('No available Codex models');
const result = await client.chat.completions.create({
  model, reasoning_effort: 'low',
  messages: [{ role: 'user', content: 'Summarize the project without modifying files.' }]
}, { headers: { 'X-Workspace-ID': 'project-a' } });
console.log(result.choices[0].message.content);
