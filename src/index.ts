/**
 * ai-cascade — Multi-provider LLM fallback cascade with cost tracking
 * Groq → Anthropic → OpenAI → Gemini → emergency hardcoded fallback
 * Zero dependencies. Extracted from zambo.dev production stack.
 *
 * github.com/zambodotdev/ai-cascade
 * zambo.dev/opensource
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type ProviderName = 'groq' | 'anthropic' | 'openai' | 'gemini';

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderConfig {
  name: ProviderName;
  apiKey: string;
  /** Override the default model(s) for this provider */
  models?: string[];
  /** Request timeout in ms (default: 15000) */
  timeoutMs?: number;
  /** Base URL override (for proxies / local models) */
  baseUrl?: string;
}

export interface CascadeOptions {
  /** Ordered list of providers to try. First = primary. */
  providers: ProviderConfig[];
  /** The messages to send to the LLM */
  messages: Message[];
  /** Minimum character length for a valid response (default: 20) */
  minLength?: number;
  /** Hard budget per cascade call in USD (default: no limit) */
  maxCostUsd?: number;
  /** Called whenever the cascade falls back to a lower-priority provider */
  onFallback?: (from: ProviderName, to: ProviderName, reason: string) => void;
  /** Emergency fallback text if ALL providers fail (default: generic error) */
  emergencyFallback?: string;
  /** Max tokens to request (default: 1024) */
  maxTokens?: number;
  /** Temperature (default: 0.7) */
  temperature?: number;
}

export interface CascadeResult {
  text: string;
  provider: ProviderName | 'emergency';
  model: string;
  /** Approximate cost in USD (null if provider pricing unknown) */
  costUsd: number | null;
  /** Time to first byte in ms */
  latencyMs: number;
  /** Which providers were attempted before this one */
  fallbackChain: ProviderName[];
  /** Whether the emergency hardcoded fallback was used */
  isEmergencyFallback: boolean;
}

// ── Provider Pricing (per 1M tokens, approximate) ─────────────────────────

const PRICING: Record<string, { input: number; output: number }> = {
  // Groq
  'llama-3.3-70b-versatile':                { input: 0.59,  output: 0.79 },
  'llama-3.1-8b-instant':                   { input: 0.05,  output: 0.08 },
  'llama-4-scout-17b-16e-instruct':         { input: 0.11,  output: 0.34 },
  'gemma2-9b-it':                           { input: 0.20,  output: 0.20 },
  'qwen-qwq-32b':                           { input: 0.29,  output: 0.39 },
  'mixtral-8x7b-32768':                     { input: 0.24,  output: 0.24 },
  // Anthropic
  'claude-3-haiku-20240307':                { input: 0.25,  output: 1.25 },
  'claude-3-5-haiku-20241022':              { input: 0.80,  output: 4.00 },
  'claude-3-5-sonnet-20241022':             { input: 3.00,  output: 15.00 },
  'claude-opus-4-5':                        { input: 15.00, output: 75.00 },
  // OpenAI
  'gpt-4o-mini':                            { input: 0.15,  output: 0.60 },
  'gpt-4o':                                 { input: 2.50,  output: 10.00 },
  'gpt-4o-mini-2024-07-18':                 { input: 0.15,  output: 0.60 },
  // Gemini
  'gemini-1.5-flash':                       { input: 0.075, output: 0.30 },
  'gemini-1.5-pro':                         { input: 1.25,  output: 5.00 },
  'gemini-2.0-flash-exp':                   { input: 0.075, output: 0.30 },
};

const DEFAULT_MODELS: Record<ProviderName, string[]> = {
  groq:      ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'],
  anthropic: ['claude-3-haiku-20240307', 'claude-3-5-haiku-20241022'],
  openai:    ['gpt-4o-mini', 'gpt-4o'],
  gemini:    ['gemini-1.5-flash', 'gemini-1.5-pro'],
};

