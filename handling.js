
'use strict';

/**
 * handling.js
 * Threat handling module that consumes verified instances from verification.observe.
 *
 * Responsibilities:
 *  1) Provide handling option templates for all supported patterns.
 *  2) Present verified threat instances to users in a console UI, explain pattern & options, guide selection & parameters.
 *  3) Generate and store a policy for the selected option, and auto-apply it for subsequent occurrences of the same instance.
 *
 * Runtime integration:
 *  - stream_handler() is the only hook entry; it calls verification.observe() and handles policies.
 *  - This file stores policies in a JSON file and keeps an in-memory cache for fast matching.
 *  - “Real-time execution” here is represented as returning an enforcement plan; actual actuator control / blocking
 *    must be wired to your mediator’s command dispatcher.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const verification = require('./verification');
let db;
try {
  db = require('./messenger/core/db');
} catch (err) {
  db = {
    getEventTargetPlatform: async () => undefined,
  };
  console.warn(`[handling] db adapter unavailable, running without platform lookup: ${err.message}`);
}

const POLICIES_PATH = process.env.POLICIES_PATH
  || path.join(__dirname, 'evaluation', 'policies.json');

const VERIFICATION_DEBUG = process.env.VERIFICATION_DEBUG === '1';
const HANDLING_AUTO_POLICY = process.env.HANDLING_AUTO_POLICY === '1';
const HANDLING_DEFAULT_OPTION = process.env.HANDLING_DEFAULT_OPTION || '';
let HANDLING_AUTO_OPTION_MAP = {};
try {
  HANDLING_AUTO_OPTION_MAP = process.env.HANDLING_AUTO_OPTION_MAP
    ? JSON.parse(process.env.HANDLING_AUTO_OPTION_MAP)
    : {};
} catch (_) {
  HANDLING_AUTO_OPTION_MAP = {};
}

function debugLog(...args) { if (VERIFICATION_DEBUG) console.log('[handling]', ...args); }

function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

function policyKeyFromInstance(inst) {
  // Candidate-level key is the most stable, because candidate_id is produced by screening.
  // dir distinguishes symmetric directions (potential RC / infinite loop).
  return `${inst.candidate_id || ''}|${inst.dir || ''}`;
}

function loadPoliciesSafe() {
  try {
    if (!fs.existsSync(POLICIES_PATH)) return { policies: [] };
    const raw = fs.readFileSync(POLICIES_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.policies)) return { policies: [] };
    return data;
  } catch (e) {
    console.warn(`[handling] failed to load policies: ${e.message}`);
    return { policies: [] };
  }
}

function savePoliciesSafe(policiesObj) {
  try {
    const dir = path.dirname(POLICIES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(POLICIES_PATH, JSON.stringify(policiesObj, null, 2), 'utf-8');
  } catch (e) {
    console.warn(`[handling] failed to save policies: ${e.message}`);
  }
}

const policyStore = {
  loaded: false,
  policiesObj: { policies: [] },
  policiesByKey: new Map(),
};

const RULES_PATH = process.env.RULES_PATH
  || path.join(__dirname, 'evaluation', 'testbed_T1_rules.json');

const rulesStore = {
  loaded: false,
  rulesById: new Map(),
};

// policy_id -> runtime state used by window/min-interval style options.
const enforcementRuntime = new Map();

let observationListener = null;

function ensurePoliciesLoaded() {
  if (policyStore.loaded) return;
  policyStore.policiesObj = loadPoliciesSafe();
  policyStore.policiesByKey = new Map();
  for (const p of policyStore.policiesObj.policies) {
    if (p && p.policy_key) {
      policyStore.policiesByKey.set(p.policy_key, p);
    }
  }
  policyStore.loaded = true;
}

function upsertPolicy(policy) {
  ensurePoliciesLoaded();
  policyStore.policiesByKey.set(policy.policy_key, policy);
  // rebuild array (deterministic order by created_ts)
  const arr = Array.from(policyStore.policiesByKey.values()).sort((a, b) => (a.created_ts || 0) - (b.created_ts || 0));
  policyStore.policiesObj.policies = arr;
  savePoliciesSafe(policyStore.policiesObj);
}

function getPolicyByInstance(inst) {
  ensurePoliciesLoaded();
  return policyStore.policiesByKey.get(policyKeyFromInstance(inst));
}

function ensureRulesLoaded() {
  if (rulesStore.loaded) return;
  rulesStore.loaded = true;
  rulesStore.rulesById = new Map();
  try {
    const raw = fs.readFileSync(RULES_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    const list = parsed && Array.isArray(parsed.rules) ? parsed.rules : [];
    for (const r of list) {
      if (r && r.rule_id) rulesStore.rulesById.set(r.rule_id, r);
    }
  } catch (err) {
    console.warn(`[handling] failed to load rules from ${RULES_PATH}: ${err.message}`);
  }
}

function getRuleById(ruleId) {
  ensureRulesLoaded();
  return rulesStore.rulesById.get(ruleId);
}

function parseTimeToMinutes(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase();
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) return h * 60 + mm;
    return null;
  }
  m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (m) {
    let h = Number(m[1]) % 12;
    const mm = Number(m[2] || 0);
    if (m[3] === 'pm') h += 12;
    if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) return h * 60 + mm;
  }
  return null;
}

function minutesNow() {
  const d = new Date(Date.now());
  return d.getHours() * 60 + d.getMinutes();
}

function compareValues(op, left, right) {
  if (op === '==') return String(left) === String(right);
  if (op === '!=') return String(left) !== String(right);
  const l = Number(left);
  const r = Number(right);
  if (!Number.isFinite(l) || !Number.isFinite(r)) return false;
  if (op === '>') return l > r;
  if (op === '>=') return l >= r;
  if (op === '<') return l < r;
  if (op === '<=') return l <= r;
  return false;
}

function betweenCheck(value, range, asTime) {
  if (!Array.isArray(range) || range.length < 2) return false;
  if (asTime) {
    const v = parseTimeToMinutes(value);
    const lo = parseTimeToMinutes(range[0]);
    const hi = parseTimeToMinutes(range[1]);
    if (v === null || lo === null || hi === null) return false;
    if (lo <= hi) return v >= lo && v <= hi;
    return v >= lo || v <= hi;
  }
  const v = Number(value);
  const lo = Number(range[0]);
  const hi = Number(range[1]);
  if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  return v >= Math.min(lo, hi) && v <= Math.max(lo, hi);
}

function isTimeTerm(term) {
  if (!term || typeof term !== 'object') return false;
  return String(term.type || '').toLowerCase() === 'time' || String(term.attr || '').toLowerCase() === 'time';
}

function normalizeTerm(term) {
  if (!term || typeof term !== 'object') return null;
  const out = { ...term };
  if (isTimeTerm(out)) {
    if (!out.uid) out.uid = 'GLOBAL';
    if (!out.attr) out.attr = 'time';
  }
  return out;
}

function latestObservedValue(uid, attr) {
  try {
    const dbg = verification.getDebugState();
    const events = dbg && Array.isArray(dbg.recentEvents) ? dbg.recentEvents : [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (String(e.deviceId) === String(uid) && String(e.attribute) === String(attr)) return e.value;
    }
  } catch (_) {}
  return undefined;
}

function termSatisfiedNow(term) {
  const t = normalizeTerm(term);
  if (!t || !t.op) return false;
  if (isTimeTerm(t)) {
    const nowMin = minutesNow();
    if (t.op === 'between') return betweenCheck(nowMin, t.val, true);
    const rhs = parseTimeToMinutes(t.val);
    if (rhs === null) return false;
    if (t.op === '==') return nowMin === rhs;
    if (t.op === '!=') return nowMin !== rhs;
    if (t.op === '>') return nowMin > rhs;
    if (t.op === '>=') return nowMin >= rhs;
    if (t.op === '<') return nowMin < rhs;
    if (t.op === '<=') return nowMin <= rhs;
    return false;
  }
  const value = latestObservedValue(t.uid, t.attr);
  if (value === undefined) return false;
  if (t.op === 'between') return betweenCheck(value, t.val, false);
  return compareValues(t.op, value, t.val);
}

function getRuleLogic(rule, scope /* trigger | condition */) {
  const direct = rule ? rule[`${scope}_logic`] : undefined;
  const legacy = scope === 'condition'
    ? (rule ? rule.condition_logic : undefined)
    : (rule ? rule.trigger_logic : undefined);
  const meta = rule && rule.metadata
    ? (rule.metadata[`${scope}_logic`] || (scope === 'condition' ? rule.metadata.condition_logic : rule.metadata.trigger_logic))
    : undefined;
  const logic = String(direct || legacy || meta || 'AND').toUpperCase();
  return logic === 'OR' ? 'OR' : 'AND';
}

