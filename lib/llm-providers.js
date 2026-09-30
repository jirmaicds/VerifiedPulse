const fetch = require('node-fetch');

/**
 * Automatic LLM Provider Rotation System
 * ======================================
 * Maintains a pool of LLM providers and automatically rotates/falls over
 * between them when one is unavailable or returns errors.
 *
 * Strategy:
 *   - "priority" (default): Try providers in defined priority order; on failure,
 *     move to the next. This maximizes the chance of getting a response.
 *   - "round-robin": Rotate through providers on each request, with failover
 *     to the next if the selected one fails.
 *
 * Statistics (success/fail counts, last error) are tracked per provider and
 * exposed via getProviderStats() for monitoring.
 */

const DEFAULT_TIMEOUT = 10000;

/**
 * Fixed proposition definitions used when no custom propositions are supplied.
 * P and Q are always evaluated with these exact questions.
 */
const FIXED_PROPOSITIONS = [
  { letter: 'p', text: 'The claim is backed by an official statement, announcement, or memorandum.' },
  { letter: 'q', text: 'The information is confirmed by a credible news outlet, fact-checking organization, or recognized expert institution.' }
];

const strategies = {
  priority: {
    getOrder(providers) {
      return providers.map((_, i) => i);
    }
  },
  'round-robin': {
    currentIndex: 0,
    getOrder(providers) {
      const order = [];
      const n = providers.length;
      for (let i = 0; i < n; i++) {
        order.push((this.currentIndex + i) % n);
      }
      this.currentIndex = (this.currentIndex + 1) % n;
      return order;
    }
  }
};

function createProvider(name, baseUrl, apiKey, model) {
  return {
    name,
    baseUrl,
    apiKey,
    model,
    suspendedUntil: null,
    stats: {
      calls: 0,
      successes: 0,
      failures: 0,
      lastError: null,
      lastUsed: null,
      rateLimitCount: 0
    }
  };
}

function buildProviders() {
  const env = process.env;
  const pool = [];

  // 1. OpenRouter
  if (env.OPENROUTER_API_KEY) {
    pool.push(createProvider(
      'openrouter',
      'https://openrouter.ai/api/v1/chat/completions',
      env.OPENROUTER_API_KEY,
      env.OPENROUTER_MODEL || 'openrouter/free'
    ));
  }

  // 2. Groq
  if (env.GROQ_API_KEY) {
    pool.push(createProvider(
      'groq',
      'https://api.groq.com/openai/v1/chat/completions',
      env.GROQ_API_KEY,
      env.GROQ_MODEL || 'llama-3.1-8b-instant'
    ));
  }

  // 3. Google AI Studio
  if (env.GOOGLE_AI_API_KEY) {
    pool.push(createProvider(
      'google',
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      env.GOOGLE_AI_API_KEY,
      env.GOOGLE_AI_MODEL || 'gemini-3.6-flash'
    ));
  }

  // 4. Legacy OpenAI-compatible
  if (env.LLM_API_KEY) {
    pool.push(createProvider(
      'legacy-openai',
      env.LLM_API_URL || 'https://api.openai.com/v1/chat/completions',
      env.LLM_API_KEY,
      env.LLM_MODEL || 'gpt-4o-mini'
    ));
  }

  return pool;
}

const providers = buildProviders();
const strategyName = (process.env.LLM_PROVIDER_STRATEGY || 'priority').toLowerCase();
const strategy = strategies[strategyName] || strategies.priority;

/**
 * Format search data into prompt context.
 * @param {Object|null} searchData
 * @returns {string}
 */