// ── Token estimator (rough — 1 token ≈ 4 chars) ───────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateCost(model: string, inputText: string, outputText: string): number | null {
  const pricing = PRICING[model];
  if (!pricing) return null;
  const inputTokens = estimateTokens(inputText) / 1_000_000;
  const outputTokens = estimateTokens(outputText) / 1_000_000;
  return inputTokens * pricing.input + outputTokens * pricing.output;
}

// ── Provider Adapters ──────────────────────────────────────────────────────

interface ProviderAttempt {
  text: string;
  model: string;
}

function messagesToText(messages: Message[]): string {
  return messages.map(m => `${m.role}: ${m.content}`).join('\n');
}

async function tryGroq(
  cfg: ProviderConfig,
  messages: Message[],
  maxTokens: number,
  temperature: number,
): Promise<ProviderAttempt> {
  const model = (cfg.models ?? DEFAULT_MODELS.groq)[0];
  const baseUrl = cfg.baseUrl ?? 'https://api.groq.com/openai/v1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 15000);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Groq ${res.status}: ${await res.text()}`);
    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('Groq returned empty content');
    return { text, model };
  } finally {
    clearTimeout(timer);
  }
}

async function tryAnthropic(
  cfg: ProviderConfig,
  messages: Message[],
  maxTokens: number,
  temperature: number,
): Promise<ProviderAttempt> {
  const model = (cfg.models ?? DEFAULT_MODELS.anthropic)[0];
  const baseUrl = cfg.baseUrl ?? 'https://api.anthropic.com/v1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 15000);

  // Separate system from user/assistant messages
  const systemMsg = messages.find(m => m.role === 'system')?.content;
  const chatMsgs = messages.filter(m => m.role !== 'system');

  try {
    const body: Record<string, unknown> = {
      model,
      messages: chatMsgs,
      max_tokens: maxTokens,
      temperature,
    };
    if (systemMsg) body['system'] = systemMsg;

    const res = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data = await res.json() as {
      content: Array<{ type: string; text: string }>;
    };
    const text = data.content?.find(b => b.type === 'text')?.text ?? '';
    if (!text) throw new Error('Anthropic returned empty content');
    return { text, model };
  } finally {
    clearTimeout(timer);
  }
}

async function tryOpenAI(
  cfg: ProviderConfig,
  messages: Message[],
  maxTokens: number,
  temperature: number,
): Promise<ProviderAttempt> {
  const model = (cfg.models ?? DEFAULT_MODELS.openai)[0];
  const baseUrl = cfg.baseUrl ?? 'https://api.openai.com/v1';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 15000);

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const text = data.choices?.[0]?.message?.content ?? '';
    if (!text) throw new Error('OpenAI returned empty content');
    return { text, model };
  } finally {
    clearTimeout(timer);
  }
}