function evalTermsNow(terms, logic) {
  const list = Array.isArray(terms) ? terms : [];
  if (list.length === 0) return true;
  if (logic === 'OR') return list.some(termSatisfiedNow);
  return list.every(termSatisfiedNow);
}

function evalRuleConditionNow(ruleId) {
  const rule = getRuleById(ruleId);
  if (!rule) return false;
  return evalTermsNow(rule.condition, getRuleLogic(rule, 'condition'));
}

function evalSimpleCond(cond) {
  if (cond === undefined || cond === null) return true;
  const s = String(cond).trim();
  if (!s || s === 'time_window_or_state') return true;

  let m = s.match(/^time\s+between\s+([0-9]{1,2}:[0-9]{2})\s*[-~]\s*([0-9]{1,2}:[0-9]{2})$/i);
  if (m) {
    return betweenCheck(minutesNow(), [m[1], m[2]], true);
  }
  m = s.match(/^after\s+([0-9]{1,2}:[0-9]{2})$/i);
  if (m) {
    const rhs = parseTimeToMinutes(m[1]);
    return rhs !== null && minutesNow() >= rhs;
  }
  m = s.match(/^before\s+([0-9]{1,2}:[0-9]{2})$/i);
  if (m) {
    const rhs = parseTimeToMinutes(m[1]);
    return rhs !== null && minutesNow() <= rhs;
  }

  // uid.attr OP val
  m = s.match(/^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*(==|!=|>=|<=|>|<)\s*([A-Za-z0-9_:-]+)$/);
  if (m) {
    const left = latestObservedValue(m[1], m[2]);
    if (left === undefined) return false;
    return compareValues(m[3], left, m[4]);
  }

  // attr OP val (GLOBAL attr by default)
  m = s.match(/^([A-Za-z0-9_-]+)\s*(==|!=|>=|<=|>|<)\s*([A-Za-z0-9_:-]+)$/);
  if (m) {
    const left = latestObservedValue('GLOBAL', m[1]);
    if (left === undefined) return false;
    return compareValues(m[2], left, m[3]);
  }

  // Unknown free-form expression: keep permissive to avoid accidental over-blocking.
  return true;
}

