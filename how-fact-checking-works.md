# How Fact Checking Works in VerifiedPulse

## Overview

VerifiedPulse is a **logical fact-checking system** that evaluates claims using **propositional conjunction logic** (`p ∧ q ≡ T` only if all propositions are true). It combines web search evidence, LLM-based proposition evaluation, and database-backed metrics to determine whether a claim is verified or flagged.

---

## The Fact-Checking Pipeline

### Step 1: User Submits a Claim

The user enters a text claim on the frontend (`index.html`) and optionally defines custom propositions (e.g., "Is this claim supported by credible evidence?"). The claim is sent as a POST request to `/api/check-claim`.

### Step 2: Web Search for Corroborating Evidence

The backend searches the web for evidence related to the claim using one of two methods:

#### Tool: DuckDuckGo HTML Scraper (Default)

- **No API key required** — free to use
- Sends a POST request to `https://html.duckduckgo.com/html/` with the claim as a search query
- Parses the returned HTML using regex to extract result titles, URLs, and snippets
- Configured via `SEARCH_MAX_RESULTS` (default: 5)
- Code location: `lib/check-claim-handler.js` — `searchWeb()` function (lines 6–79)

#### Tool: Tavily Search API (Optional)

- Requires a `SEARCH_API_KEY` (set in `.env`)
- Sends a POST request to `https://api.tavily.com/search` with the claim, depth, and max results
- Returns structured JSON including an AI-synthesized answer and result entries
- Configured via `SEARCH_API_URL` (default: `https://api.tavily.com/search`) and `SEARCH_MAX_RESULTS`
- Code location: `lib/check-claim-handler.js` — `searchWeb()` function (lines 10–39)

#### Tool: Serper / Other Search APIs (Pluggable)

- Any search API can be used by setting `SEARCH_API_KEY` and `SEARCH_API_URL` to the desired endpoint
- The system expects a JSON response with a `results` array containing `title`, `url`, and `content` fields

After retrieving results, if an LLM provider is available, the system runs **source filtering** — a second LLM call that determines which search results actually **support** (corroborate) the claim versus merely mentioning claim keywords. This is implemented in `lib/llm-providers.js` — `filterSupportingSources()` (lines 578–718).

### Step 3: LLM-Based Proposition Evaluation

The claim and filtered search evidence are sent to an **LLM provider** which evaluates the claim and returns structured propositions with TRUE/FALSE values and explanations.

#### Tool: LLM Provider Rotation System

The system supports **multiple LLM providers** with automatic failover. Providers are tried in priority order (or round-robin, depending on `LLM_PROVIDER_STRATEGY`). If one fails, the system automatically tries the next.

**Supported Providers** (configured via environment variables):

| Provider | Env Key | Default Model | Endpoint |
|----------|---------|---------------|----------|
| **OpenRouter** | `OPENROUTER_API_KEY` | `openrouter/free` | `https://openrouter.ai/api/v1/chat/completions` |
| **Groq** | `GROQ_API_KEY` | `llama-3.1-8b-instant` | `https://api.groq.com/openai/v1/chat/completions` |
| **Google AI Studio** | `GOOGLE_AI_API_KEY` | `gemini-3.6-flash` | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` |
| **Legacy OpenAI-compatible** | `LLM_API_KEY` | `gpt-4o-mini` | `https://api.openai.com/v1/chat/completions` |

Code location: `lib/llm-providers.js` — `buildProviders()` (lines 59–104)

**How the LLM is prompted:**

1. Search evidence is formatted into a prompt block (`formatSearchEvidence()`, lines 115–148)
2. The user's claim is appended
3. If custom propositions are provided, they are listed as sub-claim questions to evaluate
4. The LLM is instructed to return **JSON only** with a `propositions` array, each containing `letter`, `text`, `value` (true/false), and `explanation`
5. Temperature is set to `0.2` for low randomness (deterministic evaluation)

Code location: `lib/llm-providers.js` — `callProvider()` (lines 209–306)

**Heuristic Fallback:**

If no LLM providers are configured or all providers fail, the system uses a built-in **heuristic simulator** (`simulateLLMResponse()`, lines 156–199). This checks the claim text for:
- **Trusted outlet keywords**: reuters, bbc, who, doh, phivolcs, usgs, nasa, etc.
- **Misinformation indicators**: fake, hoax, false, unverified, rumor

