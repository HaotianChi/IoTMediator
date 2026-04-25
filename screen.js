"use strict";

/**
 * Static screening stage for IoTMediator.
 *
 * This module implements candidate discovery:
 * - CAI: 8 patterns
 * - CMAI: 4 patterns
 *
 * Input:
 * - rules JSON (testbed automation rules)
 * - devices JSON (room/device metadata)
 *
 * Output:
 * - candidate JSON consumed by runtime verification.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// -------------------- Pattern Names --------------------
const PAT = {
  // 8 CAI
  CAI_COND_EN: "CAI-ConditionEnabling",
  CAI_COND_DIS: "CAI-ConditionDisabling",
  CAI_RC: "CAI-RaceCondition",
  CAI_PRC: "CAI-PotentialRaceCondition",
  CAI_CHAIN: "CAI-ChainedExecution",
  CAI_REVERT: "CAI-ActionRevert",
  CAI_BYPASS: "CAI-ConditionBypass",
  CAI_LOOP: "CAI-InfiniteLoop",

  // 4 CMAI
  CMAI_CHAIN: "CMAI-ChainedExecution",
  CMAI_PRC: "CMAI-PotentialRaceCondition",
  CMAI_COND_EN: "CMAI-ConditionEnabling",
  CMAI_COND_DIS: "CMAI-ConditionDisabling",
};

const SYMMETRIC_CAI = new Set([
  PAT.CAI_RC,
  PAT.CAI_PRC,
  PAT.CAI_LOOP,
  PAT.CAI_BYPASS,
]);

// -------------------- Semantic Effect Model (cmd -> env attr delta) --------------------
const DEVICE_EFFECT_MODEL = {
  "light.on": [{ attr: "luminance", direction: "increase" }],
  "light.off": [{ attr: "luminance", direction: "decrease" }],

  "heater.on": [
    { attr: "temperature", direction: "increase" },
    { attr: "power", direction: "increase" },
  ],
  "heater.off": [
    { attr: "temperature", direction: "decrease" },
    { attr: "power", direction: "decrease" },
  ],

  "window.on": [{ attr: "temperature", direction: "decrease" }],
  "window.off": [{ attr: "temperature", direction: "increase" }],

  "microwave.on": [{ attr: "power", direction: "increase" }],
  "microwave.off": [{ attr: "power", direction: "decrease" }],
};

// -------------------- CLI --------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = (i + 1 < argv.length && !argv[i + 1].startsWith("--")) ? argv[++i] : true;
    args[key] = val;
  }
  return args;
}
const args = parseArgs(process.argv);

const DEFAULTS = {
  t1_rules: "./evaluation/testbed_T1_rules.json",
  t1_devices: "./evaluation/testbed_T1_devices.json",
  t1_out: "./evaluation/candidates_T1.json",
  t2_rules: "./evaluation/testbed_T2_rules.json",
  t2_devices: "./evaluation/testbed_T2_devices.json",
  t2_out: "./evaluation/candidates_T2.json",
};

// -------------------- Utils --------------------
function sha1(s) {
  return crypto.createHash("sha1").update(s).digest("hex");
}
function candId(payload) {
  return "CAND_" + sha1(JSON.stringify(payload)).slice(0, 12);
}
function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}
function stableStr(x) {
  if (!isObject(x)) return JSON.stringify(x);
  const keys = Object.keys(x).sort();
  const out = {};
  for (const k of keys) out[k] = x[k];
  return JSON.stringify(out);
}
function dedupByKey(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = keyFn(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
function symPairKey(a, b) {
  return [String(a), String(b)].sort().join("|");
}
function symCmaiKey(ruleId, mc) {
  const argsKey = mc && mc.args ? stableStr(mc.args) : "";
  return `${String(ruleId)}|${String(mc.uid)}|${String(mc.cmd)}|${argsKey}`;
}

// -------------------- Device room index (device-level gating) --------------------
function buildDeviceIndex(devicesJson) {
  const devices = Array.isArray(devicesJson.devices) ? devicesJson.devices : [];
  const idx = new Map(); // uid -> Set(rooms)
  for (const d of devices) {
    if (!d || !d.system_id) continue;
    const r = d.room;
    const set = new Set();
    if (Array.isArray(r)) {
      for (const x of r) {
        const s = String(x).trim();
        if (s) set.add(s);
      }
    } else if (typeof r === "string") {
      const s = r.trim();
      if (s) set.add(s);
    }
    idx.set(String(d.system_id), set);
  }
  // special global pseudo device (if exists in rules)
  idx.set("GLOBAL", new Set(["*"]));
  return idx;
}

function roomsIntersectByUid(uidA, uidB, deviceIdx) {
  const a = String(uidA || "");
  const b = String(uidB || "");

  // GLOBAL intersects with everything
  if (a === "GLOBAL" || b === "GLOBAL") return true;

  const setA = deviceIdx.get(a);
  const setB = deviceIdx.get(b);

  // For accuracy: if we cannot resolve rooms, do NOT assume influence.
  if (!setA || !setB) return false;
  if (setA.size === 0 || setB.size === 0) return false;

  for (const x of setA) if (setB.has(x)) return true;
  return false;
}

// -------------------- Term helpers --------------------
function getTerms(list) {
  return Array.isArray(list) ? list.filter(isObject) : [];
}
function normalizeTerms(list) {
  return getTerms(list).map(stableStr).sort().join("|");
}
function sameTrigger(r1, r2) {
  return normalizeTerms(r1.trigger) === normalizeTerms(r2.trigger);
}
function sameAction(r1, r2) {
  return normalizeTerms(r1.action) === normalizeTerms(r2.action);
}
function conditionDifferent(r1, r2) {
  return normalizeTerms(r1.condition) !== normalizeTerms(r2.condition);
}

// -------------------- Command parsing & conflict --------------------
function parseCmd(cmd) {
  if (typeof cmd !== "string") return null;
  const parts = cmd.split(".");
  if (parts.length !== 2) return null;
  return { domain: parts[0], verb: parts[1] };
}

function actionToDomainVerb(action) {
  if (!action || typeof action.cmd !== "string") return null;
  if (action.cmd === "mode.set") {
    const modeVal = action.args && action.args.mode;
    if (modeVal === undefined || modeVal === null) return null;
    return { domain: "home_mode", verb: String(modeVal) };
  }
  return parseCmd(action.cmd);
}

function oppositeCmd(cmd) {
  if (typeof cmd !== "string") return null;

  if (cmd === "lock.lock") return "lock.unlock";
  if (cmd === "lock.unlock") return "lock.lock";

  if (cmd.startsWith("mode.")) return null;

  const p = parseCmd(cmd);
  if (!p) return null;
  if (p.verb === "on") return `${p.domain}.off`;
  if (p.verb === "off") return `${p.domain}.on`;
  return null;
}

function isActionConflict(a1, a2) {
  if (!a1 || !a2) return false;
  if (a1.uid !== a2.uid) return false;
  if (a1.cmd === "mode.set" && a2.cmd === "mode.set") {
    const m1 = a1.args && a1.args.mode;
    const m2 = a2.args && a2.args.mode;
    if (m1 && m2 && m1 !== m2) return true;
  }
  const opp = oppositeCmd(a1.cmd);
  return !!opp && opp === a2.cmd;
}

// -------------------- Semantic relations --------------------
function semanticEffectsOfCmd(cmd) {
  const eff = DEVICE_EFFECT_MODEL[cmd];
  if (!eff) return [];
  return Array.isArray(eff) ? eff : [eff];
}
function isComparableOp(op) {
  return op === "<" || op === "<=" || op === ">" || op === ">=";
}
function isEqualityOp(op) {
  return op === "==" || op === "!=";
}

// Direct action satisfies device-state equality/inequality term:
// term: {uid, attr:<domain>, op:==/!=, val:<verb>}
function directActionSatisfiesEqTerm(action, term) {
  if (!action || !term) return { ok: false };
  if (!("uid" in term) || !("attr" in term) || !("op" in term) || !("val" in term)) return { ok: false };
  if (!isEqualityOp(term.op)) return { ok: false };
  if (String(term.uid) !== String(action.uid)) return { ok: false };

  const p = actionToDomainVerb(action);
  if (!p) return { ok: false };

  const match = (String(term.attr) === p.domain) && (String(term.val) === p.verb);
  if (term.op === "==") return match ? { ok: true, reason: "direct equality satisfied" } : { ok: false };
  return !match ? { ok: true, reason: "direct inequality satisfied" } : { ok: false };
}

// Semantic action influences env term (trigger): needs term.uid (sensor uid) and same-room (device-level)
function semanticActionTriggersEnvTerm(action, term, deviceIdx) {
  const effects = semanticEffectsOfCmd(action.cmd);
  if (effects.length === 0) return { ok: false };
  if (!term || !("attr" in term) || !("op" in term)) return { ok: false };
  if (!isComparableOp(term.op)) return { ok: false };

  // MUST have sensor uid to do device-level room gating accurately
  if (!("uid" in term)) return { ok: false };
  if (!roomsIntersectByUid(action.uid, term.uid, deviceIdx)) return { ok: false };

  for (const eff of effects) {
    if (String(term.attr) !== String(eff.attr)) continue;
    if (eff.direction === "increase" && (term.op === ">" || term.op === ">=")) {
      return { ok: true, reason: `same-room env: increase(${eff.attr}) may satisfy ${term.attr} ${term.op} ${term.val}` };
    }
    if (eff.direction === "decrease" && (term.op === "<" || term.op === "<=")) {
      return { ok: true, reason: `same-room env: decrease(${eff.attr}) may satisfy ${term.attr} ${term.op} ${term.val}` };
    }
  }
  return { ok: false };
}

// Semantic action enables/disables env condition term: needs term.uid (sensor uid) and same-room
function semanticActionEnablesEnvCond(action, cond, deviceIdx) {
  const effects = semanticEffectsOfCmd(action.cmd);
  if (effects.length === 0) return { ok: false };
  if (!cond || !("attr" in cond) || !("op" in cond)) return { ok: false };
  if (!isComparableOp(cond.op)) return { ok: false };

  if (!("uid" in cond)) return { ok: false };
  if (!roomsIntersectByUid(action.uid, cond.uid, deviceIdx)) return { ok: false };

  for (const eff of effects) {
    if (String(cond.attr) !== String(eff.attr)) continue;
    if (eff.direction === "increase" && (cond.op === ">" || cond.op === ">=")) {
      return { ok: true, reason: "same-room env: increase may make condition hold" };
    }
    if (eff.direction === "decrease" && (cond.op === "<" || cond.op === "<=")) {
      return { ok: true, reason: "same-room env: decrease may make condition hold" };
    }
  }
  return { ok: false };
}

function semanticActionDisablesEnvCond(action, cond, deviceIdx) {
  const effects = semanticEffectsOfCmd(action.cmd);
  if (effects.length === 0) return { ok: false };
  if (!cond || !("attr" in cond) || !("op" in cond)) return { ok: false };
  if (!isComparableOp(cond.op)) return { ok: false };

  if (!("uid" in cond)) return { ok: false };
  if (!roomsIntersectByUid(action.uid, cond.uid, deviceIdx)) return { ok: false };

  for (const eff of effects) {
    if (String(cond.attr) !== String(eff.attr)) continue;
    if (eff.direction === "increase" && (cond.op === "<" || cond.op === "<=")) {
      return { ok: true, reason: "same-room env: increase may violate condition" };
    }
    if (eff.direction === "decrease" && (cond.op === ">" || cond.op === ">=")) {
      return { ok: true, reason: "same-room env: decrease may violate condition" };
    }
  }
  return { ok: false };
}

// A ↦ T: direct device-state OR semantic env (device-level room gating)
function actionTriggersTrigger(ruleFrom, ruleTo, action, trigTerm, deviceIdx) {
  const d = directActionSatisfiesEqTerm(action, trigTerm);
  if (d.ok) return { ok: true, mode: "direct", reason: d.reason };

  const s = semanticActionTriggersEnvTerm(action, trigTerm, deviceIdx);
  if (s.ok) return { ok: true, mode: "semantic", reason: s.reason };

  return { ok: false };
}

// A ⇒ C: direct OR semantic env (device-level room gating)
function actionEnablesCondition(action, condTerm, deviceIdx) {
  const d = directActionSatisfiesEqTerm(action, condTerm);
  if (d.ok) return { ok: true, mode: "direct", reason: d.reason };

  const s = semanticActionEnablesEnvCond(action, condTerm, deviceIdx);
  if (s.ok) return { ok: true, mode: "semantic", reason: s.reason };

  return { ok: false };
}

// A ⇏ C: direct violation OR semantic env (device-level room gating)
function actionDisablesCondition(action, condTerm, deviceIdx) {
  // direct violation for device-state equality/inequality
  if (condTerm && ("uid" in condTerm) && ("attr" in condTerm) && ("op" in condTerm) && ("val" in condTerm) &&
      isEqualityOp(condTerm.op) && String(condTerm.uid) === String(action.uid)) {
    const p = actionToDomainVerb(action);
    if (p && String(condTerm.attr) === p.domain) {
      const match = String(condTerm.val) === p.verb;
      if (condTerm.op === "==") {
        if (!match) return { ok: true, mode: "direct", reason: "direct equality violated" };
      } else { // "!="
        if (match) return { ok: true, mode: "direct", reason: "direct inequality violated" };
      }
    }
  }

  const s = semanticActionDisablesEnvCond(action, condTerm, deviceIdx);
  if (s.ok) return { ok: true, mode: "semantic", reason: s.reason };

  return { ok: false };
}

// -------------------- Existence helpers --------------------
function existsActionTriggersAnyTrigger(rFrom, rTo, deviceIdx) {
  for (const a of getTerms(rFrom.action)) {
    if (!("uid" in a) || !("cmd" in a)) continue;
    for (const t of getTerms(rTo.trigger)) {
      if (!("attr" in t) || !("op" in t)) continue;
      const res = actionTriggersTrigger(rFrom, rTo, a, t, deviceIdx);
      if (res.ok) return { ok: true, witness: { action: a, trigger: t, mode: res.mode, reason: res.reason } };
    }
  }
  return { ok: false };
}

function existsActionEnablesAnyCondition(rFrom, rTo, deviceIdx) {
  for (const a of getTerms(rFrom.action)) {
    if (!("uid" in a) || !("cmd" in a)) continue;
    for (const c of getTerms(rTo.condition)) {
      if (!("attr" in c) || !("op" in c)) continue;
      const res = actionEnablesCondition(a, c, deviceIdx);
      if (res.ok) return { ok: true, witness: { action: a, condition: c, mode: res.mode, reason: res.reason } };
    }
  }
  return { ok: false };
}

function existsActionDisablesAnyCondition(rFrom, rTo, deviceIdx) {
  for (const a of getTerms(rFrom.action)) {
    if (!("uid" in a) || !("cmd" in a)) continue;
    for (const c of getTerms(rTo.condition)) {
      if (!("attr" in c) || !("op" in c)) continue;
      const res = actionDisablesCondition(a, c, deviceIdx);
      if (res.ok) return { ok: true, witness: { action: a, condition: c, mode: res.mode, reason: res.reason } };
    }
  }
  return { ok: false };
}

function existsAnyConflictBetween(r1, r2) {
  for (const a1 of getTerms(r1.action)) {
    for (const a2 of getTerms(r2.action)) {
      if (isActionConflict(a1, a2)) return { ok: true, witness: { a1, a2 } };
    }
  }
  return { ok: false };
}

function existsConflictFromR2ToR1(r1, r2) {
  for (const a1 of getTerms(r1.action)) {
    for (const a2 of getTerms(r2.action)) {
      if (isActionConflict(a1, a2)) return { ok: true, witness: { a1, a2 } };
    }
  }
  return { ok: false };
}

// -------------------- CAI screening (ALL 8) --------------------
function caiKey(c) {
  if (SYMMETRIC_CAI.has(c.pattern)) return `${c.pattern}|${symPairKey(c.r1, c.r2)}`;
  return `${c.pattern}|${String(c.r1)}|${String(c.r2)}`;
}

function filterCaiSemanticDuplicates(list) {
  const loopPairs = new Set();
  const rcPairs = new Set();
  const revertPairs = new Set();

  for (const c of list) {
    const pairKey = symPairKey(c.r1, c.r2);
    if (c.pattern === PAT.CAI_LOOP) loopPairs.add(pairKey);
    if (c.pattern === PAT.CAI_RC) rcPairs.add(pairKey);
    if (c.pattern === PAT.CAI_REVERT) revertPairs.add(`${String(c.r1)}|${String(c.r2)}`);
  }

  return list.filter((c) => {
    const pairKey = symPairKey(c.r1, c.r2);
    if (c.pattern === PAT.CAI_PRC && rcPairs.has(pairKey)) return false;
    if ((c.pattern === PAT.CAI_CHAIN || c.pattern === PAT.CAI_REVERT) && loopPairs.has(pairKey)) return false;
    if (c.pattern === PAT.CAI_CHAIN && revertPairs.has(`${String(c.r1)}|${String(c.r2)}`)) return false;
    return true;
  });
}

function screenCAI(rules, deviceIdx) {
  const out = [];

  // Symmetric candidates (i<j)
  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const r1 = rules[i], r2 = rules[j];

      // CAI-PotentialRaceCondition: A1 = ¬A2
      const conf = existsAnyConflictBetween(r1, r2);
      if (conf.ok) {
        out.push({
          candidate_id: candId({ p: PAT.CAI_PRC, pair: symPairKey(r1.rule_id, r2.rule_id) }),
          kind: "CAI",
          pattern: PAT.CAI_PRC,
          r1: r1.rule_id,
          r2: r2.rule_id,
          static_evidence: { relation: "A1=¬A2", witness: conf.witness },
        });

        // CAI-RaceCondition: T1 = T2 AND A1 = ¬A2
        if (sameTrigger(r1, r2)) {
          out.push({
            candidate_id: candId({ p: PAT.CAI_RC, pair: symPairKey(r1.rule_id, r2.rule_id) }),
            kind: "CAI",
            pattern: PAT.CAI_RC,
            r1: r1.rule_id,
            r2: r2.rule_id,
            static_evidence: { relation: "T1=T2 and A1=¬A2", witness: { same_trigger: true, conflict: conf.witness } },
          });
        }
      }

      // CAI-ConditionBypass: T1=T2 AND A1=A2 AND C1!=C2
      if (sameTrigger(r1, r2) && sameAction(r1, r2) && conditionDifferent(r1, r2)) {
        out.push({
          candidate_id: candId({ p: PAT.CAI_BYPASS, pair: symPairKey(r1.rule_id, r2.rule_id) }),
          kind: "CAI",
          pattern: PAT.CAI_BYPASS,
          r1: r1.rule_id,
          r2: r2.rule_id,
          static_evidence: { relation: "T1=T2, A1=A2, C1!=C2" },
        });
      }

      // CAI-InfiniteLoop: (A1 ↦ T2) AND (A2 ↦ T1)
      const a1ToT2 = existsActionTriggersAnyTrigger(r1, r2, deviceIdx);
      const a2ToT1 = existsActionTriggersAnyTrigger(r2, r1, deviceIdx);
      if (a1ToT2.ok && a2ToT1.ok) {
        out.push({
          candidate_id: candId({ p: PAT.CAI_LOOP, pair: symPairKey(r1.rule_id, r2.rule_id) }),
          kind: "CAI",
          pattern: PAT.CAI_LOOP,
          r1: r1.rule_id,
          r2: r2.rule_id,
          static_evidence: { relation: "A1↦T2 and A2↦T1", witness: { a1_to_t2: a1ToT2.witness, a2_to_t1: a2ToT1.witness } },
        });
      }
    }
  }

  // Directional candidates (i!=j)
  for (let i = 0; i < rules.length; i++) {
    for (let j = 0; j < rules.length; j++) {
      if (i === j) continue;
      const r1 = rules[i], r2 = rules[j];

      // CAI-ChainedExecution: A1 ↦ T2
      const a1ToT2 = existsActionTriggersAnyTrigger(r1, r2, deviceIdx);
      if (a1ToT2.ok) {
        out.push({
          candidate_id: candId({ p: PAT.CAI_CHAIN, r1: r1.rule_id, r2: r2.rule_id, w: a1ToT2.witness }),
          kind: "CAI",
          pattern: PAT.CAI_CHAIN,
          r1: r1.rule_id,
          r2: r2.rule_id,
          static_evidence: { relation: "A1↦T2", witness: a1ToT2.witness },
        });
      }

      // CAI-ActionRevert: A1 ↦ T2 AND A2 = ¬A1
      if (a1ToT2.ok) {
        const rev = existsConflictFromR2ToR1(r1, r2);
        if (rev.ok) {
          out.push({
            candidate_id: candId({ p: PAT.CAI_REVERT, r1: r1.rule_id, r2: r2.rule_id, w: { a1ToT2: a1ToT2.witness, conflict: rev.witness } }),
            kind: "CAI",
            pattern: PAT.CAI_REVERT,
            r1: r1.rule_id,
            r2: r2.rule_id,
            static_evidence: { relation: "A1↦T2 and A2=¬A1", witness: { a1_to_t2: a1ToT2.witness, conflict: rev.witness } },
          });
        }
      }

      // CAI-ConditionEnabling / Disabling: A1 ⇒ C2 / A1 ⇏ C2 (device-level gating inside semantic funcs)
      const en = existsActionEnablesAnyCondition(r1, r2, deviceIdx);
      if (en.ok) {
        out.push({
          candidate_id: candId({ p: PAT.CAI_COND_EN, r1: r1.rule_id, r2: r2.rule_id, w: en.witness }),
          kind: "CAI",
          pattern: PAT.CAI_COND_EN,
          r1: r1.rule_id,
          r2: r2.rule_id,
          static_evidence: { relation: "A1⇒C2", witness: en.witness },
        });
      }

      const dis = existsActionDisablesAnyCondition(r1, r2, deviceIdx);
      if (dis.ok) {
        out.push({
          candidate_id: candId({ p: PAT.CAI_COND_DIS, r1: r1.rule_id, r2: r2.rule_id, w: dis.witness }),
          kind: "CAI",
          pattern: PAT.CAI_COND_DIS,
          r1: r1.rule_id,
          r2: r2.rule_id,
          static_evidence: { relation: "A1⇏C2", witness: dis.witness },
        });
      }
    }
  }

  const deduped = dedupByKey(out, caiKey);
  return filterCaiSemanticDuplicates(deduped);
}

// -------------------- CMAI screening (ALL 4) --------------------
function inferManualControls(devicesJson) {
  const devices = Array.isArray(devicesJson.devices) ? devicesJson.devices : [];
  const ctrls = [];

  const homeModes = ["home", "away", "saving", "party"];
  for (const mode of homeModes) {
    ctrls.push({ uid: "GLOBAL", cmd: "mode.set", args: { mode } });
  }

  for (const d of devices) {
    if (!d || d.is_infrastructure) continue;
    const uid = d.system_id;

    // Preferred: declared supported_commands
    if (Array.isArray(d.supported_commands) && d.supported_commands.length > 0) {
      for (const cmd of d.supported_commands) {
        if (typeof cmd === "string") ctrls.push({ uid, cmd });
        else if (isObject(cmd) && cmd.cmd) ctrls.push({ uid, cmd: cmd.cmd });
      }
      continue;
    }

    // Fallback inference (safe)
    const st = String(d.semantic_type || "").toLowerCase();
    if (st === "light") ctrls.push({ uid, cmd: "light.on" }, { uid, cmd: "light.off" });
    if (st === "heater") ctrls.push({ uid, cmd: "heater.on" }, { uid, cmd: "heater.off" });
    if (st === "window") ctrls.push({ uid, cmd: "window.on" }, { uid, cmd: "window.off" });
    if (st === "camera") ctrls.push({ uid, cmd: "camera.on" }, { uid, cmd: "camera.off" });
    if (st === "lock") ctrls.push({ uid, cmd: "lock.lock" }, { uid, cmd: "lock.unlock" });
  }

  // dedup
  const seen = new Set();
  const out = [];
  for (const c of ctrls) {
    const argsKey = c.args ? stableStr(c.args) : "";
    const k = `${c.uid}|${c.cmd}|${argsKey}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function cmaiKey(c) {
  // all CMAI are order-independent (rule + manual control)
  return `${c.pattern}|${symCmaiKey(c.r3, c.mc)}`;
}

function screenCMAI(rules, devicesJson, deviceIdx) {
  const out = [];
  const ctrls = inferManualControls(devicesJson);

  for (const mc of ctrls) {
    const action = { uid: mc.uid, cmd: mc.cmd, args: mc.args };

    for (const r3 of rules) {
      // CMAI-PotentialRaceCondition: c = ¬A3
      for (const a3 of getTerms(r3.action)) {
        if (!("uid" in a3) || !("cmd" in a3)) continue;
        if (isActionConflict(action, a3)) {
          out.push({
            candidate_id: candId({ p: PAT.CMAI_PRC, k: symCmaiKey(r3.rule_id, mc) }),
            kind: "CMAI",
            pattern: PAT.CMAI_PRC,
            r3: r3.rule_id,
            mc,
            static_evidence: { relation: "c=¬A3", witness: { c: action, a3 } },
          });
          break;
        }
      }

      // CMAI-ConditionEnabling / Disabling: c ⇒ C3 / c ⇏ C3
      // device-level gating works because cond terms carry sensor UID, and manual op has a device UID.
      const pseudoFrom = { action: [action] };
      const en = existsActionEnablesAnyCondition(pseudoFrom, r3, deviceIdx);
      if (en.ok) {
        out.push({
          candidate_id: candId({ p: PAT.CMAI_COND_EN, k: symCmaiKey(r3.rule_id, mc) }),
          kind: "CMAI",
          pattern: PAT.CMAI_COND_EN,
          r3: r3.rule_id,
          mc,
          static_evidence: { relation: "c⇒C3", witness: en.witness },
        });
      }

      const dis = existsActionDisablesAnyCondition(pseudoFrom, r3, deviceIdx);
      if (dis.ok) {
        out.push({
          candidate_id: candId({ p: PAT.CMAI_COND_DIS, k: symCmaiKey(r3.rule_id, mc) }),
          kind: "CMAI",
          pattern: PAT.CMAI_COND_DIS,
          r3: r3.rule_id,
          mc,
          static_evidence: { relation: "c⇏C3", witness: dis.witness },
        });
      }

      // CMAI-ChainedExecution: c ↦ T3 (direct device-state OR semantic env, device-level)
      let chained = null;
      for (const t of getTerms(r3.trigger)) {
        const d = directActionSatisfiesEqTerm(action, t);
        if (d.ok) {
          chained = { action, trigger: t, mode: "direct", reason: d.reason };
          break;
        }
        const s = semanticActionTriggersEnvTerm(action, t, deviceIdx);
        if (s.ok) {
          chained = { action, trigger: t, mode: "semantic", reason: s.reason };
          break;
        }
      }
      if (chained) {
        out.push({
          candidate_id: candId({ p: PAT.CMAI_CHAIN, k: symCmaiKey(r3.rule_id, mc) }),
          kind: "CMAI",
          pattern: PAT.CMAI_CHAIN,
          r3: r3.rule_id,
          mc,
          static_evidence: { relation: "c↦T3", witness: chained },
        });
      }
    }
  }

  return dedupByKey(out, cmaiKey);
}

// -------------------- IO / validation / runner --------------------
function validateRulesJson(j) {
  if (!j || !Array.isArray(j.rules)) throw new Error("rules json must be {rules:[...]}");
  for (const r of j.rules) {
    if (!r.rule_id) throw new Error("rule missing rule_id");
    if (!Array.isArray(r.trigger)) throw new Error(`rule ${r.rule_id} missing trigger[]`);
    if (!Array.isArray(r.condition)) throw new Error(`rule ${r.rule_id} missing condition[]`);
    if (!Array.isArray(r.action)) throw new Error(`rule ${r.rule_id} missing action[]`);
  }
}

function validateDevicesJson(j) {
  if (!j || !Array.isArray(j.devices)) throw new Error("devices json must be {devices:[...]}");
  for (const d of j.devices) {
    if (!d.system_id) throw new Error("device missing system_id");
    // room can be missing, but semantic env influence will be blocked for unknown rooms
  }
}

function runTestbed(testbed, rulesPath, devicesPath, outPath) {
  // Screening is deterministic for the same inputs.
  // It is intentionally re-run before every evaluation replay to keep
  // candidate generation in sync with the active rules/devices JSON.
  const rulesJson = readJson(rulesPath);
  const devicesJson = readJson(devicesPath);
  validateRulesJson(rulesJson);
  validateDevicesJson(devicesJson);

  const deviceIdx = buildDeviceIndex(devicesJson);
  const rules = rulesJson.rules;

  const cai = screenCAI(rules, deviceIdx);
  const cmai = screenCMAI(rules, devicesJson, deviceIdx);

  const output = {
    testbed,
    input: {
      rules_path: path.resolve(rulesPath),
      devices_path: path.resolve(devicesPath),
      rule_count: rules.length,
      device_count: devicesJson.devices.length,
    },
    candidate_stats: {
      CAI: cai.length,
      CMAI: cmai.length,
      total: cai.length + cmai.length,
    },
    candidates: [...cai, ...cmai],
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");
  console.log(`[screen:${testbed}] wrote ${output.candidates.length} candidates -> ${outPath}`);
  console.log(`[screen:${testbed}] stats:`, output.candidate_stats);
}

function main() {
  const t1_rules = args.t1_rules || DEFAULTS.t1_rules;
  const t1_devices = args.t1_devices || DEFAULTS.t1_devices;
  const t1_out = args.t1_out || DEFAULTS.t1_out;

  const t2_rules = args.t2_rules || DEFAULTS.t2_rules;
  const t2_devices = args.t2_devices || DEFAULTS.t2_devices;
  const t2_out = args.t2_out || DEFAULTS.t2_out;

  runTestbed("T1", t1_rules, t1_devices, t1_out);
  runTestbed("T2", t2_rules, t2_devices, t2_out);
}

if (require.main === module) {
  main();
}

module.exports = {
  PAT,
  runTestbed,
  screenCAI,
  screenCMAI,
  buildDeviceIndex,
  inferManualControls,
};
