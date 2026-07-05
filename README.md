\# FlowSync



\*\*Multi-entity financial intelligence for businesses running across multiple Xero organisations and countries.\*\*



Built at \*Rise of the Builder: The Xero App \& Agent Hackathon\* (Encode Club × Xero, London, 4–5 July 2026).



Submission target: \*\*Bounty 01 — The Small Business Productivity Powerhouse\*\*.



\---



\## The problem



A business owner running branches in different countries has to check each Xero organisation separately, convert currencies in their head, guess at tax obligations in jurisdictions they don't know well, and manually build any report that spans more than one entity. FlowSync automates that entire chain of manual work on top of real, live Xero data.



\## What it does



\- \*\*Consolidated Dashboard\*\* — aggregates revenue, expenses, net profit, and cash position across every connected Xero organisation, with a per-entity breakdown, most-profitable/leanest-branch highlights, and an automatic banner flagging any branch currently running at a loss.

\- \*\*Live currency conversion\*\* across 160+ currencies, so a business reporting in GBP, INR, AED, and EUR gets one true consolidated view instead of manually-converted guesswork.

\- \*\*Tax page\*\* — estimates corporate tax owed per branch and per country using real, jurisdiction-specific rate bands (UK, UAE, Germany, India), showing exactly which band was applied. VAT/GST registration-threshold tracking checks the organisation's actual Xero registration status first, then falls back to a revenue-based estimate.

\- \*\*AI Legislation Assistant\*\* — a chat agent (Google ADK + Gemini) that answers tax/legislation questions using live web search across official government tax authorities, grounded in the user's own real connected financial data.

\- \*\*Currency Trends page\*\* — tracks exchange-rate history for any branch reporting in a foreign currency and flags whether it's currently a favorable moment to transfer funds to a branch that needs them.

\- \*\*Self-serve Reports page\*\* — pick which businesses and data sections to include, generate and download a PDF on demand.

\- \*\*Automated reporting agent\*\* — generates and emails full financial reports (per-branch PDFs plus one consolidated PDF) on a schedule, with strict guardrails: it can never fabricate a number, never sees or can redirect the recipient address, and treats all financial data as content rather than instructions (defending against prompt injection via account names/transaction descriptions).

\- \*\*Loss \& FX alert agents\*\* — one detects when a branch newly becomes loss-making and emails the owner immediately; the other monitors exchange-rate movement for branches that need funding and emails when the timing turns favorable to send money.



\## Architecture



```

┌─────────────┐     OAuth2 / REST     ┌──────────────┐

│    Xero     │◄─────────────────────►│   Supabase   │

│ (multi-org) │                       │ Postgres/Auth│

└─────────────┘                       │ Edge Functions│

&#x20;                                      └──────┬───────┘

&#x20;                                             │

&#x20;                   ┌─────────────────────────┼─────────────────────┐

&#x20;                   │                         │                     │

&#x20;            ┌──────▼──────┐          ┌───────▼───────┐     ┌───────▼───────┐

&#x20;            │  Frontend   │          │  Google ADK    │     │  Scheduled    │

&#x20;            │ TanStack    │◄────────►│  Agents        │     │  scripts      │

&#x20;            │ Start/React │          │ (root/reporter/│     │ (loss + FX    │

&#x20;            │             │          │  legislation)  │     │  check, cron) │

&#x20;            └─────────────┘          └────────┬───────┘     └───────┬───────┘

&#x20;                                               │                     │

&#x20;                                       ┌───────▼───────┐     ┌───────▼───────┐

&#x20;                                       │   PDF.co       │     │   Gmail API   │

&#x20;                                       │ (HTML → PDF)   │     │  (delivery)   │

&#x20;                                       └────────────────┘     └───────────────┘

```



\### Backend agents (`agents/`)



| Agent | Role |

|---|---|

| `root\_agent` | Routes requests to the right sub-agent, or answers directly (e.g. user lookups). |

| `reporter\_agent` | Generates and delivers one email per customer bundling a PDF report per connected Xero org plus a consolidated PDF. Tokens, refresh tokens, and recipient emails never pass through the LLM — the model only ever sees financial data (to write about) and status dicts (to know what happened). |

| `legislation\_agent` | Answers tax/compliance questions for the current user's own data only, grounded with live Google Search across UK/UAE/Germany/India tax-authority sources. Always appends a "not professional advice" disclaimer. |