function getRuntimeState(policyId) {
  const key = String(policyId || 'no_policy');
  let st = enforcementRuntime.get(key);
  if (!st) {
    st = {
      lastManualTs: null,
      lastRuleTs: new Map(),
    };
    enforcementRuntime.set(key, st);
  }
  return st;
}

// -------- Deterministic option templates --------
//
// We keep them as "templates" with:
//  - option_id: stable identifier
//  - title: short title
//  - explanation: user-facing explanation text
//  - params: list of params needed from user
//  - buildPolicy: function(instance, params) -> policy enforcement plan (normalized)

function optionTemplates() {
  return {
    // ===== Core option set =====
    'CAI-PotentialRC': [
      {
        option_id: 'T4_PRC_O1',
        title: 'No intervention (order doesn’t matter)',
        explanation: 'The execution order does not matter, so let the two rules execute without intervention.',
        params: [],
        buildPolicy: (inst) => ({ action: 'allow_both' }),
      },
      {
        option_id: 'T4_PRC_O2',
        title: 'Final state decided by R2 (re-issue A2 after A1)',
        explanation: 'The execution order matters and the final device states should be decided by R2; thus, if action A2 is executed first, execute it again t seconds after A1 is executed (t is 30 by default but configurable).',
        params: [{ name: 't_seconds', type: 'number', default: 30, prompt: 'Enter t (seconds) to re-issue R2 action after R1 action:' }],
        buildPolicy: (inst, params) => ({ action: 'reissue_after', winner: 'R2', t_seconds: params.t_seconds }),
      },
      {
        option_id: 'T4_PRC_O3',
        title: 'Final state decided by R1 (re-issue A1 after A2)',
        explanation: 'The execution order matters and the final device states should be decided by R1; thus, if action A1 is executed first, execute it again t seconds after A2 is executed (t is 30 by default but configurable).',
        params: [{ name: 't_seconds', type: 'number', default: 30, prompt: 'Enter t (seconds) to re-issue R1 action after R2 action:' }],
        buildPolicy: (inst, params) => ({ action: 'reissue_after', winner: 'R1', t_seconds: params.t_seconds }),
      },
      {
        option_id: 'T4_PRC_O4',
        title: 'Enforce minimum interval between A1 and A2',
        explanation: 'A1 and A2 should not be issued too closely; instead, the time interval between the two actions should be at least t seconds (t is 30 by default but configurable).',
        params: [{ name: 't_seconds', type: 'number', default: 30, prompt: 'Enter minimum interval t (seconds) between actions:' }],
        buildPolicy: (inst, params) => ({ action: 'min_interval', t_seconds: params.t_seconds }),
      },
    ],

    'CAI-ChainedExecution': [
      {
        option_id: 'T4_CHAIN_O1',
        title: 'Block A2 (do not execute the downstream action)',
        explanation: 'Action A2 should not be executed.',
        params: [],
        buildPolicy: (inst) => ({ action: 'block_rule', block: 'R2' }),
      },
      {
        option_id: 'T4_CHAIN_O2',
        title: 'Allow A2 (execute downstream action)',
        explanation: 'Action A2 should be executed.',
        params: [],
        buildPolicy: (inst) => ({ action: 'allow' }),
      },
      {
        option_id: 'T4_CHAIN_O3',
        title: 'Allow A2 only under a condition cond',
        explanation: 'Allow A2 to be executed under a certain condition cond (cond is configurable and can be specific device states and/or time period).',
        params: [{ name: 'cond', type: 'string', default: 'time_window_or_state', prompt: 'Enter cond (free-form, e.g., "after 22:00", "when home_mode==home"):' }],
        buildPolicy: (inst, params) => ({ action: 'allow_if', target: 'R2', cond: params.cond }),
      },
    ],

    'CMAI-ChainedExecution': [
      {
        option_id: 'T4_CMAI_CHAIN_O1',
        title: 'Block A3 (do not execute rule action after manual control)',
        explanation: 'Action A3 should not be executed.',
        params: [],
        buildPolicy: (inst) => ({ action: 'block_rule', block: 'R3' }),
      },
      {
        option_id: 'T4_CMAI_CHAIN_O2',
        title: 'Allow A3 (execute rule action)',
        explanation: 'Action A3 should be executed.',
        params: [],
        buildPolicy: (inst) => ({ action: 'allow' }),
      },
      {
        option_id: 'T4_CMAI_CHAIN_O3',
        title: 'Allow A3 only under condition cond',
        explanation: 'Allow A3 to be executed under a certain condition cond (cond is configurable and can be specific device states and/or time period).',
        params: [{ name: 'cond', type: 'string', default: 'time_window_or_state', prompt: 'Enter cond (free-form):' }],
        buildPolicy: (inst, params) => ({ action: 'allow_if', target: 'R3', cond: params.cond }),
      },
    ],

    'CMAI-PotentialRC': [
      {
        option_id: 'T4_CMAI_PRC_O1',
        title: 'Manual control always overrides; block rule action',
        explanation: 'Manual control c should always execute to override rule action A3, but the rule action should not be executed to override the manual control.',
        params: [],
        buildPolicy: (inst) => ({ action: 'manual_overrides', block_rule: true }),
      },
      {
        option_id: 'T4_CMAI_PRC_O2',
        title: 'Allow mutual override between manual and rule',
        explanation: 'Manual control c and rule action A3 can override each other.',
        params: [],
        buildPolicy: (inst) => ({ action: 'allow_both' }),
      },
      {
        option_id: 'T4_CMAI_PRC_O3',
        title: 'Manual overrides; block rule override within t seconds',
        explanation: 'Manual control c should always execute to override rule action A3, but the rule action should not be executed to override the manual control within t seconds (t is 30 by default but configurable).',
        params: [{ name: 't_seconds', type: 'number', default: 30, prompt: 'Enter t (seconds) window where rule cannot override manual:' }],
        buildPolicy: (inst, params) => ({ action: 'manual_overrides_with_window', t_seconds: params.t_seconds }),
      },
    ],

    'CMAI-ConditionEnabling': [
      {
        option_id: 'T4_CMAI_COND_EN_O1',
        title: 'Block A3',
        explanation: 'Action A3 should not be executed.',
        params: [],
        buildPolicy: (inst) => ({ action: 'block_rule', block: 'R3' }),
      },
      {
        option_id: 'T4_CMAI_COND_EN_O2',
        title: 'Allow A3',
        explanation: 'Action A3 should be executed.',
        params: [],
        buildPolicy: (inst) => ({ action: 'allow' }),
      },
    ],

    'CMAI-ConditionDisabling': [
      {
        option_id: 'T4_CMAI_COND_DIS_O1',
        title: 'Force execute A3 (enforce state of A3)',
        explanation: 'Action A3 should be executed.',
        params: [],
        buildPolicy: (inst) => ({ action: 'enforce_rule_action', target: 'R3' }),
      },
      {
        option_id: 'T4_CMAI_COND_DIS_O2',
        title: 'Do not execute A3',
        explanation: 'Action A3 should not be executed.',
        params: [],
        buildPolicy: (inst) => ({ action: 'block_rule', block: 'R3' }),
      },
    ],

    // ===== Extended option set =====
    'CAI-ConditionBypass': [
      {
        option_id: 'T11_BYPASS_O1',
        title: 'Execute A1 when either/both rules triggered; block A2 when both conditions true',
        explanation: 'Execute action A1 when either or both of the two rules are triggered.',
        params: [],
        buildPolicy: () => ({ action: 'prefer_A1' }),
      },
      {
        option_id: 'T11_BYPASS_O2',
        title: 'Execute A1 only when both conditions are true',
        explanation: 'Execute action A1 when the conditions of both rules are true.',
        params: [],
        buildPolicy: () => ({ action: 'require_both_conditions_for_A1' }),
      },
      {
        option_id: 'T11_BYPASS_O3',
        title: 'Let first rule work and disable the second',
        explanation: 'Let the first rule work and disable the second.',
        params: [],
        buildPolicy: () => ({ action: 'disable_rule', disable: 'R2' }),
      },
    ],

    'CAI-ConditionEnabling': [
      {
        option_id: 'T11_COND_EN_O1',
        title: 'Block A2',
        explanation: 'Action A2 should not be executed.',
        params: [],
        buildPolicy: () => ({ action: 'block_rule', block: 'R2' }),
      },
      {
        option_id: 'T11_COND_EN_O2',
        title: 'Allow A2',
        explanation: 'Action A2 should be executed.',
        params: [],
        buildPolicy: () => ({ action: 'allow' }),
      },
    ],

    'CAI-ConditionDisabling': [
      {
        option_id: 'T11_COND_DIS_O1',
        title: 'Force execute A2 (enforce state of A2)',
        explanation: 'Action A2 should be executed.',
        params: [],
        buildPolicy: () => ({ action: 'enforce_rule_action', target: 'R2' }),
      },
      {
        option_id: 'T11_COND_DIS_O2',
        title: 'Do not execute A2',
        explanation: 'Action A2 should not be executed.',
        params: [],
        buildPolicy: () => ({ action: 'block_rule', block: 'R2' }),
      },
    ],

    'CAI-RaceCondition': [
      {
        option_id: 'T11_RC_O1',
        title: 'When conflict, execute A2 and block A1',
        explanation: 'When the two rules conflict, action A2 should be executed and A1 should be blocked.',
        params: [],
        buildPolicy: () => ({ action: 'prefer_rule', prefer: 'R2' }),
      },
      {
        option_id: 'T11_RC_O2',
        title: 'When conflict, execute A1 and block A2',
        explanation: 'When the two rules conflict, action A1 should be executed and A2 should be blocked.',
        params: [],
        buildPolicy: () => ({ action: 'prefer_rule', prefer: 'R1' }),
      },
    ],

    'CAI-ActionRevert': [
      {
        option_id: 'T11_REVERT_O1',
        title: 'Do not execute A2 to override A1',
        explanation: 'Action A2 should not be executed to override A1.',
        params: [],
        buildPolicy: () => ({ action: 'block_rule', block: 'R2' }),
      },
      {
        option_id: 'T11_REVERT_O2',
        title: 'Execute A2 to override A1',
        explanation: 'Action A2 should be executed to override A1.',
        params: [],
        buildPolicy: () => ({ action: 'prefer_rule', prefer: 'R2' }),
      },
      {
        option_id: 'T11_REVERT_O3',
        title: 'Allow A2 to override A1 under condition cond',
        explanation: 'Allow action A2 to be executed to override A1 under a certain condition cond (cond is configurable and can be specific device states and/or time period).',
        params: [{ name: 'cond', type: 'string', default: 'time_window_or_state', prompt: 'Enter cond (free-form):' }],
        buildPolicy: (inst, params) => ({ action: 'prefer_rule_if', prefer: 'R2', cond: params.cond }),
      },
    ],

    'CAI-InfiniteLoop': [
      {
        option_id: 'T11_LOOP_O1',
        title: 'When loop forms, only execute action A1 (block R2)',
        explanation: 'When the two rules form a loop, only action A1 should be executed.',
        params: [],
        buildPolicy: () => ({ action: 'allow_only', allow: 'R1' }),
      },
      {
        option_id: 'T11_LOOP_O2',
        title: 'When loop forms, only execute action A2 (block R1)',
        explanation: 'When the two rules form a loop, only action A2 should be executed.',
        params: [],
        buildPolicy: () => ({ action: 'allow_only', allow: 'R2' }),
      },
    ],
  };
}

