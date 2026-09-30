# How VerifiedPulse Actually Works

*A plain-language walkthrough. No code. No file names. Just what happens when you paste a claim.*

---

## The Short Version

You paste a claim. VerifiedPulse goes and finds real articles about it, reads them with an AI, asks two yes-or-no questions about what it found, and combines the two answers using basic logic. It writes down what it found so the dashboard can show trends later.

That's it. Everything below is just the detail.

---

## What Happens When You Hit "Verify Claim"

### Step 1 — You type a claim

You paste something into the box, like:

> "PHIVOLCS raised the alert level to 4 in Batangas"

The two questions VerifiedPulse asks about **every single claim** are already decided in advance. You never write them yourself, and the system never changes them:

| | Question |
|---|---|
| **P** | Is this claim backed by an official statement, announcement, or memo? |
| **Q** | Is this claim reported or confirmed by a credible news outlet, fact-checker, or recognised expert institution? |

Both must be **yes** for the claim to be called verified. That's the entire rule.

---

### Step 2 — It goes and searches the web

The claim is sent out as a search query. VerifiedPulse asks for the **top 5 results** and also requests a short synthesised summary of what those results say.

This step exists so the rest of the process has *something real to reason about*. If the search returns nothing useful, the claim cannot be verified — and that is a genuinely different outcome from being proven false.

---

### Step 3 — An AI reads the evidence — but not freely

This is the part that matters most, so it is worth being precise about it.

The AI is given the search results and a strict set of rules:

- **Use only the articles provided.** The AI is explicitly forbidden from answering from memory or general knowledge. This is the single most important rule in the whole system.
- **Every answer must cite a source.** It has to name a specific article or domain, not just assert a conclusion.
- **Silence is not the same as a denial.** If the articles simply don't talk about the claim, that is not proof the claim is false. The AI must say "nobody addressed this" instead.

The temperature is set very low so the same evidence produces the same answer. Creativity is turned off on purpose.

---

### Step 4 — Four AI providers, tried in order

VerifiedPulse does not depend on a single AI service. It has a list and works through it:

```
OpenRouter  →  Groq  →  Google AI Studio  →  any OpenAI-compatible service
```

If one is down, times out (10 seconds), or returns junk, the next one is tried automatically.

**If a provider hits its rate limit**, it is put on a 5-minute timeout and skipped for everyone else in that window. A small message appears on screen telling you it switched to another provider. You get an answer either way — that is the whole point of having a list.

---

### Step 5 — Each question gets one of three answers

This is the core idea, and it is easy to miss:

| Answer | Meaning |
|---|---|
| **Verified** | An article positively supports this |
| **Unverified** | The articles say nothing about it either way |
| **Refuted** | An article contradicts it |

Notice there are **three** answers, not two. "Nobody has written about this" and "someone proved this is false" are very different situations, and VerifiedPulse refuses to treat them as the same thing.

For display, `Unverified` and `Refuted` both count as "not a yes" — but the system remembers which one it was, and that memory changes everything downstream.

---

### Step 6 — The two answers combine

Basic logic, written out:

| P | Q | Verified? |
|:---:|:---:|:---|
| Yes | Yes | ✅ **Yes** |
| Yes | No | ❌ No |
| No | Yes | ❌ No |
| No | No | ❌ No |

One "no" is enough to fail. You can see this same table in the app, with a tick next to the row that matches your claim.

If it passes: **"✅ Status: Verified — safe to share."**
If it fails: the message tells you *which kind* of failure it was, which matters a great deal (next section).

---

### Step 7 — Why a failed check doesn't automatically mean "fake"

This is the part most fact-checkers get wrong, and the reason VerifiedPulse scores risk instead of just slapping a red label on anything.

When P and Q don't both pass, there are really four different situations, and only one of them is actual fabrication:

| Situation | What it means | Misinformation? |
|---|---|---|
| **Verified** | Official **and** independently reported | No |
| **Official but uncorroborated** | Government said it, nobody else reported it | No — could just be under-reported |
| **Possible misinterpretation** | The event is real, but the claim twists it | Not fabrication — a distortion |
| **Likely fabrication** | Nothing supports it *and* evidence contradicts it | **Yes** |
| **Insufficient evidence** | The articles were silent | **Not established** |
| **Unsupported claim** | No source at all exists | **Yes** |

The last two matter most. If a brand-new story broke ten minutes ago and no outlet has written it up yet, that is **insufficient evidence**, not misinformation. Conflating those two is how fact-checkers destroy their own credibility.

### The risk score

To make the dashboard sortable, each result gets a number from 0 to 100. The four fully-resolved corners are fixed:

| P | Q | Score |
|:---:|:---:|---:|
| Yes | Yes | 0 |
| Yes | No | 40 |
| No | Yes | 55 |
| No | No | 90 |

