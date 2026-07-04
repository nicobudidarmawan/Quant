#!/usr/bin/env node

/**
 * Quant Signal Engine — Batch CLI wrapper for Financial Radar integration.
 *
 * Reads multiple ticker OHLCV JSON from stdin, runs deterministic signal
 * evaluation + backtest for each, outputs JSON results to stdout.
 *
 * Input format:
 * {
 *   "tickers": [
 *     { "symbol": "BBRI.JK", "candles": [{ "time": ..., "open": ..., ... }, ...] },
 *     ...
 *   ]
 * }
 *
 * Output format:
 * { "results": [ { symbol, decision, setup, ... }, ... ] }
 *
 * Usage:
 *   echo '{"tickers":[...]}' | node scripts/quant_signal_batch.mjs
 *   node scripts/quant_signal_batch.mjs < input.json
 */

import { readFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Build quant.ts and analysis.ts into temp ESM bundles
const tmp = path.join(os.tmpdir(), `quant-signal-batch-${process.pid}`);
mkdirSync(tmp, { recursive: true });

// Build signal engine
const quantOutfile = path.join(tmp, 'quant.mjs');
await build({
  entryPoints: [path.join(root, 'src/shared/quant.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: quantOutfile,
  logLevel: 'silent',
});

// Build analysis (pivot detection)
const analysisOutfile = path.join(tmp, 'analysis.mjs');
await build({
  entryPoints: [path.join(root, 'src/renderer/components/chart/analysis.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: analysisOutfile,
  logLevel: 'silent',
});

const quant = await import(pathToFileURL(quantOutfile).href);
const analysis = await import(pathToFileURL(analysisOutfile).href);

// Read stdin
let inputData = '';
try {
  inputData = readFileSync('/dev/stdin', 'utf-8');
} catch {
  console.error(JSON.stringify({ error: 'Failed to read stdin' }));
  process.exit(1);
}

let input;
try {
  input = JSON.parse(inputData);
} catch (e) {
  console.error(JSON.stringify({ error: `Invalid JSON: ${e.message}` }));
  process.exit(1);
}

// Validate input
if (!Array.isArray(input.tickers)) {
  console.error(JSON.stringify({ error: 'Invalid input: requires { tickers: [...] }' }));
  process.exit(1);
}

const results = [];

try {
  for (const ticker of input.tickers) {
    const { symbol, candles } = ticker;

    if (!symbol || !Array.isArray(candles) || candles.length < 20) {
      results.push({
        symbol,
        decision: 'no-trade',
        setup: 'no-clear-setup',
        regime: 'insufficient-data',
        confidence: 0,
        reason: `Insufficient candles: need 20+, got ${candles?.length ?? 0}`,
        risk: {},
        components: [],
        analytics: {},
        backtest: null,
        pivotsDetected: 0,
        candleCount: candles?.length ?? 0,
        strategyVersion: 'QuantDeskSignal_v1',
      });
      continue;
    }

    try {
      // Detect pivots from candles
      const pivots = analysis.findPivots(candles);

      // Run signal evaluation
      const evaluation = quant.evaluateSignal(symbol, candles, pivots);

      // Run backtest (needs 55+ candles)
      let backtest = null;
      if (candles.length >= 55) {
        backtest = quant.runBacktest(candles);
      }

      results.push({
        symbol: evaluation.symbol,
        decision: evaluation.decision,
        setup: evaluation.setupType,
        regime: evaluation.regime,
        confidence: evaluation.confidence,
        reason: evaluation.reason,
        risk: evaluation.risk,
        components: evaluation.components,
        analytics: evaluation.analytics,
        backtest: backtest ? {
          totalTrades: backtest.totalTrades,
          wins: backtest.wins,
          losses: backtest.losses,
          winRate: backtest.winRate,
          expectancy: backtest.expectancy,
          profitFactor: backtest.profitFactor,
          maxDrawdown: backtest.maxDrawdown,
          maxConsecutiveWins: backtest.maxConsecutiveWins,
          maxConsecutiveLosses: backtest.maxConsecutiveLosses,
        } : null,
        pivotsDetected: pivots.length,
        candleCount: candles.length,
        strategyVersion: evaluation.strategyVersion,
      });
    } catch (e) {
      results.push({
        symbol,
        decision: 'no-trade',
        setup: 'error',
        regime: 'error',
        confidence: 0,
        reason: `Evaluation failed: ${e.message}`,
        risk: {},
        components: [],
        analytics: {},
        backtest: null,
        pivotsDetected: 0,
        candleCount: candles.length,
        strategyVersion: 'QuantDeskSignal_v1',
      });
    }
  }

  console.log(JSON.stringify({ results }, null, 0));
} catch (e) {
  console.error(JSON.stringify({ error: `Batch signal evaluation failed: ${e.message}` }));
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