function formatSearchEvidence(searchData) {
  if (!searchData) return '';

  let evidence = '\n\n=== WEB SEARCH EVIDENCE ===\n';

  if (searchData.answer) {
    evidence += `Synthesized Answer: ${searchData.answer}\n\n`;
  }

  if (searchData.results && Array.isArray(searchData.results)) {
    evidence += 'Sources:\n';
    searchData.results.forEach((r, i) => {
      evidence += `[${i + 1}] ${r.title || 'Untitled'}\n`;
      evidence += `    URL: ${r.url || ''}\n`;
      evidence += `    Content: ${(r.content || '').slice(0, 500)}\n\n`;
    });
  }

  if (searchData.organic && Array.isArray(searchData.organic)) {
    evidence += 'Sources:\n';
    searchData.organic.forEach((r, i) => {
      evidence += `[${i + 1}] ${r.title || 'Untitled'}\n`;
      evidence += `    URL: ${r.link || ''}\n`;
      evidence += `    Content: ${(r.snippet || '').slice(0, 500)}\n\n`;
    });
  }

  evidence += '=== END EVIDENCE ===\n';
  evidence += '\nIMPORTANT: You MUST evaluate each proposition using ONLY the evidence above. ';
  evidence += 'For each proposition, determine whether the evidence provides positive support. ';
  evidence += 'If a source from a recognized institution (government, news, university, etc.) supports the claim, mark the proposition VERIFIED. ';
  evidence += 'If a source contradicts the claim, mark the proposition REFUTED. ';
  evidence += 'If the evidence is insufficient, silent, or does not address the claim at all, mark the proposition UNVERIFIED — absence of a source is not refutation. ';
  evidence += 'Do not use your training data or general knowledge. ';
  evidence += 'Your explanation must cite specific sources by title or domain.';

  return evidence;
}

/**
 * Call a single provider and return parsed result or throw.
 * @param {Provider} provider
 * @param {string} claim
 * @param {string|null} searchEvidence - formatted evidence string (or null)
 * @returns {Promise<Object>}
 */
async function callProvider(provider, claim, searchEvidence) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  let prompt = `You are a strict fact-checking assistant. Given the following claim, evaluate it and return ONLY a JSON object (no markdown, no extra text) in this exact structure:
{
  "propositions": [
    {"letter":"p","text":"...","value":true,"state":"verified","explanation":"..."},
    {"letter":"q","text":"...","value":true,"state":"verified","explanation":"..."}
  ]
}
Return EXACTLY 2 propositions (p and q). Evaluate these two FIXED propositions against the provided evidence:

- p: "The claim is backed by an official statement, announcement, or memorandum." — true if an official/government/institutional statement, announcement, or memorandum supports the claim. This includes government issuances, **school/university holiday advisories, institutional memos, organizational announcements**, and similar authoritative communications from recognized institutions; false otherwise.
- q: "The information is confirmed by a credible news outlet, fact-checking organization, or recognized expert institution." — true only if a credible news outlet, fact-checker, or recognized expert institution CONFIRMS that the claim is accurate, i.e. states it as established fact on its own authority. Merely repeating, mentioning, or covering the claim without vouching for it is NOT confirmation. "**Recognized expert institution** includes **accredited universities, colleges, schools, research institutes, professional bodies**, and similar authoritative organizations in their domain; false otherwise.

Set "text" to the exact question text shown above. Claim: "${claim}"

THREE-STATE EVALUATION — each proposition carries both a boolean "value" and a "state":
  {"letter":"p","text":"...","value":true,"state":"verified","explanation":"..."}
  {"letter":"q","text":"...","value":false,"state":"unverified","explanation":"..."}

  state = "verified"    the evidence positively supports the proposition
  state = "unverified"  the evidence neither supports nor contradicts it (insufficient, off-topic, or no source addresses it)
  state = "refuted"     the evidence contradicts the proposition, or an authoritative source denies it

  value = (state === "verified")

CRITICAL: Do NOT collapse "unverified" into "false". These are different findings and are scored differently:
- "unverified" means the evidence is silent. A claim no one has reported on yet is unverified, not refuted.
- "refuted" requires evidence that contradicts the claim. The absence of a source is NOT refutation.
- value is false for BOTH "unverified" and "refuted", but state must be set correctly so risk scoring can distinguish them.
- A claim may be a genuine misinterpretation of a real event: the subject is real, but the claim distorts it. Detect this case and state it in the explanation.

IMPORTANT EVIDENCE-BASED REASONING:
- You MUST use the WEB SEARCH EVIDENCE provided below to make your determination. Do NOT rely on your training data or general knowledge.
- For proposition p: Look for any official statement, announcement, memorandum, or institutional communication that supports the claim. If such a source exists, set p to "verified". If a source contradicts it, set p to "refuted". If no source addresses it, set p to "unverified".
- For proposition q: Look for a credible news outlet, fact-checking organization, or recognized expert institution that CONFIRMS the claim is accurate as established fact. Repetition is not confirmation: if sources only cover, repeat, or react to the claim without vouching for it, q is "unverified", not "verified". If a source disputes it, set q to "refuted". If no source addresses it, set q to "unverified" — do NOT default to "refuted" here.
- If the search returned sources that do not actually address the claim's subject, treat their silence as "unverified" and say so in the explanation.
- Your explanation MUST reference specific sources from the evidence. Cite the source title or domain and explain how it supports or contradicts the proposition.
- Be objective: if a source from a recognized institution supports the claim, mark the relevant proposition "verified" even if you personally disagree with the claim.`;

  if (searchEvidence) {
    prompt += `\n${searchEvidence}`;
  }

  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: 'You are a strict JSON-only fact-checking assistant. Base your verdict ONLY on provided evidence.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2
  };

  const res = await fetch(provider.baseUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify(body),
    signal: controller.signal
  });

  clearTimeout(timeoutId);

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) {
      throw new Error(`Rate limited (HTTP 429): ${text.slice(0, 200)}`);
    }
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  let content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!content) {
    throw new Error('Empty content in LLM response');
  }

  let parsed;
  try {
    let clean = content.trim();
    const match = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) clean = match[1].trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error(`JSON parse error: ${e.message}. Content: ${content.slice(0, 200)}`);
  }

  if (!parsed.propositions || !Array.isArray(parsed.propositions)) {
    throw new Error('Invalid response shape: missing propositions array');
  }

  if (parsed.propositions.length !== 2) {
    throw new Error(`Invalid response: expected exactly 2 propositions, got ${parsed.propositions.length}`);
  }

  const { normalizeValue } = require('./risk');

  const propositions = parsed.propositions.map((p) => {
    const state = normalizeValue(p.state !== undefined ? p.state : p.value);
    return { ...p, state, value: state === 'true' };
  });

  const conjunctionResult = propositions.every(p => p.value === true);
  return { propositions, conjunction_result: conjunctionResult };
}

