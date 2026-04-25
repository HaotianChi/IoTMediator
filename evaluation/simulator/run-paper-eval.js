#!/usr/bin/env node
'use strict';

/**
 * Replay-only evaluation runner for core pipeline.
 *
 * Design:
 * - Uses fixed raw data logs under evaluation/data.
 * - Replays logs through hooks -> verification -> handling.
 * - Reports replay metrics per table and writes artifacts under evaluation/results.
 */

const fs = require('fs');
const path = require('path');
const { runScenario } = require('./run-suite');

const DEFAULT_MICRO_DATA_REL = path.join('evaluation', 'data', 'table7_microbench_raw.csv');
const DEFAULT_WEEK_DATA_REL = path.join('evaluation', 'data', 'table8_one_week_raw.csv');
const DEFAULT_WEEK_GROUPS_REL = path.join('evaluation', 'data', 'table8_one_week_groups.json');
const DEFAULT_WEEK_GROUND_TRUTH_REL = path.join('evaluation', 'data', 'table8_one_week_ground_truth.json');
const DEFAULT_HANDLING_DATA_REL = path.join('evaluation', 'data', 'table9_handling_raw.csv');
const DEFAULT_RESULTS_DIR = path.join(process.cwd(), 'evaluation', 'results');

function readCsvRows(p) {
  if (!fs.existsSync(p)) throw new Error(`missing csv file: ${p}`);
  const text = fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter((r) => r.some((x) => x !== '')).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = r[i] || '';
    return obj;
  });
}

function parseMaybeNumber(v) {
  if (v === undefined || v === null || v === '') return v;
  const n = Number(v);
  return Number.isFinite(n) && String(n) === String(v).trim() ? n : v;
}

function parseBool(v) {
  return String(v).toLowerCase() === 'true' || String(v) === '1';
}

function parseCandidateIds(s) {
  return String(s || '').split(';').map((x) => x.trim()).filter(Boolean);
}