An **unverified** answer sits exactly halfway between the two — so "silent" lands halfway between "supported" and "contradicted" instead of being treated as a full refutation. That single design choice is what keeps the numbers honest.

Then: **70+** = high risk, **30–69** = medium, **below 30** = low.

---

### Step 8 — Everything is written down

Three separate things get saved, every single time:

**1. Every check, always.** The claim text, both answers with their written justifications, whether it passed, the full search results, and the timestamp. This is the master record — the dashboard is built entirely from this table.

**2. Flagged claims, only if it failed.** When a check fails, an extra record is written with the risk score, the category, and a fingerprint of the claim. **Verified claims are not written here.** This is why the misinformation numbers stay meaningful instead of just counting everything.

**3. Provider health, always.** Which AI service was used, how many times, how many succeeded, how many failed. This is what powers the automatic switching.

**Important:** if the database is unreachable, the check still completes and you still get your answer. It writes the failure to the console and moves on. A broken database never blocks a fact-check.

---

### Step 9 — What you see on screen

- **Status banner** — verified, refuted, unsupported, or insufficient evidence, plus the risk score if it failed
- **Chips** — the two answers and the combined result, colour-coded
- **Written reasoning** — a paragraph per question explaining *which article* led to *which answer*
- **Risk assessment** — the score, what it means, and whether it counts as a genuine misinformation candidate
- **Source links** — clickable, so you can check the AI's work yourself
- **Truth table** — with your specific result ticked

Always check the sources. The design assumes you want to verify the verifier.

---

## How the Numbers on the Dashboard Are Built

Every chart is computed from scratch from saved records. There is **no sample or demo data anywhere** — an empty chart says *"No data available yet"* rather than inventing a bar.

| What you see | Where it comes from |
|---|---|
| Claims Checked | Total records ever saved |
| Verified | Records where both answers were yes |
| Flagged Risky | Everything that wasn't verified |
| Verified Rate | Verified ÷ total, as a percentage |
| Misinformation Events | Failed checks recorded |
| Active / Resolved | Events not yet marked resolved, versus those that are |
| Avg Risk Score | Mean of all risk scores |
| Weekly Trend | Records grouped into the last 7 days |
| Risk Distribution | Events bucketed by score: under 30 / 30–70 / 70+ |
| Flagged by Category | Events grouped by the six categories above |
| Most Used Trusted Sources | Every saved search result scanned for known agencies (PHIVOLCS, USGS, WHO, Reuters, NASA…) and counted by type |
| Misinformation by Platform | Aggregated per platform |

**Trusted source counting deserves a note.** It doesn't rely on an AI judgement. It literally scans the saved article text for known names and counts hits by category — government agencies, international news, scientific bodies, fact-checkers. Simple, repeatable, and auditable.

The dashboard refreshes **automatically** every time you complete a check, so it is never stale.

---

## What Happens When Things Go Wrong

The design goal was that the user always gets *something* useful, and is told the truth about what happened.

| Situation | What you see |
|---|---|
| Web search unavailable | Clear error — search is required, so there's no honest way to continue |
| Every AI provider down | Clear error saying so, rather than a fake answer |
| Database unreachable | **Normal result delivered anyway** — storage failure is logged silently |
| One provider rate-limited | Toast notification, then it switches and completes |
| Dashboard can't load | Metrics show zero instead of the page breaking |

**One rule explains all of this:** the system would rather show you an honest error or an honest "unverified" than show you a confident answer it can't back up.

---

## The Idea in One Paragraph

The problem with AI fact-checkers is that they happily answer from memory — and an AI with no sources is just a confident guess with good branding. VerifiedPulse closes that gap by refusing to let the AI use anything except freshly searched articles, forcing both questions to be answered against those articles with citations attached, and grading the *quality of the evidence* rather than just the yes-or-no outcome. When it can't confirm something, it says so rather than guessing — which is what makes a "no" worth anything.

---

## Glossary

| Term | Plain meaning |
|---|---|
| **Claim** | The statement you want checked |
| **Proposition** | One of the two fixed yes-or-no questions (P and Q) |
| **Conjunction (p ∧ q)** | Both answers must be yes — an "AND" |
| **Evidence** | The search results the AI is allowed to use |
| **Verified** | An article positively supports the claim |
| **Unverified** | The articles are silent — not a denial |
| **Refuted** | An article contradicts the claim |
| **Risk score** | 0–100 measure of how concerning a failed claim is |
| **Category** *The label for why a check failed — fabrication, misinterpretation, or just no information |
| **Active vs Resolved** | Misinformation events still being tracked versus ones dealt with |
| **Provider** | An AI service the system can call on |
| **Rotation** | Automatically trying the next AI service when one fails |

---

*Companion documents: `SYSTEM-DIAGRAM.md` (technical diagrams) · `how-fact-checking-works.md` (developer reference)*