/**
 * Try each provider in order, falling over on failure.
 * @param {string} claim
 * @param {string|null} searchEvidence - formatted evidence string (or null)
 * @returns {Promise<{propositions: Array, conjunction_result: boolean, provider: string}>}
 */
async function callLLM(claim, searchEvidence) {
  if (providers.length === 0) {
    throw new Error('No working LLM');
  }

  const now = Date.now();
  const order = strategy.getOrder(providers);
  const warnings = [];
  const rateLimitedProviders = [];

  for (const idx of order) {
    const provider = providers[idx];
    if (!provider) continue;

    if (provider.suspendedUntil && provider.suspendedUntil > now) {
      warnings.push(`${provider.name} (${provider.model}) is temporarily suspended due to rate limiting.`);
      rateLimitedProviders.push({ name: provider.name, model: provider.model, until: new Date(provider.suspendedUntil).toISOString() });
      continue;
    }

    provider.stats.calls += 1;
    provider.stats.lastUsed = new Date();
    console.log(`[llm-providers] Attempting provider: ${provider.name} (model: ${provider.model})`);

    try {
      const result = await callProvider(provider, claim, searchEvidence);
      if (result.propositions && result.propositions.length > 0) {
        result.propositions.forEach((prop, i) => {
          if (i < FIXED_PROPOSITIONS.length) {
            prop.text = FIXED_PROPOSITIONS[i].text;
          }
        });
      }
      provider.stats.successes += 1;
      provider.stats.lastError = null;
      console.log(`[llm-providers] Provider ${provider.name} succeeded`);

      if (warnings.length > 0) {
        warnings.push(`Successfully switched to ${provider.name} (${provider.model}).`);
      }

      return { ...result, provider: provider.name, warnings, rateLimitedProviders };
    } catch (err) {
      provider.stats.failures += 1;
      provider.stats.lastError = err.message;

      if (err.message && /rate.limit|quota|limit.exceeded|too.many.requests|429/i.test(err.message)) {
        provider.suspendedUntil = Date.now() + (5 * 60 * 1000);
        provider.stats.rateLimitCount = (provider.stats.rateLimitCount || 0) + 1;
        warnings.push(`${provider.name} (${provider.model}) has reached its rate limit. Trying next provider...`);
        rateLimitedProviders.push({ name: provider.name, model: provider.model, until: new Date(provider.suspendedUntil).toISOString() });
        console.error(`[llm-providers] Provider ${provider.name} rate-limited: ${err.message}`);
        continue;
      }

      console.error(`[llm-providers] Provider ${provider.name} failed: ${err.message}`);
    }
  }

  throw new Error('No working LLM');
}

/**
 * Returns the raw providers array.
 * @returns {Provider[]}
 */
