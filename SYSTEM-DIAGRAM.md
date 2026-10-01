# VerifiedPulse — End-to-End System Diagram

How a user-pasted claim becomes a logic verdict, gets stored, and drives the Visual Metrics dashboard.

---

## 1. Master Flow: Claim → Verdict → Storage → Metrics

```mermaid
flowchart TD
    subgraph UI["1. FRONTEND — index.html"]
        A["User types / pastes claim<br/>textarea#claimInput"]
        B["evaluateClaim()<br/>POST /api/check-claim<br/>{ mode:'text', claim }"]
        C["displayResults(data)"]
        C1["Truth chips: P = … , Q = …<br/>Conjunction = True/False"]
        C2["Per-Proposition Assessment<br/>+ Risk Assessment"]
        C3["Source links<br/>(results + organic)"]
        C4["drawTruthTable()<br/>marks current row ✓"]
    end

    subgraph SRV["2. SERVER — server.js (Express :3000)"]
        S0{"POST /api/check-claim"}
        S1["handleCheckClaim()<br/>lib/check-claim-handler.js"]
    end

    subgraph EV["3. EVIDENCE GATHERING"]
        E1["searchWeb(claim)<br/>SEARCH_API_KEY"]
        E2["Search Provider<br/>Tavily / SEARCH_API_URL<br/>depth:basic, max_results:5, include_answer"]
        E3["formatSearchEvidence()<br/>→ answer + numbered sources (500 chars each)"]
    end

    subgraph LLM["4. LOGIC ENGINE — lib/llm-providers.js"]
        L0["callLLM(claim, evidence, props)"]
        L1["Provider pool & rotation<br/>openrouter → groq → google → legacy-openai<br/>strategy: priority | round-robin"]
        L2{"Attempt provider<br/>10s AbortController timeout"}
        L3{"429 / quota?"}
        L4["Suspend 5 min<br/>+ warning toast<br/>→ next provider"]
        L5["JSON parse + validate<br/>exactly 2 propositions"]
    end

    subgraph PROP["5. PROPOSITIONS (fixed)"]
        P1["p = official statement,<br/>announcement, or memorandum"]
        P2["q = credible news outlet,<br/>fact-checker, or expert institution"]
        P3["Each gets 3 states:<br/>verified / unverified / refuted<br/>value = (state === 'verified')"]
        P4["Prompt guardrails:<br/>use ONLY the evidence,<br/>never training data;<br/>silence ≠ refutation"]
    end

    subgraph LOGIC["6. VERDICT — lib/risk.js"]
        V1["conjunction_result<br/>= conjunction_result &&<br/>every(p.value === true)"]
        V2["classifyPropositions(p, q)"]
        V3{"Corner lookup<br/>p \\| q"}
        V4["Bilinear interpolation<br/>WEIGHT: true 0 /<br/>unverified 0.5 / false 1"]
        V5["riskScore 0–100<br/>severity: ≥70 high,<br/>≥30 medium, else low"]
        V6["category + categoryLabel<br/>+ isMisinformationCandidate"]
    end

    subgraph STORE["7. PERSISTENCE — lib/database.js (Supabase)"]
        D1["insertCheck(record)<br/>always"]
        D2["insertMisinformationEvent()<br/>ONLY IF conjunction = false"]
        D3["upsertProviderStats()<br/>always<br/>calls / successes / failures"]
        D1 --> T1[("checks")]
        D2 --> T2[("misinformation_events")]
        D3 --> T3[("providers")]
    end

    subgraph RESP["8. RESPONSE"]
        R1["200 JSON: claim, propositions,<br/>conjunction_result, risk,<br/>search_evidence, provider, warnings"]
        R2{"Error path"}
        R3["502 Search unavailable<br/>503 No working LLM<br/>500 Other"]
    end

    subgraph MET["9. METRICS READ PATH"]
        M0["loadMetrics()<br/>GET /api/metrics<br/>runs on load + after every<br/>verification + on tab switch"]
        M1["getMetrics() — 4 Supabase queries"]
        M1 --> M2["Q1 total checks<br/>Q2 verified = conjunction_result=1<br/>flagged = total − verified"]
        M1 --> M3["Q3 all checks rows<br/>→ 7-day weekly buckets<br/>→ TRUSTED_CATEGORIES keyword scan<br/>   over search_evidence JSON"]
        M1 --> M4["Q4 misinformation_events<br/>→ totals, active,<br/>avgRiskScore, riskDistribution,<br/>categoryBreakdown"]
        M6["Metrics JSON"]
        M7["updateMetricsUI(data)"]
        M8["Stat tiles:<br/>Total · Verified · Flagged · Rate%<br/>Misinfo: Events · Active · AvgRisk"]
        M9["VerifiedPulseCharts.update(data)"]
        M10["4 Chart.js charts"]
    end

    subgraph CHARTS["10. VISUAL METRICS — assets/charts.js"]
        X1["chartTrend<br/>LINE/AREA · weekly claims vs verified"]
        X2["chartRisk<br/>DOUGHNUT · high/medium/low"]
        X3["chartSources<br/>H-BAR · trusted source citations"]
        X4["chartCategory<br/>H-BAR · flagged claims by risk category"]
        X5["emptyStatePlugin<br/>'No data available yet'"]
    end

    A --> B --> S0 --> S1
    S1 --> E1 --> E2 --> E3 --> L0 --> L1 --> L2
    L2 -->|ok| L5
    L2 -->|fail| L3
    L3 -->|yes| L4 --> L2
    L3 -->|no| L2
    L5 --> P1
    L5 --> P2
    P1 --> P3
    P2 --> P3
    P4 -. "informs states" .-> P3
    P3 --> V1
    P3 --> V2
    V2 --> V3 --> V4 --> V5 --> V6
    V1 --> D1
    V1 -->|false| D2
    V1 --> D3
    D1 & D2 & D3 -. "never blocks the response" .-> R1
    S1 -.->|any throw| R2
    R2 --> R3
    R1 --> C
    C --> C1 & C2 & C3 & C4

    D1 -. "reads" .-> M1
    D2 -. "reads" .-> M1
    M0 --> M1
    M2 & M3 & M4 & M5 --> M6 --> M7 --> M8
    M7 --> M9 --> M10
    M10 --> X1 & X2 & X3 & X4 & X5 & X6
    X7 -.-> X1

    C4 -. "user clicks 📊 Visual Metrics" .-> M0

    classDef ui fill:#e8f0fe,stroke:#0057b8,color:#0f1a41
    classDef ext fill:#fef3c7,stroke:#f59e0b,color:#0f1a41
    classDef logic fill:#ede9fe,stroke:#8b5cf6,color:#0f1a41
    classDef store fill:#dcfce7,stroke:#22c55e,color:#0f1a41
    classDef bad fill:#fee2e2,stroke:#ef4444,color:#0f1a41

    class A,B,C,C1,C2,C3,C4,M0,M6,M7,M8,M9,M10 ui
    class E2,L1 ext
    class P1,P2,P3,P4,V1,V2,V3,V4,V5,V6 logic
    class D1,D2,D3,T1,T2,T3,T4 store
    class R2,R3 bad
```