// Map candidate pattern aliases to canonical option-template keys.
// Keep both aliases for robustness.
function normalizePatternName(pattern) {
  if (!pattern) return '';
  // Some candidates use 'CAI-PotentialRaceCondition' vs 'CAI-PotentialRC' etc.
  const p = String(pattern);
  const map = {
    'CAI-PotentialRaceCondition': 'CAI-PotentialRC',
    'CAI-PotentialRC': 'CAI-PotentialRC',
    'CAI-ChainedExecution': 'CAI-ChainedExecution',
    'CAI-ActionRevert': 'CAI-ActionRevert',
    'CAI-RaceCondition': 'CAI-RaceCondition',
    'CAI-ConditionEnabling': 'CAI-ConditionEnabling',
    'CAI-ConditionDisabling': 'CAI-ConditionDisabling',
    'CAI-ConditionBypass': 'CAI-ConditionBypass',
    'CAI-InfiniteLoop': 'CAI-InfiniteLoop',

    'CMAI-ChainedExecution': 'CMAI-ChainedExecution',
    'CMAI-PotentialRaceCondition': 'CMAI-PotentialRC',
    'CMAI-PotentialRC': 'CMAI-PotentialRC',
    'CMAI-ConditionEnabling': 'CMAI-ConditionEnabling',
    'CMAI-ConditionDisabling': 'CMAI-ConditionDisabling',
  };
  return map[p] || p;
}

