# VerifiedPulse — Logical Fact-Checking System

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  VerifiedPulse  │────▶│   Backend   │────▶│   Search    │
│  Frontend   │◀────│  API Proxy  │◀────│   API       │
│ (index.html)│     │(server.js)  │     │  (Tavily)   │
└─────────────┘     └─────────────┘     └─────────────┘
        │                  │
        │                  ├──▶ Supabase (PostgreSQL)
        │                  │
        └──▶ Metrics & Stats dashboard
```

## User Workflow

1. User enters **text claim**
2. Backend searches for corroborating evidence via **Search API (Tavily)**
3. Backend sends claim + evidence to **LLM**
4. LLM evaluates the claim against two **fixed propositions** (P and Q) with TRUE/FALSE values and explanations:
   - **P**: The claim is backed by an official statement, announcement, or memorandum.
   - **Q**: The information is confirmed as accurate by a credible news outlet, fact-checking organization, or recognized expert institution.
5. Backend applies **conjunction logic** (ALL must be true = VERIFIED)
6. Result stored in database for metrics
7. Frontend displays: truth table, chips, assessment details
8. Visual Metrics panel shows real stats from database

## Fixed Propositions (P & Q)

VerifiedPulse evaluates every claim against two **fixed propositions**. These are
defined in the backend (`lib/llm-providers.js`, `FIXED_PROPOSITIONS` constant) and
are **no longer user-configurable** from the frontend.

| Letter | Proposition |
|--------|-------------|
| **P** | The claim is backed by an official statement, announcement, or memorandum. |
| **Q** | The information is confirmed as accurate by a credible news outlet, fact-checking organization, or recognized expert institution. |

A claim is **Verified** only when **both P and Q evaluate to True** (conjunction
logic: `p ∧ q ≡ T`). If either is False, the claim is flagged as
**Unverified / High Misinformation Risk**.

## Tech Stack

- **Frontend**: HTML/CSS/JS (static, served by Express)
- **Backend**: Node.js + Express
- **Database**: Supabase (PostgreSQL)
- **LLM**: Required — Configurable providers (OpenRouter, Groq, Google AI, OpenAI-compatible)
- **Search**: Tavily Search API (required, configured via `SEARCH_API_KEY`)

## Key Files

- `server.js` — Express backend, search integration, LLM integration, metrics API
- `package.json` — Dependencies (express, cors, dotenv, node-fetch, @supabase/supabase-js)
- `.env.example` — Configuration template (LLM API keys, search API key, Supabase credentials)
- `index.html` — Frontend with text-claim input, fixed propositions P & Q display, truth table, metrics, quiz
- `assets/style.css` — Complete stylesheet including preview box, loading states
- `lib/llm-providers.js` — LLM provider management, prompting, **fixed P and Q propositions**
- `lib/check-claim-handler.js` — Claim checking workflow, search, LLM orchestration
- `lib/database.js` — Supabase database operations
- `plan.md` — This file

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials
2. Run `npm install`
3. Run `npm start` (starts server on port 3000)
4. Open `http://localhost:3000`

## Search Integration

- **Required**: Tavily Search API (`SEARCH_API_KEY` and `SEARCH_API_URL`)
- Set `SEARCH_MAX_RESULTS` to control the number of results (default: 5)
- System will not function without a valid search API key

## LLM Integration

- **Required**: At least one LLM provider API key must be configured:
  - `OPENROUTER_API_KEY` (recommended)
  - `GROQ_API_KEY`
  - `GOOGLE_AI_API_KEY`
  - `LLM_API_KEY` (legacy OpenAI-compatible)
- **No heuristic fallback**: If no LLM provider is available or all providers fail, the system returns a "No working LLM" error
- The LLM is prompted to return JSON propositions with truth values
- Frontend applies conjunction logic: `p ∧ q ≡ T` only if all are true
- Provider strategy: `LLM_PROVIDER_STRATEGY` (priority | round-robin)

## Error Handling

- **No LLM providers configured**: Returns error "No working LLM"
- **All LLM providers failed**: Returns error "No working LLM"
- **Rate limited**: Automatic rotation to next provider; if all exhausted, returns "No working LLM"
- **Search API missing**: Returns error requiring valid search API key

## Database Schema

```sql
CREATE TABLE checks (
    id BIGSERIAL PRIMARY KEY,
    claim TEXT NOT NULL,
    mode TEXT NOT NULL,           -- 'text'
    propositions TEXT NOT NULL,   -- JSON array
    conjunction_result INTEGER,   -- 1 = verified, 0 = flagged
    search_evidence TEXT,         -- JSON of search results
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

```sql
CREATE TABLE providers (
    name TEXT PRIMARY KEY,
    model TEXT,
    calls INTEGER DEFAULT 0,
    successes INTEGER DEFAULT 0,
    failures INTEGER DEFAULT 0,
    last_error TEXT,
    last_used TIMESTAMPTZ,
    rate_limit_count INTEGER DEFAULT 0,
    suspended_until TIMESTAMPTZ
);
```