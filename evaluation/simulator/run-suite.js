#!/usr/bin/env node
'use strict';

/**
 * Generic replay runner for pipeline evaluation.
 * It injects operations into hooks and captures verification/handling outputs.
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const val = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    args[key] = val;
  }
  return args;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function clearModule(moduleAbsPath) {
  try {
    delete require.cache[require.resolve(moduleAbsPath)];
  } catch (_) {}
}

function buildPaths(repoRoot, scenario) {
  const byTestbed = {
    T1: {
      rules: path.join(repoRoot, 'evaluation', 'testbed_T1_rules.json'),
      devices: path.join(repoRoot, 'evaluation', 'testbed_T1_devices.json'),
      candidates: path.join(repoRoot, 'evaluation', 'candidates_T1.json'),
    },
    T2: {
      rules: path.join(repoRoot, 'evaluation', 'testbed_T2_rules.json'),
      devices: path.join(repoRoot, 'evaluation', 'testbed_T2_devices.json'),
      candidates: path.join(repoRoot, 'evaluation', 'candidates_T2.json'),
    },
  };

  const base = byTestbed[String(scenario.testbed || 'T1')] || byTestbed.T1;
  return {
    rules: scenario.rules_path ? path.resolve(repoRoot, scenario.rules_path) : base.rules,
    devices: scenario.devices_path ? path.resolve(repoRoot, scenario.devices_path) : base.devices,
    candidates: scenario.candidates_path ? path.resolve(repoRoot, scenario.candidates_path) : base.candidates,
  };
}

function normalizeOperations(scenario) {
  const ops = Array.isArray(scenario.operations) ? scenario.operations.slice() : [];
  const out = [];
  let cursor = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] || {};
    const atMs = Number.isFinite(Number(op.at_ms))
      ? Number(op.at_ms)
      : (cursor += Number(op.delay_ms || 0));
    out.push({
      ...op,
      id: op.id || `${scenario.id || 'scenario'}_${i + 1}`,
      at_ms: atMs,
      idx: i,
    });
  }
  return out;
}

function buildPayload(op) {
  if (op.payload && typeof op.payload === 'object') {
    return op.payload;
  }
  const deviceUid = op.device_uid || (op.device && op.device.uid);
  const label = op.device_label || (op.device && op.device.label) || deviceUid || 'unknown';
  return {
    platform: op.platform || 'simulator',
    device: { uid: deviceUid, label },
    attribute: op.attribute,
    value: op.value,
    raw: op.raw || { scenario_op: op.id || null },
  };
}

function summarizeObservation(log) {
  const verified = [];
  const patterns = new Set();
  const decisions = [];
  for (const x of log) {
    const obs = x && x.observation;
    if (!obs || !Array.isArray(obs.verified)) continue;
    for (const v of obs.verified) {
      verified.push(v);
      if (v && v.pattern) patterns.add(v.pattern);
    }
    if (Array.isArray(x && x.decisions)) {
      for (const d of x.decisions) decisions.push(d);
    }
  }
  return { verified, patterns: Array.from(patterns).sort(), decisions };
}

async function runScenario(repoRoot, scenario) {
  const paths = buildPaths(repoRoot, scenario);

  const screenPath = path.join(repoRoot, 'screen.js');
  clearModule(screenPath);
  const screen = require(screenPath);
  screen.runTestbed(
    String(scenario.testbed || 'SIM'),
    paths.rules,
    paths.devices,
    paths.candidates
  );

  const policyPath = path.join('/tmp', `mpm_sim_policies_${scenario.id || 'default'}.json`);
  try { fs.unlinkSync(policyPath); } catch (_) {}

  process.env.RULES_PATH = paths.rules;
  process.env.CANDIDATES_PATH = paths.candidates;
  process.env.POLICIES_PATH = policyPath;
  process.env.HANDLING_AUTO_POLICY = '1';
  process.env.HANDLING_AUTO_OPTION_MAP = JSON.stringify(scenario.auto_option_map || {});
  process.env.VERIFICATION_DEBUG = process.env.VERIFICATION_DEBUG || '0';
  process.env.VERIFICATION_EVENT_BROADCAST_ALL = String(
    scenario.verification_event_broadcast_all !== undefined
      ? (scenario.verification_event_broadcast_all ? 1 : 0)
      : 1
  );

  const verificationPath = path.join(repoRoot, 'verification.js');
  const handlingPath = path.join(repoRoot, 'handling.js');
  const hooksPath = path.join(repoRoot, 'hooks.js');
  clearModule(verificationPath);
  clearModule(handlingPath);
  clearModule(hooksPath);

  const hooks = require(hooksPath);
  const handling = require(handlingPath);
  hooks.setStreamHandler(handling.stream_handler);

  const observationLog = [];
  handling.setObservationListener((entry) => {
    observationLog.push(entry);
  });

  const ops = normalizeOperations(scenario);
  const byTick = new Map();
  for (const op of ops) {
    const k = Number(op.at_ms);
    const arr = byTick.get(k) || [];
    arr.push(op);
    byTick.set(k, arr);
  }
  const ticks = Array.from(byTick.keys()).sort((a, b) => a - b);

  const realNow = Date.now;
  const startNow = Number(scenario.start_epoch_ms || realNow());
  let virtualNow = startNow;
  Date.now = () => virtualNow;

  const opResults = [];
  try {
    for (const tick of ticks) {
      virtualNow = startNow + tick;
      let bucket = (byTick.get(tick) || []).slice();
      if (scenario.shuffle_within_tick) {
        shuffleInPlace(bucket);
      } else {
        bucket.sort((a, b) => {
          const oa = Number.isFinite(Number(a.order)) ? Number(a.order) : a.idx;
          const ob = Number.isFinite(Number(b.order)) ? Number(b.order) : b.idx;
          return oa - ob;
        });
      }

      const dispatchOne = async (op) => {
        const payload = buildPayload(op);
        let res = { allowed: true };
        if (op.kind === 'event') {
          res = await hooks.handleDeviceEvent(payload, async () => {});
        } else if (op.kind === 'command') {
          res = await hooks.handlePlatformCommand(payload, async () => {});
        } else {
          throw new Error(`unknown op kind: ${op.kind}`);
        }
        opResults.push({
          id: op.id,
          kind: op.kind,
          at_ms: op.at_ms,
          allowed: !!(res && res.allowed),
          forwarded: !!(res && res.forwarded),
          decision_count: Array.isArray(res && res.decisions) ? res.decisions.length : 0,
          verified_count: Array.isArray(res && res.observation && res.observation.verified)
            ? res.observation.verified.length
            : 0,
          verified_patterns: Array.isArray(res && res.observation && res.observation.verified)
            ? Array.from(new Set(res.observation.verified.map(v => v && v.pattern).filter(Boolean))).sort()
            : [],
          decision_summary: Array.isArray(res && res.decisions)
            ? res.decisions.map(d => ({
              instance_id: d.instance_id,
              candidate_id: d.candidate_id,
              pattern: d.pattern,
              option_id: d.option_id,
              allowed: d.allowed,
              reason: d.reason,
            }))
            : [],
          payload,
        });
      };

      if (scenario.concurrent_within_tick) {
        await Promise.all(bucket.map(dispatchOne));
      } else {
        for (const op of bucket) {
          await dispatchOne(op);
        }
      }
    }
  } finally {
    Date.now = realNow;
  }

  const summary = summarizeObservation(observationLog);
  const expected = Array.isArray(scenario.expected_patterns) ? scenario.expected_patterns.slice() : [];
  const missing = expected.filter((p) => !summary.patterns.includes(p));
  const blockedOps = opResults.filter((x) => !x.allowed).length;

  return {
    id: scenario.id,
    testbed: scenario.testbed,
    rules_path: paths.rules,
    devices_path: paths.devices,
    candidates_path: paths.candidates,
    op_count: opResults.length,
    blocked_ops: blockedOps,
    allowed_ops: opResults.length - blockedOps,
    expected_patterns: expected,
    verified_patterns: summary.patterns,
    missing_expected_patterns: missing,
    verified_instance_count: summary.verified.length,
    blocked_by_policy_count: summary.decisions.filter(d => d && d.allowed === false).length,
    verified_instances: summary.verified.map((v) => ({
      instance_id: v.instance_id,
      pattern: v.pattern,
      candidate_id: v.candidate_id,
      dir: v.dir || null,
      rules: v.rules || [],
      manual_control: v.manual_control || null,
    })),
    policy_decisions: summary.decisions.map((d) => ({
      instance_id: d.instance_id,
      candidate_id: d.candidate_id,
      pattern: d.pattern,
      option_id: d.option_id,
      policy_id: d.policy_id,
      allowed: d.allowed,
      reason: d.reason,
    })),
    operations: opResults.map(x => ({
      id: x.id,
      kind: x.kind,
      at_ms: x.at_ms,
      allowed: x.allowed,
      forwarded: x.forwarded,
      verified_count: x.verified_count,
      verified_patterns: x.verified_patterns,
      decision_count: x.decision_count,
      decisions: x.decision_summary,
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.suite) {
    throw new Error('missing --suite <path-to-suite-json>');
  }
  const suiteArg = args.suite;
  const suitePath = path.resolve(process.cwd(), String(suiteArg));
  const suite = loadJson(suitePath);
  const repoRoot = process.cwd();

  let scenarios = Array.isArray(suite.scenarios) ? suite.scenarios.slice() : [];
  if (args.scenario) {
    scenarios = scenarios.filter(s => String(s.id) === String(args.scenario));
  }

  if (scenarios.length === 0) {
    throw new Error('no scenarios selected');
  }

  const results = [];
  for (const scenario of scenarios) {
    const merged = { ...(suite.defaults || {}), ...scenario };
    const out = await runScenario(repoRoot, merged);
    results.push(out);
    console.log(`[sim] ${out.id}: verified=${out.verified_patterns.join(',')} blocked=${out.blocked_ops} missing=${out.missing_expected_patterns.join(',')}`);
  }

  const aggregate = {
    suite: suite.name || path.basename(suitePath),
    scenario_count: results.length,
    total_operations: results.reduce((n, x) => n + x.op_count, 0),
    total_blocked_ops: results.reduce((n, x) => n + x.blocked_ops, 0),
    all_verified_patterns: Array.from(new Set(results.flatMap(x => x.verified_patterns))).sort(),
    scenarios_with_missing: results.filter(x => x.missing_expected_patterns.length > 0).map(x => x.id),
  };

  const outPath = args.out ? path.resolve(process.cwd(), String(args.out)) : null;
  const finalObj = { aggregate, results };
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(finalObj, null, 2), 'utf-8');
    console.log(`[sim] wrote summary -> ${outPath}`);
  } else {
    console.log(JSON.stringify(finalObj, null, 2));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[sim] failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  runScenario,
  normalizeOperations,
  buildPayload,
  buildPaths,
  parseArgs,
};
