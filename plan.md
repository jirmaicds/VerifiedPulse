# VerifiedPulse — Logical Fact-Checking System

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  VerifiedPulse  │────▶│   Backend   │────▶│  DuckDuckGo │
│  Frontend   │◀────│  API Proxy  │◀────│  / Search   │
│ (index.html)│     │(server.js)  │     │  API        │
└─────────────┘     └─────────────┘     └─────────────┘
        │                  │
        │                  ├──▶ SQLite / Supabase DB (verifiedpulse.db)
        │                  │
        └──▶ Metrics & Stats dashboard
```

## User Workflow

1. User enters **text claim**
2. Backend searches for corroborating evidence via **DuckDuckGo** (or configured search API)
3. Backend sends claim + evidence to **LLM**
4. LLM returns structured **propositions** (p, q, r...) with TRUE/FALSE values
5. Backend applies **conjunction logic** (ALL must be true = VERIFIED)
6. Result stored in database for metrics
7. Frontend displays: truth table, chips, assessment details
8. Visual Metrics panel shows real stats from database

## Tech Stack

- **Frontend**: HTML/CSS/JS (static, served by Express)
- **Backend**: Node.js + Express
- **Database**: SQLite (`verifiedpulse.db`) or Supabase
- **LLM**: Configurable (OpenAI, Anthropic, etc.) with built-in heuristic fallback
- **Search**: DuckDuckGo HTML scraper (default) or configurable search API (Tavily, Serper, etc.)

## Key Files

- `server.js` — Express backend, search integration, LLM integration, metrics API
- `package.json` — Dependencies (express, cors, dotenv, node-fetch, @supabase/supabase-js)
- `.env.example` — Configuration template (LLM API key, search API key, Supabase credentials)
- `index.html` — Frontend with text-claim input, truth table, metrics, quiz
- `assets/style.css` — Complete stylesheet including preview box, loading states
- `plan.md` — This file

## Setup

1. Copy `.env.example` to `.env` and fill in your credentials
2. Run `npm install`
3. Run `npm start` (starts server on port 3000)
4. Open `http://localhost:3000`

## Search Integration

- **Default**: DuckDuckGo HTML scraper (no API key required)
- **Optional**: Set `SEARCH_API_KEY` and `SEARCH_API_URL` to use a search API (e.g., Tavily, Serper)
- Set `SEARCH_MAX_RESULTS` to control the number of results (default: 5)

## LLM Integration

- Set `LLM_API_KEY`, `LLM_API_URL`, and `LLM_MODEL` in `.env`
- Without an LLM API key, the system uses a built-in heuristic simulator
- The LLM is prompted to return JSON propositions with truth values
- Frontend applies conjunction logic: `p ∧ q ∧ r ≡ T` only if all are true

## Database Schema

```sql
CREATE TABLE checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim TEXT NOT NULL,
    mode TEXT NOT NULL,           -- 'text'
    propositions TEXT NOT NULL,   -- JSON array
    conjunction_result INTEGER,   -- 1 = verified, 0 = flagged
    search_evidence TEXT,         -- JSON of search results
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```