async function tryGemini(
  cfg: ProviderConfig,
  messages: Message[],
  maxTokens: number,
  temperature: number,
): Promise<ProviderAttempt> {
  const model = (cfg.models ?? DEFAULT_MODELS.gemini)[0];
  const baseUrl = cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 15000);

  // Convert to Gemini format
  const systemInstr = messages.find(m => m.role === 'system')?.content;
  const geminiMsgs = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  try {
    const body: Record<string, unknown> = {
      contents: geminiMsgs,
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    };
    if (systemInstr) body['systemInstruction'] = { parts: [{ text: systemInstr }] };

    const res = await fetch(
      `${baseUrl}/models/${model}:generateContent?key=${cfg.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = await res.json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) throw new Error('Gemini returned empty content');
    return { text, model };
  } finally {
    clearTimeout(timer);
  }
}

const PROVIDER_FNS: Record<ProviderName, typeof tryGroq> = {
  groq: tryGroq,
  anthropic: tryAnthropic,
  openai: tryOpenAI,
  gemini: tryGemini,
};

// ── Main cascade function ─────────────────────────────────────────────────

/**
 * Run a single LLM request through a provider cascade.
 * Falls through to each next provider on failure. Never throws.
 *
 * @example
 * const result = await cascade({
 *   providers: [
 *     { name: 'groq', apiKey: process.env.GROQ_API_KEY! },
 *     { name: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! },
 *   ],
 *   messages: [{ role: 'user', content: 'Explain quantum entanglement simply.' }],
 * });
 * console.log(result.text);       // the response
 * console.log(result.provider);   // 'groq' | 'anthropic' | ...
 * console.log(result.costUsd);    // e.g. 0.000012
 * console.log(result.latencyMs);  // e.g. 843
 */
export async function cascade(options: CascadeOptions): Promise<CascadeResult> {
  const {
    providers,
    minLength = 20,
    maxCostUsd,
    onFallback,
    emergencyFallback = 'I encountered an issue processing your request. Please try again.',
    maxTokens = 1024,
    temperature = 0.7,
  } = options;

  const fallbackChain: ProviderName[] = [];
  let accumulatedCost = 0;
  const inputText = messagesToText(options.messages);

  for (let i = 0; i < providers.length; i++) {
    const cfg = providers[i];
    const providerFn = PROVIDER_FNS[cfg.name];
    if (!providerFn) continue;

    // Budget check before attempting
    if (maxCostUsd !== undefined && accumulatedCost >= maxCostUsd) break;

    const start = Date.now();
    try {
      const attempt = await providerFn(cfg, options.messages, maxTokens, temperature);

      if (!attempt.text || attempt.text.length < minLength) {
        throw new Error(`Response too short (${attempt.text.length} chars, min ${minLength})`);
      }

      const latencyMs = Date.now() - start;
      const cost = estimateCost(attempt.model, inputText, attempt.text);
      if (cost !== null) accumulatedCost += cost;

      return {
        text: attempt.text,
        provider: cfg.name,
        model: attempt.model,
        costUsd: cost,
        latencyMs,
        fallbackChain,
        isEmergencyFallback: false,
      };
    } catch (e) {
      const reason = (e as Error).message;
      fallbackChain.push(cfg.name);

      if (i < providers.length - 1) {
        onFallback?.(cfg.name, providers[i + 1].name, reason);
      }
      // continue to next provider
    }
  }

  // Emergency fallback — never throws, never returns undefined
  return {
    text: emergencyFallback,
    provider: 'emergency',
    model: 'hardcoded-fallback',
    costUsd: 0,
    latencyMs: 0,
    fallbackChain,
    isEmergencyFallback: true,
  };
}

// ── Reusable instance ─────────────────────────────────────────────────────

export interface CascadeInstance {
  complete: (opts: Omit<CascadeOptions, 'providers'>) => Promise<CascadeResult>;
  providers: ProviderConfig[];
}

/**
 * Create a reusable cascade instance with pre-configured providers.
 *
 * @example
 * const ai = createCascade({
 *   providers: [
 *     { name: 'groq',      apiKey: process.env.GROQ_API_KEY! },
 *     { name: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! },
 *     { name: 'openai',    apiKey: process.env.OPENAI_API_KEY! },
 *   ],
 *   emergencyFallback: 'Service temporarily unavailable.',
 * });
 *
 * // Use anywhere in your app:
 * const result = await ai.complete({
 *   messages: [{ role: 'user', content: prompt }],
 *   maxTokens: 512,
 * });
 */
export function createCascade(defaults: CascadeOptions): CascadeInstance {
  return {
    providers: defaults.providers,
    complete: (overrides) =>
      cascade({
        ...defaults,
        ...overrides,
        providers: defaults.providers,
      }),
  };
}

/** Get the list of supported provider names */
export function supportedProviders(): ProviderName[] {
  return ['groq', 'anthropic', 'openai', 'gemini'];
}

/** Approximate per-call cost given a model and token counts */
export function estimateCallCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const pricing = PRICING[model];
  if (!pricing) return null;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export { PRICING as MODEL_PRICING };
