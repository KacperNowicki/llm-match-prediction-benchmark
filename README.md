# LLM Match Prediction Benchmark

A local-first benchmark app for tracking League of Legends match predictions from multiple LLMs.

The app replaces a workbook workflow with a tournament-first loop:

```text
Add/select tournament
-> paste or import schedule
-> generate prompts
-> paste model predictions
-> review parser output
-> enter results
-> score models and Consensus
-> draft tweets
-> export TSV
```

## Why It Exists

The useful question is not just "which model sounds convincing?" It is whether the same models can predict real match winners and exact series scores over time, across leagues, without hand-maintained spreadsheet glue.

## Local Data

Runtime data stays local:

```text
data/predictions.sqlite
data/predictions.safety.sqlite
```

Those files are ignored by git. Spreadsheet imports are ignored too, so the public repository can show the tool and aggregate benchmark story without publishing the working database or workbook.

## Public Page

The GitHub Pages site lives in `docs/`. It is a static snapshot with aggregate stats, per-tournament scorecards, methodology, and workflow diagrams; it does not read the local SQLite database.

## Data Provenance

Benchmark data has one source of truth: the maintainer's local SQLite database. Public contributions may improve app code or docs, but scored matches, predictions, and leaderboard numbers are not accepted from external commits because they cannot be validated against the private workflow history.

## Development

```bash
npm install
npm run dev
npm run verify
```

The app uses Vite, React, TypeScript, a local Node API, and SQLite through Node's built-in `node:sqlite`.