function readJson(p) {
  if (!fs.existsSync(p)) throw new Error(`missing json file: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function toOperation(r) {
  return {
    id: r.op_id,
    kind: r.kind,
    at_ms: Number(r.at_ms),
    device_uid: r.device_uid,
    attribute: r.attribute,
    value: parseMaybeNumber(r.value),
    ...(r.platform ? { platform: r.platform } : {}),
  };
}

function loadTable7FromCsv(p) {
  const rows = readCsvRows(p);
  const groups = new Map();
  for (const r of rows) {
    const gid = r.group_id;
    const cid = r.case_id;
    if (!groups.has(gid)) {
      groups.set(gid, {
        id: gid,
        label: r.group_label,
        testbed: r.testbed,
        pattern: r.pattern,
        candidate_ids: parseCandidateIds(r.candidate_ids),
        cases: new Map(),
      });
    }
    const g = groups.get(gid);
    if (!g.cases.has(cid)) {
      g.cases.set(cid, {
        case_id: cid,
        variant: r.variant,
        start_epoch_ms: Number(r.start_epoch_ms),
        operations: [],
      });
    }
    g.cases.get(cid).operations.push(toOperation(r));
  }
  return {
    groups: Array.from(groups.values()).map((g) => ({
      ...g,
      cases: Array.from(g.cases.values()).sort((a, b) => a.case_id.localeCompare(b.case_id)),
    })),
  };
}

function loadTable8FromCsv(p) {
  const rows = readCsvRows(p);
  const streamsByTestbed = new Map();
  for (const r of rows) {
    const tb = r.testbed || 'T1';
    if (!streamsByTestbed.has(tb)) streamsByTestbed.set(tb, []);
    streamsByTestbed.get(tb).push({
      testbed: tb,
      op_id: r.op_id,
      ts_epoch_ms: Number(r.ts_epoch_ms),
      kind: r.kind,
      device_uid: r.device_uid,
      attribute: r.attribute,
      value: parseMaybeNumber(r.value),
      platform: r.platform || '',
    });
  }
  for (const [tb, arr] of streamsByTestbed.entries()) {
    arr.sort((a, b) => a.ts_epoch_ms - b.ts_epoch_ms);
    streamsByTestbed.set(tb, arr);
  }
  return { streamsByTestbed };
}

function loadTable9FromCsv(p) {
  const rows = readCsvRows(p);
  const groups = new Map();
  let repetitions = 1;
  for (const r of rows) {
    const gid = r.group_id;
    repetitions = Math.max(repetitions, Number(r.repetitions || 1));
    if (!groups.has(gid)) {
      groups.set(gid, {
        id: gid,
        label: r.group_label,
        testbed: r.testbed,
        pattern: r.pattern,
        candidate_ids: parseCandidateIds(r.candidate_ids),
        expected_option_id: r.expected_option_id || null,
        expect_detection: parseBool(r.expect_detection),
        auto_option_map: r.auto_option_map_json ? JSON.parse(r.auto_option_map_json) : {},
        scenario: {
          id: r.scenario_id || `table9_${gid}`,
          start_epoch_ms: Number(r.scenario_start_epoch_ms),
          operations: [],
        },
      });
    }
    groups.get(gid).scenario.operations.push(toOperation(r));
  }
  return { repetitions, groups: Array.from(groups.values()) };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function runScenarioQuiet(repoRoot, scenario, quiet) {
  if (!quiet) return runScenario(repoRoot, scenario);
  const oldLog = console.log;
  const oldWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await runScenario(repoRoot, scenario);
  } finally {
    console.log = oldLog;
    console.warn = oldWarn;
  }
}

function metric(tp, fp, fn) {
  const precision = (tp + fp) > 0 ? (tp / (tp + fp)) : null;
  const recall = (tp + fn) > 0 ? (tp / (tp + fn)) : null;
  const f1 = (precision !== null && recall !== null && (precision + recall) > 0)
    ? (2 * precision * recall) / (precision + recall)
    : null;
  return { precision, recall, f1 };
}

function average(list) {
  const nums = (list || []).filter((x) => Number.isFinite(x));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function getCandidateSet(group) {
  const ids = Array.isArray(group && group.candidate_ids) ? group.candidate_ids : [];
  return new Set(ids.filter(Boolean).map((x) => String(x)));
}

function countTargetInstances(out, group) {
  const set = getCandidateSet(group);
  const list = Array.isArray(out && out.verified_instances) ? out.verified_instances : [];
  if (!set.size) {
    const p = String(group && group.pattern || '');
    return list.filter((x) => x && x.pattern === p).length;
  }
  return list.filter((x) => x && set.has(String(x.candidate_id || ''))).length;
}

function countTargetDecisions(out, group) {
  const set = getCandidateSet(group);
  const list = Array.isArray(out && out.policy_decisions) ? out.policy_decisions : [];
  if (!set.size) {
    const p = String(group && group.pattern || '');
    return list.filter((x) => x && x.pattern === p).length;
  }
  return list.filter((x) => x && set.has(String(x.candidate_id || ''))).length;
}

function hasExpectedOption(out, group, expectedOptionId) {
  if (!expectedOptionId) return true;
  const set = getCandidateSet(group);
  const list = Array.isArray(out && out.policy_decisions) ? out.policy_decisions : [];
  const relevant = list.filter((x) => {
    if (!x) return false;
    if (set.size) return set.has(String(x.candidate_id || ''));
    return x.pattern === String(group && group.pattern || '');
  });
  return relevant.some((x) => x && x.option_id === expectedOptionId);
}

function makeScenarioFromCase(group, c) {
  return {
    id: c.case_id,
    testbed: group.testbed,
    start_epoch_ms: Number(c.start_epoch_ms),
    operations: Array.isArray(c.operations) ? c.operations : [],
    verification_event_broadcast_all: true,
    concurrent_within_tick: false,
    shuffle_within_tick: false,
    expected_patterns: [],
  };
}

function makeScenarioFromWeekTestbed(testbed, weekData) {
  const all = (weekData && weekData.streamsByTestbed && weekData.streamsByTestbed.get(testbed)) || [];
  const startTs = all.length ? all[0].ts_epoch_ms : Date.now();
  return {
    id: `week_${testbed}_full_stream`,
    testbed,
    start_epoch_ms: startTs,
    operations: all.map((x) => ({
      id: x.op_id,
      kind: x.kind,
      at_ms: Math.max(0, x.ts_epoch_ms - startTs),
      device_uid: x.device_uid,
      attribute: x.attribute,
      value: x.value,
      ...(x.platform ? { platform: x.platform } : {}),
    })),
    verification_event_broadcast_all: true,
    concurrent_within_tick: false,
    shuffle_within_tick: true,
    expected_patterns: [],
  };
}

async function runTable7(repoRoot, microData, quiet) {
  const groups = Array.isArray(microData && microData.groups) ? microData.groups : [];
  const rows = [];

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const cases = Array.isArray(g && g.cases) ? g.cases : [];

    let tp = 0;
    let fp = 0;
    let tn = 0;
    let fn = 0;

    for (const c of cases) {
      const sc = makeScenarioFromCase(g, c);
      const out = await runScenarioQuiet(repoRoot, sc, quiet);
      const hit = countTargetInstances(out, g) > 0;
      const positive = String(c && c.variant) === 'positive';
      if (positive && hit) tp++;
      if (positive && !hit) fn++;
      if (!positive && hit) fp++;
      if (!positive && !hit) tn++;
    }

    const m = metric(tp, fp, fn);
    rows.push({
      id: g.id,
      label: g.label,
      testbed: g.testbed,
      pattern: g.pattern,
      candidate_ids: Array.isArray(g.candidate_ids) ? g.candidate_ids : [],
      replay_nall: cases.length,
      replay_ngt: cases.filter((c) => c && c.variant === 'positive').length,
      confusion: { tp, fp, tn, fn },
      ours_precision: m.precision,
      ours_recall: m.recall,
      ours_f1: m.f1,
    });
    process.stdout.write(`[sim-eval] table7 ${i + 1}/${groups.length} ${g.id} done\n`);
  }

  return {
    source: 'Metrics from raw microbench data',
    groups: rows,
    aggregate: {
      group_count: rows.length,
      avg_precision: average(rows.map((x) => x.ours_precision)),
      avg_recall: average(rows.map((x) => x.ours_recall)),
      avg_f1: average(rows.map((x) => x.ours_f1)),
      total_tp: rows.reduce((n, x) => n + x.confusion.tp, 0),
      total_fp: rows.reduce((n, x) => n + x.confusion.fp, 0),
      total_fn: rows.reduce((n, x) => n + x.confusion.fn, 0),
      total_tn: rows.reduce((n, x) => n + x.confusion.tn, 0),
    },
  };
}

async function runTable8(repoRoot, weekData, weekGroups, weekGroundTruth, quiet) {
  // Replay full-week streams first, then compute each group's metrics from the same output.
  const groups = Array.isArray(weekGroups && weekGroups.groups) ? weekGroups.groups : [];
  const gtMap = new Map(
    (Array.isArray(weekGroundTruth && weekGroundTruth.groups) ? weekGroundTruth.groups : []).map((g) => [g.id, g])
  );
  const outByTestbed = new Map();
  const uniqueTestbeds = Array.from(new Set(groups.map((g) => g.testbed).filter(Boolean)));
  for (const tb of uniqueTestbeds) {
    const sc = makeScenarioFromWeekTestbed(tb, weekData);
    const out = await runScenarioQuiet(repoRoot, sc, quiet);
    outByTestbed.set(tb, out);
  }
  const rows = [];

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const out = outByTestbed.get(g.testbed) || {
      verified_instances: [],
      policy_decisions: [],
      blocked_ops: 0,
      op_count: 0,
    };
    const detected = countTargetInstances(out, g);
    const gt = gtMap.get(g.id) || {};
    const n1 = Number.isFinite(Number(gt.n1)) ? Number(gt.n1) : null;
    const n2 = Number.isFinite(Number(gt.n2)) ? Number(gt.n2) : null;
    const ngt = Number.isFinite(Number(gt.ngt)) ? Number(gt.ngt) : null;
    const canScore = ngt !== null;
    const tp = canScore ? Math.min(detected, ngt) : null;
    const fp = canScore ? Math.max(0, detected - ngt) : null;
    const fn = canScore ? Math.max(0, ngt - detected) : null;
    const m = canScore ? metric(tp, fp, fn) : { precision: null, recall: null, f1: null };

    rows.push({
      id: g.id,
      label: g.label,
      testbed: g.testbed,
      pattern: g.pattern,
      candidate_ids: Array.isArray(g.candidate_ids) ? g.candidate_ids : [],
      replay_n1: n1,
      replay_n2: n2,
      replay_ngt: ngt,
      replay_detected_instances: detected,
      ours_precision: m.precision,
      ours_recall: m.recall,
      ours_f1: m.f1,
      blocked_ops: null,
      op_count: null,
    });
    process.stdout.write(`[sim-eval] table8 ${i + 1}/${groups.length} ${g.id} done\n`);
  }

  return {
    source: 'Metrics from raw one-week data',
    groups: rows,
    aggregate: {
      group_count: rows.length,
      avg_precision: average(rows.map((x) => x.ours_precision)),
      avg_recall: average(rows.map((x) => x.ours_recall)),
      avg_f1: average(rows.map((x) => x.ours_f1)),
      total_replay_detected_instances: rows.reduce((n, x) => n + x.replay_detected_instances, 0),
      total_replay_ngt: rows.reduce((n, x) => n + (Number.isFinite(x.replay_ngt) ? x.replay_ngt : 0), 0),
    },
  };
}

async function runTable9(repoRoot, handlingData, quiet) {
  const groups = Array.isArray(handlingData && handlingData.groups) ? handlingData.groups : [];
  const defaultReps = Math.max(1, Number(handlingData && handlingData.repetitions || 1));
  const rows = [];

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const reps = Math.max(1, Number(g && g.repetitions || defaultReps));

    const scenario = g && g.scenario ? g.scenario : {};
    const expectedOptionId = g && g.expected_option_id ? String(g.expected_option_id) : null;
    const expectDetection = g && typeof g.expect_detection === 'boolean' ? g.expect_detection : true;

    const runRecords = [];
    for (let r = 0; r < reps; r++) {
      const sc = {
        id: `${scenario.id || `table9_${g.id}`}_rep${r + 1}`,
        testbed: g.testbed,
        start_epoch_ms: Number.isFinite(Number(scenario.start_epoch_ms))
          ? (Number(scenario.start_epoch_ms) + r * 300000)
          : (Date.now() + r * 300000),
        operations: Array.isArray(scenario.operations) ? scenario.operations : [],
        verification_event_broadcast_all: true,
        concurrent_within_tick: false,
        shuffle_within_tick: false,
        expected_patterns: [],
        auto_option_map: g.auto_option_map || {},
      };

      const out = await runScenarioQuiet(repoRoot, sc, quiet);
      const targetInstanceCount = countTargetInstances(out, g);
      const targetDecisionCount = countTargetDecisions(out, g);
      const detectionOk = expectDetection ? (targetInstanceCount > 0) : (targetInstanceCount === 0);
      const optionOk = hasExpectedOption(out, g, expectedOptionId);

      runRecords.push({
        repetition: r + 1,
        target_instance_count: targetInstanceCount,
        target_decision_count: targetDecisionCount,
        expected_option_id: expectedOptionId,
        option_ok: optionOk,
        detection_ok: detectionOk,
        pass: detectionOk && optionOk,
        blocked_ops: Number(out.blocked_ops || 0),
        op_count: Number(out.op_count || 0),
      });
    }

    const replayHandledProperly = runRecords.every((x) => x.pass);
    rows.push({
      id: g.id,
      label: g.label,
      testbed: g.testbed,
      pattern: g.pattern,
      candidate_ids: Array.isArray(g.candidate_ids) ? g.candidate_ids : [],
      expected_option_id: expectedOptionId,
      expected_detection: expectDetection,
      replay_handled: {
        ours: replayHandledProperly,
      },
      runs: runRecords,
    });

    process.stdout.write(`[sim-eval] table9 ${i + 1}/${groups.length} ${g.id} done\n`);
  }

  return {
    source: 'Handling metrics from raw data',
    groups: rows,
    aggregate: {
      group_count: rows.length,
      replay_ours_true_count: rows.filter((x) => x.replay_handled.ours).length,
    },
  };
}

async function main() {
  const microDataPath = path.resolve(process.cwd(), DEFAULT_MICRO_DATA_REL);
  const weekDataPath = path.resolve(process.cwd(), DEFAULT_WEEK_DATA_REL);
  const weekGroupsPath = path.resolve(process.cwd(), DEFAULT_WEEK_GROUPS_REL);
  const weekGroundTruthPath = path.resolve(process.cwd(), DEFAULT_WEEK_GROUND_TRUTH_REL);
  const handlingDataPath = path.resolve(process.cwd(), DEFAULT_HANDLING_DATA_REL);
  const resultsDir = DEFAULT_RESULTS_DIR;
  ensureDir(resultsDir);

  const quiet = true;

  const microData = loadTable7FromCsv(microDataPath);
  const weekData = loadTable8FromCsv(weekDataPath);
  const weekGroups = readJson(weekGroupsPath);
  const weekGroundTruth = readJson(weekGroundTruthPath);
  const handlingData = loadTable9FromCsv(handlingDataPath);

  const repoRoot = process.cwd();
  const table7 = await runTable7(repoRoot, microData, quiet);
  const table8 = await runTable8(repoRoot, weekData, weekGroups, weekGroundTruth, quiet);
  const table9 = await runTable9(repoRoot, handlingData, quiet);

  const out7 = path.join(resultsDir, 'table7_replay.json');
  const out8 = path.join(resultsDir, 'table8_replay.json');
  const out9 = path.join(resultsDir, 'table9_replay.json');
  const outAll = path.join(resultsDir, 'eval_replay_summary.json');

  fs.writeFileSync(out7, JSON.stringify(table7, null, 2), 'utf-8');
  fs.writeFileSync(out8, JSON.stringify(table8, null, 2), 'utf-8');
  fs.writeFileSync(out9, JSON.stringify(table9, null, 2), 'utf-8');
  fs.writeFileSync(outAll, JSON.stringify({
    raw_data: {
      table7: DEFAULT_MICRO_DATA_REL,
      table8: DEFAULT_WEEK_DATA_REL,
      table8_groups: DEFAULT_WEEK_GROUPS_REL,
      table8_ground_truth: DEFAULT_WEEK_GROUND_TRUTH_REL,
      table9: DEFAULT_HANDLING_DATA_REL,
    },
    table7,
    table8,
    table9,
  }, null, 2), 'utf-8');

  console.log(`[sim-eval] raw table7 data -> ${microDataPath}`);
  console.log(`[sim-eval] raw table8 data -> ${weekDataPath}`);
  console.log(`[sim-eval] raw table9 data -> ${handlingDataPath}`);
  console.log(`[sim-eval] table7 replay -> ${out7}`);
  console.log(`[sim-eval] table8 replay -> ${out8}`);
  console.log(`[sim-eval] table9 replay -> ${out9}`);
  console.log(`[sim-eval] combined replay -> ${outAll}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[sim-eval] failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}
