#!/usr/bin/env node

/**
 * Quant Signal Engine — CLI wrapper for Financial Radar integration.
 *
 * Reads OHLCV JSON from stdin, runs deterministic signal evaluation + backtest,
 * outputs JSON result to stdout.
 *
 * Input format:
 * {
 *   "symbol": "BBRI.JK",
 *   "candles": [{ "time": 1700000000, "open": 100, "high": 101, "low": 99, "close": 100.5, "volume": 1000000 }, ...]
 * }
 *
 * Output: SignalEvaluation + BacktestResult JSON
 *
 * Usage:
 *   echo '{"symbol":"BBRI.JK","candles":[...]}' | node scripts/quant_signal.mjs
 *   node scripts/quant_signal.mjs < input.json
 */

import { readFileSync } from 'node:fs';
import { mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Build quant.ts and analysis.ts into temp ESM bundles
const tmp = path.join(os.tmpdir(), `quant-signal-${process.pid}`);
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
if (!input.symbol || !Array.isArray(input.candles) || input.candles.length < 20) {
  console.error(JSON.stringify({
    error: 'Invalid input: requires { symbol: string, candles: Candle[20+] }',
    received: { symbol: input.symbol, candleCount: input.candles?.length },
  }));
  process.exit(1);
}

const { symbol, candles } = input;

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

  // Output
  const result = {
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
  };

  console.log(JSON.stringify(result, null, 0));
} catch (e) {
  console.error(JSON.stringify({ error: `Signal evaluation failed: ${e.message}` }));
  process.exit(1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