Both agents are built with explicit guardrails: never fabricate a figure, never treat tool-returned data as instructions (prompt-injection defense against malicious account/transaction names), circuit-breaker after repeated failures, and strict scoping (the reporter agent processes a batch of customers by `user\_id`; the legislation agent only ever sees the current authenticated session's own data).



Standalone scripts (`agents/scripts/`) run outside the agent/LLM loop on a cron schedule for the deterministic loss/FX checks, since threshold comparisons don't need an LLM's reasoning — just speed and reliability.



\### Frontend (`frontend/`)



TanStack Start (React 19) + TanStack Router/Query, styled with Tailwind CSS + shadcn/ui (Radix primitives). Initially scaffolded with \[Lovable](https://lovable.dev) and extended directly. Key routes: `dashboard`, `tax`, `reports`, `fx-trends`, `legislation`, and the Xero OAuth `auth`/`auth/connect`/`auth/callback` flow.



\### Data layer



Supabase (Postgres + Auth + Edge Functions in Deno/TypeScript). Edge functions: `xero-oauth-callback`, `xero-data`, `fx-history`, `generate-report`.



\## Xero API usage



\*\*OAuth / identity\*\*

\- `POST /connect/token` — authorization\_code exchange and refresh\_token grant

\- `GET /connect/userinfo` — identity claims for login

\- `GET /connections` — list authorized tenants for a token



\*\*Accounting API\*\* (`api.xero.com/api.xro/2.0`)

\- `GET /Organisation` — base currency, country, tax registration status

\- `GET /Users` — resolve the organisation's admin/subscriber email for report delivery

\- `GET /Reports/ProfitAndLoss`, `/BalanceSheet`, `/BankSummary`

\- `GET /Invoices` (filtered `where=Type=="ACCREC"`) — consolidated revenue

\- `GET /Contacts`, `POST /Contacts` — demo data seeding

\- `GET /Accounts`

\- `POST /BankTransactions` — demo data seeding (Spend/Receive Money)



\*\*OAuth scopes required\*\*



Login (identity only): `openid profile email offline\_access`



Connect (organisation-level access): `openid profile email offline\_access accounting.invoices.read accounting.contacts.read accounting.settings.read accounting.reports.profitandloss.read accounting.reports.balancesheet.read accounting.reports.banksummary.read accounting.banktransactions accounting.contacts`



\## Tech stack



\- \*\*Frontend:\*\* TanStack Start, React 19, Tailwind CSS, shadcn/ui, Lovable

\- \*\*Backend/data:\*\* Supabase (Postgres, Auth, Edge Functions)

\- \*\*Agents:\*\* Python, Google Agent Development Kit (ADK), Gemini with live Google Search grounding

\- \*\*Automation:\*\* Make.com (early pipeline prototyping)

\- \*\*Other integrations:\*\* PDF.co (PDF generation), Gmail API (email delivery), open.er-api.com (FX rates)



\## Getting started



\### Prerequisites

\- Node.js + a package manager (this repo uses `bun`)

\- Python 3.11+

\- A Supabase project

\- A Xero app (developer.xero.com) with the scopes listed above

\- A Google API key with Gemini access



\### Frontend



```bash

cd frontend

bun install

bun run dev

```



\### Agents



```bash

cd agents

python -m venv .venv

source .venv/bin/activate   # or .venv\\Scripts\\activate on Windows

pip install -r requirements.txt

```



Create `agents/root\_agent/.env` with:



```

SUPABASE\_URL=...

SUPABASE\_SERVICE\_ROLE\_KEY=...

XERO\_CLIENT\_ID=...

XERO\_CLIENT\_SECRET=...

GOOGLE\_API\_KEY=...

```



Then run the agent locally via the ADK CLI/dev UI from `agents/root\_agent/`.



\*\*One-time setup:\*\*

```bash

\# Authorize Gmail delivery for the reporter agent (interactive, run once with a browser available)

python agents/scripts/authorize\_gmail.py



\# Optionally seed a connected demo/sandbox org with sample transactions

python agents/scripts/seed\_demo\_data.py <user\_id> <tenant\_id>

```



\*\*Scheduled loss/FX check\*\* (cron): `agents/scripts/run\_loss\_check.sh`



\### Supabase



Table `public.xero\_connections` stores `user\_id`, `xero\_user\_id`, `access\_token`, `refresh\_token`, `expires\_at`, `scope`, `updated\_at`. Tenant ID and recipient email are resolved dynamically at runtime from Xero's own APIs rather than stored, so they're always current. Edge functions live in `frontend/supabase/functions/`.



\## Security design notes



\- Access tokens, refresh tokens, and recipient email addresses never flow through the LLM in either agent — only financial report data (to write about) and short status dicts (to reason about failures).

\- All tool-returned financial data is treated as literal content, never as instructions, defending against prompt injection via account names or transaction descriptions.

\- The reporter agent's final summary is restricted to counts and short failure categories only — it can be safely shown to people who shouldn't see individual customers' financial data.



\## Team



Five-person team, built during the two-day hackathon window and tested throughout against real, live Xero data across organisations in the UK, UAE, Germany, and India.



\## License



Hackathon submission — license TBD.

