# personal-spend

Turn bank CSV exports into a clear expense Sankey diagram with minimal friction.

## Tech stack

- `Node.js + npm workspaces` (single command entry points)
- CLI: `TypeScript + Papa Parse + Zod + js-yaml`
- Web: `React + Vite + Recharts (Sankey)`

## Quick start

```bash
npm install
npm run ingest -- --input ./Data_export_23022026.csv
npm run web
```

Then open the local Vite URL (usually `http://localhost:5173`).

## Repo layout

```text
.
├─ README.md
├─ .gitignore
├─ data/
│  ├─ raw/              # local CSV exports (gitignored)
│  ├─ processed/        # normalized + categorized outputs
│  └─ fixtures/         # scrubbed test fixtures
├─ rules/
│  ├─ categories.yml    # matching rules
│  └─ overrides.yml     # manual exceptions
├─ cli/
│  └─ src/ingest.ts     # ingest/process command
└─ web/
   ├─ src/App.tsx       # Sankey UI
   └─ public/*.json     # latest generated data for frontend
```

## Workflow

1. Export CSV from your bank.
2. Run ingestion command.
3. Review:
  - `data/processed/sankey.json`
  - `data/processed/transactions.json`
  - `data/processed/uncategorized.json`
4. Open web UI (`npm run web`) to visualize Sankey.
5. Update rules in `rules/categories.yml` or overrides in `rules/overrides.yml`, then rerun ingestion.

## CLI usage

```bash
npm run ingest -- --input ./Data_export_23022026.csv
```

Optional flags:

- `--out-dir <path>` default: `data/processed`
- `--rules <path>` default: `rules/categories.yml`
- `--overrides <path>` default: `rules/overrides.yml`
- `--no-publish-web` skips writing `web/public/*.json`

## Rules format

`rules/categories.yml`

```yaml
rules:
  Groceries:
    - coles
    - woolworths
  Dining:
    - uber *eats
```

`rules/overrides.yml`

```yaml
overrides:
  tx_1234abcd: Entertainment
narrative_contains:
  spotify: Subscriptions
```

## What this MVP handles

- Parses your current CSV shape (`Debit Amount`, `Credit Amount`, `Narrative`, etc.).
- Normalizes into one transaction schema with deterministic IDs.
- Categorizes via rules + overrides + fallback.
- Builds Sankey links (`Total Spend -> Category -> Merchant`).
- Shows uncategorized debit transactions for follow-up.

## Important caveats

1. Transfer/refund detection still needs stronger logic.
2. Categorization quality depends on your rule coverage.
3. Keep raw CSV files local and out of git.

## Next planned upgrades

1. Better transfer/reversal detection.
2. In-app recategorization UI.
3. CSV upload from web.
4. Budget and month-to-month comparisons.