// -------- Console UI helpers --------

function rlInterface() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, q) {
  return new Promise(resolve => rl.question(q, ans => resolve(ans)));
}

function findOptionByPolicy(opts, inst) {
  const norm = normalizePatternName(inst.pattern);
  const byPattern = HANDLING_AUTO_OPTION_MAP && HANDLING_AUTO_OPTION_MAP[norm];
  if (byPattern) {
    const hit = opts.find(o => o.option_id === byPattern);
    if (hit) return hit;
  }
  if (HANDLING_DEFAULT_OPTION) {
    const hit = opts.find(o => o.option_id === HANDLING_DEFAULT_OPTION);
    if (hit) return hit;
  }
  return opts[0] || null;
}

function fmtRules(inst) {
  if (inst.kind === 'CAI') return `R1=${inst.rules && inst.rules[0]} , R2=${inst.rules && inst.rules[1]}`;
  return `R3=${inst.rules && inst.rules[0]}`;
}

function fmtManual(inst) {
  if (inst.kind !== 'CMAI') return '';
  const mc = inst.manual_control || {};
  return `MC(uid=${mc.uid}, cmd=${mc.cmd}${mc.args ? ', args=' + JSON.stringify(mc.args) : ''})`;
}

function fmtTimelineShort(inst) {
  const tl = Array.isArray(inst.timeline) ? inst.timeline : [];
  const seq = tl.map(x => x.assertion).join(' -> ');
  return seq || '(no timeline)';
}