---

## 2. Logic Core: `p ∧ q` with three states

```mermaid
flowchart LR
    subgraph TRUTH["Truth table rendered in the UI"]
        T["p │ q │ p ∧ q<br/>T │ T │ T ← only Verified<br/>T │ F │ F<br/>F │ T │ F<br/>F │ F │ F"]
    end

    subgraph RISK["Risk scoring (lib/risk.js)"]
        R["CORNER_SCORE<br/>true|true → 0<br/>true|false → 40<br/>false|true → 55<br/>false|false → 90"]
        I["interpolate(wP, wQ)<br/>unverified = 0.5<br/>sits halfway between<br/>supported and refuted"]
        R --> I --> S["riskScore 0–100"]
    end

    subgraph CAT["Category → user-facing message"]
        C1["verified → '✅ Status: Verified'"]
        C2["uncorroborated-official"]
        C3["possible-misinterpretation<br/>'not necessarily misinformation'"]
        C4["likely-fabrication<br/>→ candidate = TRUE"]
        C5["insufficient-evidence"]
        C6["unsupported-claim<br/>→ candidate = TRUE"]
    end

    S --> CAT
    TRUTH -. "conjunction false" .-> RISK

    classDef good fill:#dcfce7,stroke:#22c55e,color:#0f1a41
    classDef warn fill:#fef3c7,stroke:#f59e0b,color:#0f1a41
    classDef bad fill:#fee2e2,stroke:#ef4444,color:#0f1a41
    class C1 good
    class C2,C3,C5 warn
    class C4,C6 bad
```

**Key point:** a failed conjunction is *not* automatically misinformation. The three-state model separates
"fabricated" (`likely-fabrication`, `unsupported-claim`) from "silent evidence" (`insufficient-evidence`) and
"distorted real reporting" (`possible-misinterpretation`).

---

## 3. Storage Schema → Metrics Consumers