Based on these signals, it assigns TRUE/FALSE values to propositions.

### Step 4: Conjunction Logic Evaluation

After propositions are returned (from LLM or heuristic), the backend applies **conjunction logic**:

```
p ∧ q ≡ TRUE  →  Claim is VERIFIED
p ∧ q ≡ FALSE → Claim is FLAGGED (Unverified / High Misinformation Risk)
```

**All** propositions must be `true` for the claim to be verified. If **any single** proposition is `false`, the conjunction evaluates to `false` and the claim is flagged.

Code location: `lib/llm-providers.js` line 304 (`parsed.propositions.every(p => p.value)`)

### Step 5: Store Results in Database

Each check is recorded in **Supabase** (PostgreSQL) for metrics tracking.

#### Tool: Supabase Client

- Uses `@supabase/supabase-js` npm package
- Configured via `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` environment variables
- Code location: `lib/database.js`

**Database Schema:**

- **`checks` table**: Stores each fact-check with claim text, propositions (JSON), conjunction result (1/0), search evidence (JSON), and timestamp
- **`providers` table**: Tracks LLM provider usage stats (calls, successes, failures, rate limits, last error)

### Step 6: Display Results & Metrics

The frontend displays:
- **Truth chips**: Each proposition with TRUE/FALSE badge
- **Conjunction result**: Verified or Unverified status
- **Truth table**: All possible combinations of proposition values
- **Source list**: Supporting search results (links)
- **Assessment details**: Per-proposition explanations

The **Visual Metrics** panel shows real-time stats from the database:
- Total claims checked, verified, flagged, verification rate
- Weekly trend chart (Chart.js drawn on `<canvas>`)
- Trusted source usage bar chart

---

## Summary of All Tools Used

| Tool / Service | Purpose | Type | Required? |
|---------------|---------|------|-----------|
| **DuckDuckGo HTML Scraper** | Web search for evidence | Search API | Yes (default, no key needed) |
| **Tavily API** | Web search for evidence | Search API | No (optional, requires API key) |
| **Serper / Other** | Web search for evidence | Search API | No (optional, pluggable) |
| **OpenRouter** | LLM proposition evaluation | LLM Provider | No |
| **Groq** | LLM proposition evaluation | LLM Provider | No |
| **Google AI Studio** | LLM proposition evaluation | LLM Provider | No |
| **OpenAI-compatible API** | LLM proposition evaluation | LLM Provider | No |
| **Heuristic Simulator** | Offline fallback evaluation | Built-in Logic | Yes (when no LLM configured) |
| **Supabase (PostgreSQL)** | Database storage & metrics | Database | No (but recommended) |
| **Node.js + Express** | Backend server & API | Runtime/Server | Yes |
| **HTML/CSS/JS** | Frontend UI | Frontend | Yes |
| **node-fetch** | HTTP client for API calls | Library | Yes |
| **@supabase/supabase-js** | Database client | Library | No (if Supabase not used) |

---

## Environment Variables

All configuration is via environment variables (see `.env.example`):

```
# LLM Providers
OPENROUTER_API_KEY=...
GROQ_API_KEY=...
GOOGLE_AI_API_KEY=...
LLM_API_KEY=...
LLM_PROVIDER_STRATEGY=priority   # or "round-robin"

# Search
SEARCH_API_KEY=...
SEARCH_API_URL=https://api.tavily.com/search
SEARCH_MAX_RESULTS=5

# Database
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...

# Server
PORT=3000
```

---

## File Reference

| File | Role |
|------|------|
| `server.js` | Express entry point, routes |
| `lib/check-claim-handler.js` | Main fact-check pipeline (search + LLM + DB insert) |
| `lib/llm-providers.js` | LLM provider management, prompting, source filtering, heuristic fallback |
| `lib/database.js` | Supabase DB operations (insert checks, metrics queries) |
| `lib/http.js` | HTTP helpers (JSON body parsing, responses) |
| `index.html` | Frontend: claim input, results, truth table, metrics, quiz |
| `assets/style.css` | Complete stylesheet |
| `.env.example` | Configuration template |
| `plan.md` | System architecture overview |
| `supabase-setup.sql` | Database schema definition |