async function promptUserForPolicy(inst) {
  const pKey = policyKeyFromInstance(inst);
  console.log('\n================ Threat Handling ================');
  console.log(`Verified threat instance: ${inst.instance_id}`);
  console.log(`Pattern: ${inst.pattern}`);
  console.log(`Candidate key: ${pKey}`);
  console.log(`Involved: ${fmtRules(inst)} ${fmtManual(inst)}`);
  console.log(`Assertion trace: ${fmtTimelineShort(inst)}\n`);

  const normP = normalizePatternName(inst.pattern);
  const templates = optionTemplates();
  const opts = templates[normP] || [];
  if (!opts.length) {
    console.log(`[handling] No handling templates found for pattern=${inst.pattern} (normalized=${normP}).`);
    console.log('Default: do nothing (allow).');
    return { option_id: 'DEFAULT_ALLOW', params: {}, enforcement: { action: 'allow' } };
  }

  if (HANDLING_AUTO_POLICY) {
    const chosen = findOptionByPolicy(opts, inst);
    const params = {};
    for (const p of (chosen.params || [])) {
      params[p.name] = p.default;
    }
    const enforcement = chosen.buildPolicy(inst, params);
    console.log(`[handling] Auto-selected option: ${chosen.option_id} - ${chosen.title}`);
    console.log('[handling] Enforcement plan:', JSON.stringify(enforcement, null, 2));
    console.log('=================================================\n');
    return { option_id: chosen.option_id, params, enforcement };
  }

  const rl = rlInterface();
  try {
    console.log('Available handling options:');
    for (let i = 0; i < opts.length; i++) {
      console.log(`  [${i + 1}] ${opts[i].title}`);
      console.log(`      ${opts[i].explanation}`);
    }

    let idx = -1;
    while (idx < 0 || idx >= opts.length) {
      const ans = await ask(rl, `Select option [1-${opts.length}]: `);
      const n = Number(ans);
      if (Number.isFinite(n) && n >= 1 && n <= opts.length) idx = n - 1;
    }

    const chosen = opts[idx];
    const params = {};
    for (const p of (chosen.params || [])) {
      const ans = await ask(rl, `${p.prompt} (default=${p.default}): `);
      if (ans === '' || ans === undefined || ans === null) {
        params[p.name] = p.default;
      } else if (p.type === 'number') {
        const n = Number(ans);
        params[p.name] = Number.isFinite(n) ? n : p.default;
      } else {
        params[p.name] = String(ans);
      }
    }

    const enforcement = chosen.buildPolicy(inst, params);

    console.log('\n[handling] Selected option:', chosen.option_id, '-', chosen.title);
    console.log('[handling] Enforcement plan:', JSON.stringify(enforcement, null, 2));
    console.log('=================================================\n');

    return { option_id: chosen.option_id, params, enforcement };
  } finally {
    rl.close();
  }
}

function setObservationListener(fn) {
  observationListener = (typeof fn === 'function') ? fn : null;
}

// -------- Main entry: consume a verified instance --------