```mermaid
erDiagram
    checks ||--o{ misinformation_events : "conjunction_result = 0"
    providers ||--o{ checks : "serves as provider for"

    checks {
        bigserial id PK
        text claim
        jsonb propositions "p,q states + explanations"
        int conjunction_result "1 verified / 0 flagged"
        jsonb search_evidence "full provider payload"
        timestamptz created_at "drives weekly trend"
    }
    misinformation_events {
        bigserial id PK
        text claim
        text claim_hash "sha256, dedupe key"
        int conjunction_result
        int misinformation_risk_score "0–100"
        text risk_category
        text p_state
        text q_state
        text platform "defaults 'unspecified'"
        int shares
        int impressions
        float engagement_rate
        float spread_velocity
        timestamptz detection_timestamp
    }
    platform_misinformation_stats {
        text platform PK
        int total_misinformation_events
        int total_shares
        int total_impressions
        float avg_misinformation_risk_score
        float avg_spread_velocity
    }
    providers {
        text name PK
        text model
        int calls
        int successes
        int failures
        text last_error
        timestamptz last_used
        int rate_limit_count
        timestamptz suspended_until
    }
    misinformation_spread {
        bigserial id PK
        int misinformation_event_id FK
        timestamptz timestamp
        int shares
        int impressions
    }
```

| Stored column | Read by | Rendered as |
|---|---|---|
| `checks` (all rows) | Q1 count | `statTotal` — Claims Checked |
| `checks.conjunction_result = 1` | Q2 | `statVerified`, Verified Rate % |
| `checks` total − verified | Q2 | `statFlagged` — Flagged Risky |
| `checks.created_at` | Q3 | `chartTrend` line/area (7 buckets) |
| `checks.search_evidence` JSON | Q3 | `chartSources` — keyword scan vs `TRUSTED_CATEGORIES` |
| `misinformation_events` (all rows) | Q4 | `statMisinfoTotal`, `statMisinfoActive` |
| `misinformation_risk_score` | Q4 | `statMisinfoAvgRisk`, `chartRisk` doughnut buckets (<30 / 30–70 / ≥70) |
| `risk_category` | Q4 | `chartCategory` horizontal bars |
| `providers.calls / successes / failures` | upsert only | provider rotation health, `GET /api/providers` |

---

## 4. Resilience & Failure Paths

```mermaid
flowchart TD
    S["POST /api/check-claim"] --> SW{"searchWeb ok?"}
    SW -->|no key / non-2xx| E502["502 Search service unavailable"]
    SW -->|ok| LM{"callLLM ok?"}
    LM -->|all providers exhausted| E503["503 No working LLM"]
    LM -->|ok| DB{"DB insert ok?"}
    DB -->|no| LOG["console.error only —<br/>logging never blocks or fails the verdict"]
    DB -->|yes| OK["200 + verdict"]
    LOG --> OK

    P429["429 / quota exceeded"] --> SUSP["suspendUntil = now + 5 min"]
    SUSP --> NEXT["try next provider + push warning"]
    NEXT --> TOAST["showToast(w,'warning')"]

    ERR["client-side"] --> T1["toastContainer for provider warnings"]
    ERR --> T2["alert('Error: ...') on fatal"]
    ERR --> T3["updateMetricsUI(zeros) when<br/>/api/metrics is down —<br/>dashboard degrades, not breaks"]

    classDef bad fill:#fee2e2,stroke:#ef4444,color:#0f1a41
    classDef ok fill:#dcfce7,stroke:#22c55e,color:#0f1a41
    classDef warn fill:#fef3c7,stroke:#f59e0b,color:#0f1a41
    class E502,E503 bad
    class OK ok
    class SUSP,NEXT,TOAST,T1,T2,T3 warn
```

---

## 5. File Map

| File | Role in the pipeline |
|---|---|
| `index.html` | Claim input, `evaluateClaim()`, `displayResults()`, truth table, stat tiles, quiz |
| `assets/charts.js` | Six Chart.js renderers + `emptyState` placeholder plugin, bound to `/api/metrics` |
| `server.js` | Express routes: `POST /api/check-claim`, `GET /api/providers`, `GET /api/metrics` |
| `lib/check-claim-handler.js` | Orchestrator: search → format → LLM → verdict → persist → respond |
| `lib/llm-providers.js` | Fixed propositions, evidence formatting, provider pool, rotation, 3-state prompt rules |
| `lib/risk.js` | Bilinear risk scoring, category + severity labels, misinformation-candidate test |
| `lib/database.js` | Supabase writes (`insertCheck`, `insertMisinformationEvent`, `upsertProviderStats`) and all metric aggregation |
| `api/metrics.js` | Thin HTTP wrapper around `getMetrics()` |
| `supabase-*.sql` | Table definitions for `checks`, `providers`, `misinformation_*`, `platform_misinformation_stats` |