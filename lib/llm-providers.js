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

const DEFAULT_TIMEOUT = 30000;

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
  evidence += '\nIMPORTANT: Answer the claim using ONLY the evidence above. ';
  evidence += 'If the evidence does not support or contradicts the claim, say so. ';
  evidence += 'Do not use your training data.';

  return evidence;
}

/**
 * Heuristic fallback response when no LLM provider is available.
 * @param {string} claim
 * @param {string[]|null} customPropositions - Optional user-supplied sub-claim questions
 * @returns {Object}
 */
function simulateLLMResponse(claim, customPropositions) {
  const text = claim.toLowerCase();
  const trustedOutlets = ['reuters', 'bbc', 'who', 'doh', 'pagasa', 'phivolcs', 'comelec'];
  const misinformationIndicators = ['fake', 'hoax', 'false', 'unverified', 'rumor'];
  const hasTrusted = trustedOutlets.some(k => text.includes(k));
  const hasMisinfo = misinformationIndicators.some(k => text.includes(k));

  let propositions;

  if (customPropositions && customPropositions.length > 0) {
    const letters = 'pq';
    propositions = customPropositions.map((q, i) => {
      const qLower = q.toLowerCase();
      const qHasTrusted = trustedOutlets.some(k => qLower.includes(k));
      const qHasMisinfo = misinformationIndicators.some(k => qLower.includes(k));
      return {
        letter: letters[i] || ('prop' + (i + 1)),
        text: q,
        value: (qHasTrusted || hasTrusted) && !qHasMisinfo,
        explanation: (qHasTrusted || hasTrusted) && !qHasMisinfo
          ? 'Contains reference to a trusted outlet or source.'
          : 'No strong trusted-source signal detected in question or claim.'
      };
    });
  } else {
    propositions = [
      {
        letter: 'p',
        text: `The claim "${claim.slice(0, 60)}..." aligns with known trusted reporting or official statements.`,
        value: hasTrusted && !hasMisinfo,
        explanation: hasTrusted && !hasMisinfo ? 'Contains reference to a trusted outlet.' : 'No strong trusted-source signal detected.'
      },
      {
        letter: 'q',
        text: `The claim "${claim.slice(0, 60)}..." does not contain common misinformation indicators.`,
        value: !hasMisinfo,
        explanation: hasMisinfo ? 'Contains words often associated with misinformation.' : 'No obvious misinformation indicators found.'
      }
    ];
  }

  const conjunctionResult = propositions.every(p => p.value);
  return { propositions, conjunction_result: conjunctionResult };
}

/**
 * Call a single provider and return parsed result or throw.
 * @param {Provider} provider
 * @param {string} claim
 * @param {string|null} searchEvidence - formatted evidence string (or null)
 * @param {string[]|null} customPropositions - optional user-supplied sub-claim questions
 * @returns {Promise<Object>}
 */
async function callProvider(provider, claim, searchEvidence, customPropositions) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);

  let prompt;

  if (customPropositions && customPropositions.length > 0) {
    if (customPropositions.length !== 2) {
      throw new Error(`Exactly 2 custom propositions required, got ${customPropositions.length}`);
    }
    const letters = 'pq';
    const questionList = customPropositions.map((q, i) =>
      `${letters[i]}. ${q}`
    ).join('\n');
    const propBlocks = customPropositions.map((q, i) =>
      `    {"letter":"${letters[i]}","text":"${q}","value":true,"explanation":"..."}`
    ).join(',\n');
    prompt = `You are a strict fact-checking assistant. Evaluate each sub-claim question below as TRUE or FALSE based ONLY on the provided evidence.

Return ONLY a JSON object (no markdown, no extra text):
{
  "propositions": [
${propBlocks}
  ]
}

CRITICAL: The "text" field for each proposition MUST be the EXACT question from the list below. Do not modify the question text.

Claim: "${claim}"

Sub-claim questions to evaluate:
${questionList}`;
    if (searchEvidence) {
      prompt += `\n${searchEvidence}`;
    }
  } else {
    prompt = `You are a strict fact-checking assistant. Given the following claim, evaluate it and return ONLY a JSON object (no markdown, no extra text) in this exact structure:
{
  "propositions": [
    {"letter":"p","text":"...","value":true,"explanation":"..."},
    {"letter":"q","text":"...","value":true,"explanation":"..."}
  ]
}
Return EXACTLY 2 propositions (p and q). Each proposition should be a verifiable sub-claim. Set value to true if supported, false if contradicted or unsupported. Claim: "${claim}"`;
    if (searchEvidence) {
      prompt += `\n${searchEvidence}`;
    }
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

  const conjunctionResult = parsed.propositions.every(p => typeof p.value === 'boolean' && p.value);
  return { propositions: parsed.propositions, conjunction_result: conjunctionResult };
}

/**
 * Try each provider in order, falling over on failure.
 * @param {string} claim
 * @param {string|null} searchEvidence - formatted evidence string (or null)
 * @param {string[]|null} customPropositions - optional user-supplied sub-claim questions
 * @returns {Promise<{propositions: Array, conjunction_result: boolean, provider: string}>}
 */
async function callLLM(claim, searchEvidence, customPropositions) {
  if (providers.length === 0) {
    console.warn('[llm-providers] No providers configured, using heuristic fallback');
    return { ...simulateLLMResponse(claim, customPropositions), provider: 'heuristic', warnings: ['No LLM providers configured, using heuristic fallback'] };
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
      const result = await callProvider(provider, claim, searchEvidence, customPropositions);
      if (customPropositions && result.propositions && result.propositions.length > 0) {
        result.propositions.forEach((prop, i) => {
          if (i < customPropositions.length) {
            prop.text = customPropositions[i];
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

  console.warn('[llm-providers] All providers failed, using heuristic fallback');
  if (warnings.length === 0) {
    warnings.push('All LLM providers failed. Using heuristic fallback.');
  } else {
    warnings.push('All available providers exhausted. Using heuristic fallback.');
  }
  return { ...simulateLLMResponse(claim, customPropositions), provider: 'heuristic', warnings, rateLimitedProviders };
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
  simulateLLMResponse,
  formatSearchEvidence,
  filterSupportingSources,
  getProviders,
  getProviderStats,
  providers
};
