# ai-cascade

> Multi-provider LLM fallback cascade with cost tracking. Groq → Anthropic → OpenAI → Gemini → emergency fallback. Always returns a response. Zero dependencies.

[![npm version](https://img.shields.io/npm/v/ai-cascade.svg)](https://npmjs.com/package/ai-cascade)
[![license](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)

Built by [Brennan Zambo](https://zambo.dev) — extracted from the production AI stack powering [zambo.dev](https://zambo.dev) (ZAMBOT, ZAMBRO, LeadSignal, ProvibeCode, 28 MCP tools).

---

## What it does

`ai-cascade` runs your LLM request through an ordered list of providers. If the first fails (rate limit, timeout, bad response), it instantly falls to the next — tracking cost and latency the whole way. A hardcoded emergency fallback means your app **never crashes** because an AI provider is down.

This is the pattern that lets zambo.dev serve thousands of AI requests per day without a single error surfaced to users.

---

## Install

```bash
npm install ai-cascade
```

Zero dependencies. Node.js 18+. Works in any runtime with `fetch`.

---

## Quick start

```typescript
import { createCascade } from 'ai-cascade';

const ai = createCascade({
  providers: [
    { name: 'groq',      apiKey: process.env.GROQ_API_KEY! },
    { name: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY! },
    { name: 'openai',    apiKey: process.env.OPENAI_API_KEY! },
  ],
  emergencyFallback: 'Service temporarily unavailable. Please try again.',
  onFallback: (from, to, reason) => {
    console.log(`Fell back from ${from} to ${to}: ${reason}`);
  },
});

// Use anywhere — never throws
const result = await ai.complete({
  messages: [{ role: 'user', content: 'Explain quantum entanglement simply.' }],
  maxTokens: 512,
});

console.log(result.text);        // the response
console.log(result.provider);    // 'groq' | 'anthropic' | 'openai' | 'emergency'
console.log(result.model);       // exact model that responded
console.log(result.costUsd);     // e.g. 0.0000087
console.log(result.latencyMs);   // e.g. 834
console.log(result.fallbackChain); // ['groq'] if groq failed and anthropic responded
```

---

## One-shot usage

```typescript
import { cascade } from 'ai-cascade';

const result = await cascade({
  providers: [
    { name: 'groq',   apiKey: process.env.GROQ_API_KEY! },
    { name: 'openai', apiKey: process.env.OPENAI_API_KEY! },
  ],
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user',   content: 'What is the capital of France?' },
  ],
  maxTokens: 128,
  temperature: 0.3,
});
```

---

## Supported providers

| Provider | Models (defaults) | Auth |
|----------|-------------------|------|
| `groq` | llama-3.3-70b-versatile, llama-3.1-8b-instant, gemma2-9b-it | `GROQ_API_KEY` |
| `anthropic` | claude-3-haiku-20240307, claude-3-5-haiku-20241022 | `ANTHROPIC_API_KEY` |
| `openai` | gpt-4o-mini, gpt-4o | `OPENAI_API_KEY` |
| `gemini` | gemini-1.5-flash, gemini-1.5-pro | `GEMINI_API_KEY` |

Override defaults per provider:

```typescript
{ name: 'groq', apiKey: '...', models: ['llama-3.1-8b-instant'] }
```

---

## Cost tracking

`ai-cascade` tracks approximate cost using built-in per-model pricing (updated regularly):

```typescript
const result = await ai.complete({ messages });

console.log(`Cost: $${result.costUsd?.toFixed(6)}`);  // e.g. $0.000012
```

Calculate cost for specific token counts:

```typescript
import { estimateCallCost, MODEL_PRICING } from 'ai-cascade';

const cost = estimateCallCost('llama-3.3-70b-versatile', 500, 250);
// → 0.00000049 (approx)

console.log(MODEL_PRICING['gpt-4o-mini']);
// → { input: 0.15, output: 0.60 }  (per 1M tokens)
```

---

## Budget enforcement

```typescript
const result = await cascade({
  providers: [...],
  maxCostUsd: 0.01,   // stop trying providers if cumulative cost exceeds $0.01
  messages,
});
```

---

## Custom base URLs (proxies, local models)

```typescript
{
  name: 'openai',
  apiKey: 'sk-...',
  baseUrl: 'http://localhost:11434/v1',  // Ollama or any OpenAI-compat endpoint
  models: ['mistral'],
}
```

---

## API

### `cascade(options): Promise<CascadeResult>`

Run a one-shot cascade call.

### `createCascade(defaults): CascadeInstance`

Create a reusable instance with pre-configured providers. The instance exposes `.complete(overrides)`.

### `estimateCallCost(model, inputTokens, outputTokens): number | null`

Estimate cost in USD for a specific model and token counts.

### `supportedProviders(): ProviderName[]`

Returns `['groq', 'anthropic', 'openai', 'gemini']`.

---

## CascadeResult

```typescript
interface CascadeResult {
  text: string;                          // the LLM response
  provider: ProviderName | 'emergency'; // which provider responded
  model: string;                        // exact model used
  costUsd: number | null;              // approximate cost in USD
  latencyMs: number;                   // time to response in ms
  fallbackChain: ProviderName[];       // providers tried before this one
  isEmergencyFallback: boolean;        // true if all providers failed
}
```

---

## Why not just use the provider SDKs directly?

- **No resilience**: if Groq rate-limits you at 3am, your app errors.
- **No cost visibility**: you find out what you spent when the invoice arrives.
- **No fallback**: every provider has outages. A cascade means zero downtime.
- **Multiple SDKs**: four different APIs, four different error formats, four different retry strategies.

`ai-cascade` collapses all of that into one function call.

---

## Related

- [groq-cascade](https://github.com/zambodotdev/groq-cascade) — Groq-only version (simpler)
- [mcp-shield](https://github.com/zambodotdev/mcp-shield) — security middleware for MCP servers
- [agent-ledger](https://github.com/zambodotdev/agent-ledger) — track every LLM call and cost
- [zambo.dev](https://zambo.dev) — 28 MCP tools all powered by ai-cascade in production

---

## License

MIT © [Brennan Zambo](https://zambo.dev)