async function handleThreatInstance(inst) {
  ensurePoliciesLoaded();
  const key = policyKeyFromInstance(inst);
  const existing = getPolicyByInstance(inst);

  if (existing) {
    // Auto apply the previously chosen policy; do not prompt user.
    console.log(`\n[handling] Auto-apply existing policy policy_id=${existing.policy_id} for candidate_key=${key}`);
    console.log(`[handling] Enforcement plan: ${JSON.stringify(existing.enforcement, null, 2)}\n`);
    return { applied: true, policy: existing };
  }

  const { option_id, params, enforcement } = await promptUserForPolicy(inst);

  const policy = {
    policy_id: 'pol_' + sha1(`${Date.now()}_${Math.random()}`).slice(0, 16),
    policy_key: key,
    pattern: inst.pattern,
    candidate_id: inst.candidate_id,
    dir: inst.dir || null,
    created_ts: Date.now(),
    option_id,
    params,
    enforcement,
    // snapshot for traceability
    instance_example: {
      kind: inst.kind,
      rules: inst.rules,
      manual_control: inst.manual_control || null,
    },
  };

  upsertPolicy(policy);
  console.log(`[handling] Saved policy policy_id=${policy.policy_id} -> ${POLICIES_PATH}\n`);
  return { applied: true, policy };
}

function resolveRuleIdByAlias(inst, alias) {
  if (!inst || !Array.isArray(inst.rules)) return null;
  if (alias === 'R1') return inst.rules[0];
  if (alias === 'R2') return inst.rules[1];
  if (alias === 'R3') return inst.rules[0];
  return null;
}

function decideAllowedFromPolicy(policy, inst, origin) {
  if (!policy || !policy.enforcement) return { allowed: true, reason: 'no_policy' };
  const enforcement = policy.enforcement || {};
  const action = enforcement.action;
  const now = Date.now();
  const st = getRuntimeState(policy.policy_id);
  const isRuleOrigin = !!(origin && origin.source === 'rule');
  const isManualOrigin = !!(origin && (origin.source === 'mc_remote' || origin.source === 'mc_physical'));
  const originRuleId = isRuleOrigin ? origin.ruleId : null;
  const involveRules = Array.isArray(inst && inst.rules) ? inst.rules.filter(Boolean) : [];

  // Decision model:
  // - derive a per-operation allow/block verdict from selected policy,
  // - keep lightweight runtime state for time-window options,
  // - remain conservative when policy intent is unclear.
  let decision = { allowed: true, reason: 'policy_allow' };

  if (action === 'block') {
    decision = { allowed: false, reason: 'policy_block' };
  } else if (action === 'manual_overrides') {
    if (enforcement.block_rule && isRuleOrigin) {
      decision = { allowed: false, reason: 'policy_manual_overrides' };
    }
  } else if (action === 'manual_overrides_with_window') {
    if (isRuleOrigin) {
      const tMs = Math.max(0, Number(enforcement.t_seconds) || 30) * 1000;
      if (Number.isFinite(st.lastManualTs) && (now - st.lastManualTs) <= tMs) {
        decision = { allowed: false, reason: 'policy_manual_override_window' };
      }
    }
  } else if (action === 'block_rule' || action === 'disable_rule') {
    if (isRuleOrigin) {
      const target = resolveRuleIdByAlias(inst, enforcement.block || enforcement.disable);
      if (!target || originRuleId === target) {
        decision = { allowed: false, reason: 'policy_block_rule' };
      } else {
        decision = { allowed: true, reason: 'policy_block_other' };
      }
    }
  } else if (action === 'allow_only') {
    if (isRuleOrigin) {
      const target = resolveRuleIdByAlias(inst, enforcement.allow);
      if (target && originRuleId !== target) {
        decision = { allowed: false, reason: 'policy_allow_only' };
      }
    }
  } else if (action === 'prefer_rule') {
    if (isRuleOrigin) {
      const target = resolveRuleIdByAlias(inst, enforcement.prefer);
      if (target && originRuleId !== target) {
        decision = { allowed: false, reason: 'policy_prefer_rule' };
      }
    }
  } else if (action === 'prefer_rule_if') {
    if (isRuleOrigin) {
      const target = resolveRuleIdByAlias(inst, enforcement.prefer);
      const condOk = evalSimpleCond(enforcement.cond);
      if (target && originRuleId !== target) {
        decision = { allowed: false, reason: 'policy_prefer_other_blocked' };
      } else if (!condOk) {
        decision = { allowed: false, reason: 'policy_prefer_cond_failed' };
      }
    }
  } else if (action === 'prefer_A1') {
    if (isRuleOrigin) {
      const r2 = resolveRuleIdByAlias(inst, 'R2');
      if (r2 && originRuleId === r2) {
        decision = { allowed: false, reason: 'policy_prefer_A1' };
      }
    }
  } else if (action === 'require_both_conditions_for_A1') {
    if (isRuleOrigin) {
      const r1 = resolveRuleIdByAlias(inst, 'R1');
      const r2 = resolveRuleIdByAlias(inst, 'R2');
      if (r1 && originRuleId !== r1) {
        decision = { allowed: false, reason: 'policy_require_A1_only' };
      } else {
        const c1 = r1 ? evalRuleConditionNow(r1) : false;
        const c2 = r2 ? evalRuleConditionNow(r2) : false;
        if (!(c1 && c2)) {
          decision = { allowed: false, reason: 'policy_require_both_conditions' };
        }
      }
    }
  } else if (action === 'allow_if') {
    if (isRuleOrigin) {
      const target = resolveRuleIdByAlias(inst, enforcement.target);
      if (!target || originRuleId === target) {
        if (!evalSimpleCond(enforcement.cond)) {
          decision = { allowed: false, reason: 'policy_allow_if_failed' };
        }
      }
    }
  } else if (action === 'enforce_rule_action') {
    if (isRuleOrigin) {
      const target = resolveRuleIdByAlias(inst, enforcement.target);
      if (target && originRuleId !== target) {
        decision = { allowed: false, reason: 'policy_enforce_specific_rule' };
      }
    }
  } else if (action === 'min_interval') {
    if (isRuleOrigin && involveRules.includes(originRuleId)) {
      const tMs = Math.max(0, Number(enforcement.t_seconds) || 30) * 1000;
      for (const other of involveRules) {
        if (other === originRuleId) continue;
        const ts = st.lastRuleTs.get(other);
        if (Number.isFinite(ts) && (now - ts) < tMs) {
          decision = { allowed: false, reason: 'policy_min_interval' };
          break;
        }
      }
    }
  } else if (action === 'reissue_after') {
    // Requires an external scheduler/dispatcher. Keep command allowed here.
    decision = { allowed: true, reason: 'policy_reissue_plan_only' };
  } else if (action === 'allow' || action === 'allow_both') {
    decision = { allowed: true, reason: 'policy_allow' };
  }

  // Update runtime state after evaluating this operation.
  // State update happens after decision so each policy sees a stable "previous" context.
  if (isManualOrigin) {
    st.lastManualTs = now;
  }
  if (isRuleOrigin && originRuleId) {
    st.lastRuleTs.set(originRuleId, now);
  }

  return decision;
}