function getProviders() {
  return providers.map(p => ({
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    stats: {
      ...p.stats,
      lastUsed: p.stats.lastUsed ? p.stats.lastUsed.toISOString() : null,
      rateLimitCount: p.stats.rateLimitCount || 0,
      suspendedUntil: p.suspendedUntil || null
    }
  }));
}

/**
 * Returns provider statistics summary.
 * @returns {ProviderStats}
 */
function getProviderStats() {
  return {
    strategy: strategyName,
    totalProviders: providers.length,
    providers: providers.map(p => ({
      name: p.name,
      model: p.model,
      stats: {
        ...p.stats,
        lastUsed: p.stats.lastUsed ? p.stats.lastUsed.toISOString() : null,
        rateLimitCount: p.stats.rateLimitCount || 0,
        suspendedUntil: p.suspendedUntil || null
      }
    }))
  };
}

/**
 * Filter search results to only those relevant to the claim's subject.
 * Uses LLM to determine which sources are actually about the claim's subject
 * (person, place, thing, topic), not just sources that contain claim words.
 * @param {string} claim
 * @param {Object|null} searchEvidence
 * @returns {Promise<Object|null>}
 */
async function filterRelevantSources(claim, searchEvidence) {
  if (!searchEvidence) return searchEvidence;
  if (providers.length === 0) return searchEvidence;

  // Collect sources from both result formats
  const sources = [];
  if (searchEvidence.results && Array.isArray(searchEvidence.results)) {
    searchEvidence.results.forEach((r, i) => {
      sources.push({
        idx: i,
        title: r.title || 'Untitled',
        url: r.url || '',
        content: (r.content || '').slice(0, 300)
      });
    });
  }
  if (searchEvidence.organic && Array.isArray(searchEvidence.organic)) {
    searchEvidence.organic.forEach((r, i) => {
      sources.push({
        idx: i,
        title: r.title || 'Untitled',
        url: r.link || '',
        content: (r.snippet || '').slice(0, 300)
      });
    });
  }

  if (sources.length === 0) return searchEvidence;

  const sourceList = sources.map(s =>
    `[${s.idx}] ${s.title}\nURL: ${s.url}\n${s.content}`
  ).join('\n---\n');

  const prompt = `You are a strict source-relevance filter. Given a claim and search results, determine which results are ACTUALLY ABOUT the claim's subject.

The claim's subject means the main person, place, thing, event, or topic the claim is discussing. A source is relevant ONLY if it discusses that subject - not merely because it contains a word from the claim.

Claim: "${claim}"

Search Results:
${sourceList}

Return ONLY a JSON object (no markdown, no extra text):
{
  "relevantIndices": [0, 2]
}

Only include indices of sources that are genuinely about the claim's subject.`;

  const now = Date.now();
  const order = strategy.getOrder(providers);

  for (const idx of order) {
    const provider = providers[idx];
    if (!provider) continue;
    if (provider.suspendedUntil && provider.suspendedUntil > now) continue;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

      const body = {
        model: provider.model,
        messages: [
          { role: 'system', content: 'You are a strict JSON-only source relevance filter.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1
      };

      const res = await fetch(provider.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = await res.json();
      let content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('Empty content in LLM response');

      let parsed;
      try {
        let clean = content.trim();
        const match = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) clean = match[1].trim();
        parsed = JSON.parse(clean);
      } catch (e) {
        throw new Error(`JSON parse error: ${e.message}`);
      }

      if (!parsed.relevantIndices || !Array.isArray(parsed.relevantIndices)) {
        throw new Error('Invalid response shape: missing relevantIndices array');
      }

      // Filter the search evidence
      const filtered = { ...searchEvidence };
      if (filtered.results && Array.isArray(filtered.results)) {
        filtered.results = filtered.results.filter((_, i) =>
          parsed.relevantIndices.includes(i)
        );
      }
      if (filtered.organic && Array.isArray(filtered.organic)) {
        filtered.organic = filtered.organic.filter((_, i) =>
          parsed.relevantIndices.includes(i)
        );
      }

      // Safety: if filtering removed everything, keep original
      const hasResults = (filtered.results && filtered.results.length > 0) ||
                        (filtered.organic && filtered.organic.length > 0);
      if (!hasResults) {
        console.warn('[filterRelevantSources] Filtering removed all sources, keeping original');
        return searchEvidence;
      }

      console.log(`[filterRelevantSources] Provider ${provider.name} filtered to relevant sources`);
      return filtered;
    } catch (err) {
      console.error(`[filterRelevantSources] Provider ${provider.name} failed:`, err.message);
      continue;
    }
  }

  console.warn('[filterRelevantSources] All providers failed, returning original results');
  return searchEvidence;
}

/**
 * Filter search results to only those that SUPPORT the claim.
 * Uses LLM to determine which sources actually corroborate the claim's
 * subject and verdict, not just sources that contain claim words or are
 * topically related. Sources must actively support the claim to be shown.
 * @param {string} claim
 * @param {Object|null} searchEvidence
 * @returns {Promise<Object|null>}
 */
async function filterSupportingSources(claim, searchEvidence) {
  if (!searchEvidence) return searchEvidence;
  if (providers.length === 0) return searchEvidence;

  // Collect sources from both result formats
  const sources = [];
  if (searchEvidence.results && Array.isArray(searchEvidence.results)) {
    searchEvidence.results.forEach((r, i) => {
      sources.push({
        idx: i,
        title: r.title || 'Untitled',
        url: r.url || '',
        content: (r.content || '').slice(0, 300)
      });
    });
  }
  if (searchEvidence.organic && Array.isArray(searchEvidence.organic)) {
    searchEvidence.organic.forEach((r, i) => {
      sources.push({
        idx: i,
        title: r.title || 'Untitled',
        url: r.link || '',
        content: (r.snippet || '').slice(0, 300)
      });
    });
  }

  if (sources.length === 0) return searchEvidence;

  const sourceList = sources.map(s =>
    `[${s.idx}] ${s.title}\nURL: ${s.url}\n${s.content}`
  ).join('\n---\n');

  const prompt = `You are a strict source-support filter. Given a claim and search results, determine which sources ACTUALLY SUPPORT the claim.

A source supports the claim if it provides evidence, facts, or statements that corroborate or confirm the claim's subject and verdict. A source does NOT support the claim if it:
- Only mentions a word from the claim without discussing the actual subject
- Contradicts or disputes the claim
- Is about an unrelated topic
- Is ambiguous or doesn't provide clear evidence either way

Claim: "${claim}"

Search Results:
${sourceList}

Return ONLY a JSON object (no markdown, no extra text):
{
  "supportingIndices": [0, 2]
}

Only include indices of sources that genuinely support the claim.`;

  const now = Date.now();
  const order = strategy.getOrder(providers);

  for (const idx of order) {
    const provider = providers[idx];
    if (!provider) continue;
    if (provider.suspendedUntil && provider.suspendedUntil > now) continue;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

      const body = {
        model: provider.model,
        messages: [
          { role: 'system', content: 'You are a strict JSON-only source support filter.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1
      };

      const res = await fetch(provider.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = await res.json();
      let content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('Empty content in LLM response');

      let parsed;
      try {
        let clean = content.trim();
        const match = clean.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (match) clean = match[1].trim();
        parsed = JSON.parse(clean);
      } catch (e) {
        throw new Error(`JSON parse error: ${e.message}`);
      }

      if (!parsed.supportingIndices || !Array.isArray(parsed.supportingIndices)) {
        throw new Error('Invalid response shape: missing supportingIndices array');
      }

      // Filter the search evidence
      const filtered = { ...searchEvidence };
      if (filtered.results && Array.isArray(filtered.results)) {
        filtered.results = filtered.results.filter((_, i) =>
          parsed.supportingIndices.includes(i)
        );
      }
      if (filtered.organic && Array.isArray(filtered.organic)) {
        filtered.organic = filtered.organic.filter((_, i) =>
          parsed.supportingIndices.includes(i)
        );
      }

      // Safety: if filtering removed everything, keep original
      const hasResults = (filtered.results && filtered.results.length > 0) ||
                        (filtered.organic && filtered.organic.length > 0);
      if (!hasResults) {
        console.warn('[filterSupportingSources] Filtering removed all sources, keeping original');
        return searchEvidence;
      }

      console.log(`[filterSupportingSources] Provider ${provider.name} filtered to supporting sources`);
      return filtered;
    } catch (err) {
      console.error(`[filterSupportingSources] Provider ${provider.name} failed:`, err.message);
      continue;
    }
  }

  console.warn('[filterSupportingSources] All providers failed, returning original results');
  return searchEvidence;
}

module.exports = {
  callLLM,
  formatSearchEvidence,
  filterSupportingSources,
  filterRelevantSources,
  getProviders,
  getProviderStats,
  providers,
  FIXED_PROPOSITIONS
};
