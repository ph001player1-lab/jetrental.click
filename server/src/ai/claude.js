/**
 * Один запрос к Claude с фото и ответом строго по JSON-схеме — для распознавания
 * договора и «＋ Операция». Модель — из «Настройки» → «Модель ИИ», расход —
 * в ai_usage и в месячный лимит (itSettings.js).
 */

import Anthropic from '@anthropic-ai/sdk';
import { aiSettings, aiAllowed, recordAiUsage } from '../itSettings.js';

export class AiError extends Error {
  constructor(code) { super(code); this.code = code; }
}

let client = null;
const claude = () => {
  // Ключ — ANTHROPIC_API_KEY из /opt/kokon/.env; клиент сам повторяет 429 и 5xx
  if (!client) client = new Anthropic({ timeout: 120_000, maxRetries: 2 });
  return client;
};

/** Фото (по порядку, с подписью «Photo N») и текст → content для запроса */
export function photoContent(images, text) {
  const content = [];
  images.forEach((img, i) => {
    content.push({ type: 'text', text: `Photo ${i}:` });
    content.push({ type: 'image', source: { type: 'base64', media_type: img.type, data: img.data } });
  });
  content.push({ type: 'text', text });
  return content;
}

/** Запрос → разобранный JSON. Возвращает { result, model, usd } */
export async function askStructured({ system, content, schema, purpose, staff }) {
  const allowed = aiAllowed();
  if (!allowed.ok) throw new AiError(allowed.code);
  const { model } = aiSettings();
  const params = {
    model,
    max_tokens: 16000,
    system,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content }]
  };
  let response;
  try {
    // Opus и Sonnet: если фильтр безопасности ошибочно откажет — тот же запрос выполнит запасная модель
    response = model === 'claude-haiku-5-5'
      ? await claude().messages.create(params)
      : await claude().beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new AiError('ai_bad_key');
    if (err instanceof Anthropic.RateLimitError) throw new AiError('ai_busy');
    if (err instanceof Anthropic.APIConnectionError) throw new AiError('ai_unreachable');
    if (err instanceof Anthropic.APIError) {
      console.error(`Claude error ${err.status}: ${err.message}`);
      throw new AiError(err.status === 400 ? 'ai_bad_photo' : 'ai_failed');
    }
    throw err;
  }
  const usd = recordAiUsage({
    model, inputTokens: response.usage?.input_tokens || 0, outputTokens: response.usage?.output_tokens || 0,
    purpose, by: staff?.email || null
  });
  if (response.stop_reason === 'refusal') throw new AiError('ai_refused');
  if (response.stop_reason === 'max_tokens') throw new AiError('ai_failed');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { result: JSON.parse(text), model, usd };
  } catch {
    throw new AiError('ai_failed');
  }
}