async function preProcessStreamItem() {
  return { allowed: true, reason: 'no_pre_policy' };
}

async function stream_handler({ kind, payload, next }) {
  const pre = await preProcessStreamItem({ kind, payload });
  if (pre && pre.allowed === false) {
    return;
  }

  if (kind === 'event') {
    const deviceId = payload && payload.device ? payload.device.uid : undefined;
    const attribute = payload ? payload.attribute : undefined;
    const value = payload ? payload.value : undefined;
    let targetPlatform;
    try {
      targetPlatform = await db.getEventTargetPlatform(payload);
    } catch (err) {
      targetPlatform = undefined;
    }
    console.log(`[stream_handler] event deviceId=${deviceId} attribute=${attribute} value=${value} targetPlatform=${targetPlatform}`);
  }

  if (kind === 'command') {
    const deviceId = payload && payload.device ? payload.device.uid : undefined;
    const attribute = payload ? payload.attribute : undefined;
    const value = payload ? payload.value : undefined;
    const sourcePlatform = payload ? payload.platform : undefined;
    console.log(`[stream_handler] command deviceId=${deviceId} attribute=${attribute} value=${value} sourcePlatform=${sourcePlatform}`);
  }

  const observation = await verification.observe({ kind, payload });
  const verified = Array.isArray(observation.verified) ? observation.verified : [];

  let allowed = true;
  const decisions = [];
  for (const inst of verified) {
    const applied = await handleThreatInstance(inst);
    const decision = decideAllowedFromPolicy(applied && applied.policy ? applied.policy : null, inst, observation.origin);
    decisions.push({
      instance_id: inst.instance_id,
      candidate_id: inst.candidate_id,
      pattern: inst.pattern,
      option_id: applied && applied.policy ? applied.policy.option_id : null,
      policy_id: applied && applied.policy ? applied.policy.policy_id : null,
      allowed: decision.allowed,
      reason: decision.reason,
    });
    if (decision.allowed === false) allowed = false;
    debugLog('[handling] enforcement:', { instance_id: inst.instance_id, decision });
  }

  const result = { allowed, observation, decisions };
  if (observationListener) {
    try {
      observationListener({
        kind,
        payload,
        allowed,
        observation,
        decisions,
      });
    } catch (err) {
      console.error('[handling] observation listener failed:', err);
    }
  }

  if (!allowed) return result;
  if (typeof next === 'function') {
    await next();
  }
  return result;
}

module.exports = {
  stream_handler,
  handleThreatInstance,
  normalizePatternName,
  setObservationListener,
};
