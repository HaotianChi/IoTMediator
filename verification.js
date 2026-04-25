
'use strict';

/**
 * Dynamic Verification (Section 4.2.2 + Appendix B) for IoTMediator patterns
 *
 * This module assumes:
 *  - All events & commands are hooked into stream_handler({kind, payload, next})
 *  - Candidate screening has produced a candidates JSON file:
 *      { testbed, candidates:[ {candidate_id, kind:"CAI|CMAI", pattern, ...}, ... ] }
 *  - Rules JSON:
 *      { rules:[ {rule_id, trigger:[], condition:[], action:[]}, ... ] }
 *
 * Implemented patterns:
 *   CAI (8):
 *     - CAI-ConditionEnabling
 *     - CAI-ConditionDisabling
 *     - CAI-RaceCondition
 *     - CAI-PotentialRaceCondition
 *     - CAI-ChainedExecution
 *     - CAI-ActionRevert
 *     - CAI-ConditionBypass
 *     - CAI-InfiniteLoop
 *   CMAI (4):
 *     - CMAI-ChainedExecution
 *     - CMAI-PotentialRaceCondition
 *     - CMAI-ConditionEnabling
 *     - CMAI-ConditionDisabling
 *
 * Verification model:
 *   - Per candidate (and per direction for symmetric patterns requiring both orders),
 *     maintain a finite-state session that progresses on incoming runtime stream.
 *   - Any assertion failure -> reset that session.
 *   - When a session completes -> emit a verified instance (currently logs; can be wired to DB/handler).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let db;
try {
    db = require('./messenger/core/db');
} catch (err) {
    db = {
        open: () => {},
        getEventTargetPlatform: async () => undefined,
        db: null,
    };
    console.warn(`[verification] db adapter unavailable, running in memory-only mode: ${err.message}`);
}
const config = require('./config/default');

const CANDIDATES_PATH = process.env.CANDIDATES_PATH
    || path.join(__dirname, 'evaluation', 'candidates_T1.json');
const RULES_PATH = process.env.RULES_PATH
    || path.join(__dirname, 'evaluation', 'testbed_T1_rules.json');

const RECENT_WINDOW_MS = Number(process.env.VERIFICATION_WINDOW_MS) || 30000;
const COMMAND_EVENT_WINDOW_MS = Number(process.env.COMMAND_EVENT_WINDOW_MS) || 5000;
const MAX_BUFFER_SIZE = Number(process.env.VERIFICATION_MAX_BUFFER) || 500;
const VERIFICATION_DEBUG = process.env.VERIFICATION_DEBUG === '1';
const MAX_ACTIVE_SESSIONS = Number(process.env.VERIFICATION_MAX_SESSIONS) || 5000;
const VERIFICATION_EVENT_BROADCAST_ALL = process.env.VERIFICATION_EVENT_BROADCAST_ALL === '1';

// Pattern names (must match candidates JSON)
const PATTERN = {
    CAI_COND_EN: 'CAI-ConditionEnabling',
    CAI_COND_DIS: 'CAI-ConditionDisabling',
    CAI_RC: 'CAI-RaceCondition',
    CAI_PRC: 'CAI-PotentialRaceCondition',
    CAI_CHAIN: 'CAI-ChainedExecution',
    CAI_REVERT: 'CAI-ActionRevert',
    CAI_BYPASS: 'CAI-ConditionBypass',
    CAI_LOOP: 'CAI-InfiniteLoop',

    CMAI_CHAIN: 'CMAI-ChainedExecution',
    CMAI_PRC: 'CMAI-PotentialRaceCondition',
    CMAI_COND_EN: 'CMAI-ConditionEnabling',
    CMAI_COND_DIS: 'CMAI-ConditionDisabling',
};

const ACTUATOR_ATTRS = new Set([
    ...(config.device_connector && config.device_connector.actuatable_item_categories ? config.device_connector.actuatable_item_categories : []),
    ...(config.cloud_device_connector && config.cloud_device_connector.actuatable_attributes ? config.cloud_device_connector.actuatable_attributes : []),
    'light',
    'heater',
    'microwave',
    'window',
    'oven',
    'camera',
    'lock',
]);

let rules = [];
let rulesById = new Map();
let deviceDomainByUid = new Map(); // uid -> domain inferred from rule actions
let candidates = [];
let caiByRule = new Map();
let cmaiByMcKey = new Map();

// Recent runtime context buffers
const recentEvents = [];
const recentCommands = [];

// Verification session store
// key -> { key, candidate_id, kind, pattern, r1,r2,r3, mc, dir, state, startTs, lastTs, holdPred, timeline }
const sessions = new Map();

function debugLog(...args) {
    if (VERIFICATION_DEBUG) console.log(...args);
}

function sha1(s) {
    return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function genInstanceId() {
    return 'inst_' + sha1(`${Date.now()}_${Math.random()}`).slice(0, 16);
}

function readJsonSafe(p) {
    try {
        const raw = fs.readFileSync(p, 'utf-8');
        return JSON.parse(raw);
    } catch (err) {
        console.warn(`[verification] failed to load ${p}: ${err.message}`);
        return null;
    }
}

// ---------------- DB helpers (patch) ----------------
// We use DB as a fallback source-of-truth when recentEvents cache is insufficient.
// db.js does not have platform-side rule execution logs. We optionally record inferred executions
// to a lightweight table for later analysis.
function ensureDbOpen() {
    try { if (db && typeof db.open === 'function') db.open(); } catch (_) {}
}

function dbAll(sql, params = []) {
    ensureDbOpen();
    return new Promise((resolve, reject) => {
        if (!db || !db.db) return resolve([]);
        db.db.all(sql, params, (err, rows) => {
            if (err) reject(err); else resolve(rows || []);
        });
    });
}
function dbGet(sql, params = []) {
    ensureDbOpen();
    return new Promise((resolve, reject) => {
        if (!db || !db.db) return resolve(undefined);
        db.db.get(sql, params, (err, row) => {
            if (err) reject(err); else resolve(row);
        });
    });
}

async function ensureRuleExecTable() {
    try {
        ensureDbOpen();
        if (!db || !db.db) return;
        await new Promise((resolve) => {
            db.db.run('CREATE TABLE IF NOT EXISTS RuleExecutions (' +
                'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
                'rule_id TEXT,' +
                'device_id TEXT,' +
                'attribute TEXT,' +
                'value TEXT,' +
                'timestamp TEXT,' +
                'locale_time TEXT,' +
                'confidence REAL,' +
                'notes TEXT' +
            ');', () => resolve());
        });
    } catch (_) {}
}

async function recordInferredRuleExec({ ruleId, cmdCtx, confidence, notes }) {
    try {
        await ensureRuleExecTable();
        if (!db || !db.db) return;
        const ts = new Date();
        const locale = ts.toLocaleString();
        await new Promise((resolve) => {
            db.db.run(
                'INSERT INTO RuleExecutions(rule_id, device_id, attribute, value, timestamp, locale_time, confidence, notes) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
                [ruleId, String(cmdCtx.deviceId || ''), String(cmdCtx.attribute || ''), String(cmdCtx.value || ''), ts.toISOString(), locale, confidence ?? null, notes ?? null],
                () => resolve()
            );
        });
    } catch (_) {}
}

// Get latest known value for (uid, attr), first from in-memory recentEvents, then from DB States, then from DB Events.
async function getLatestValue(uid, attr) {
    for (let i = recentEvents.length - 1; i >= 0; i--) {
        const e = recentEvents[i];
        if (String(e.deviceId) === String(uid) && String(e.attribute) === String(attr)) {
            return { value: e.value, ts: e.ts, source: 'memory' };
        }
    }
    try {
        const row = await dbGet('SELECT value FROM States WHERE device_id=? AND attribute=?', [String(uid), String(attr)]);
        if (row && row.value !== undefined) return { value: row.value, ts: null, source: 'db_states' };
    } catch (_) {}
    try {
        const rows = await dbAll('SELECT value, timestamp FROM Events WHERE device_id=? AND attribute=? ORDER BY timestamp DESC LIMIT 1',
            [String(uid), String(attr)]);
        if (rows && rows[0]) return { value: rows[0].value, ts: rows[0].timestamp ? Date.parse(rows[0].timestamp) : null, source: 'db_events' };
    } catch (_) {}
    return { value: undefined, ts: null, source: 'none' };
}


function stableStr(x) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return JSON.stringify(x);
    const keys = Object.keys(x).sort();
    const out = {};
    for (const k of keys) out[k] = x[k];
    return JSON.stringify(out);
}

function buildMcKey(mc) {
    if (!mc || !mc.uid || !mc.cmd) return null;
    const argsKey = mc.args ? stableStr(mc.args) : '';
    return `${String(mc.uid)}|${String(mc.cmd)}|${argsKey}`;
}

function loadRules() {
    const data = readJsonSafe(RULES_PATH);
    const list = data && Array.isArray(data.rules) ? data.rules : [];
    rules = list;
    rulesById = new Map();
    deviceDomainByUid = new Map();
    for (const r of rules) {
        if (r && r.rule_id) {
            rulesById.set(r.rule_id, r);
        }
        for (const a of Array.isArray(r.action) ? r.action : []) {
            if (!a || !a.uid || typeof a.cmd !== 'string') continue;
            const parts = a.cmd.split('.');
            if (parts.length !== 2) continue;
            const domain = parts[0];
            if (!deviceDomainByUid.has(String(a.uid))) {
                deviceDomainByUid.set(String(a.uid), domain);
            }
        }
    }
}

function loadCandidates() {
    const data = readJsonSafe(CANDIDATES_PATH);
    const list = data && Array.isArray(data.candidates) ? data.candidates : [];
    candidates = list;
    caiByRule = new Map();
    cmaiByMcKey = new Map();
    for (const c of list) {
        if (!c || !c.kind) continue;
        if (c.kind === 'CAI') {
            if (c.r1) {
                const arr = caiByRule.get(c.r1) || [];
                arr.push(c);
                caiByRule.set(c.r1, arr);
            }
            if (c.r2) {
                const arr = caiByRule.get(c.r2) || [];
                arr.push(c);
                caiByRule.set(c.r2, arr);
            }
        } else if (c.kind === 'CMAI') {
            const k = buildMcKey(c.mc);
            if (k) {
                const arr = cmaiByMcKey.get(k) || [];
                arr.push(c);
                cmaiByMcKey.set(k, arr);
            }
        }
    }
}

function initVerificationData() {
    ensureDbOpen();
    ensureRuleExecTable().catch(()=>{});
    loadRules();
    loadCandidates();
}

initVerificationData();

function pruneBuffer(buf, windowMs) {
    const cutoff = Date.now() - windowMs;
    while (buf.length > 0 && buf[0].ts < cutoff) {
        buf.shift();
    }
    if (buf.length > MAX_BUFFER_SIZE) {
        buf.splice(0, buf.length - MAX_BUFFER_SIZE);
    }
}

function recordEvent(evt) {
    // attach prevValue for condition-flip detection
    let prevValue;
    for (let i = recentEvents.length - 1; i >= 0; i--) {
        const e = recentEvents[i];
        if (String(e.deviceId) === String(evt.deviceId) && String(e.attribute) === String(evt.attribute)) {
            prevValue = e.value;
            break;
        }
    }
    const enriched = { ...evt, prevValue };
    recentEvents.push(enriched);
    pruneBuffer(recentEvents, RECENT_WINDOW_MS);
    return enriched;
}

function recordCommand(cmd) {
    recentCommands.push(cmd);
    pruneBuffer(recentCommands, RECENT_WINDOW_MS);
}

function findRecentCommandForEvent(event) {
    pruneBuffer(recentCommands, COMMAND_EVENT_WINDOW_MS);
    for (let i = recentCommands.length - 1; i >= 0; i--) {
        const c = recentCommands[i];
        if (String(c.deviceId) === String(event.deviceId) &&
            String(c.attribute) === String(event.attribute)) {
            return c;
        }
    }
    return null;
}

function normalizeCommandValue(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value.toLowerCase();
    return String(value);
}

// Convert (deviceId, attribute, value) into rule cmd, using inferred domain map
function toRuleCmd(deviceId, attribute, value) {
    if (!attribute) return null;
    if (attribute === 'home_mode' && value !== undefined) {
        return 'mode.set';
    }
    const domain = deviceDomainByUid.get(String(deviceId)) || attribute;
    const verb = normalizeCommandValue(value);
    if (!verb) return null;
    return `${domain}.${verb}`;
}

function normalizeCommandPayload(payload) {
    const deviceId = payload && payload.device ? payload.device.uid : undefined;
    const attribute = payload ? payload.attribute : undefined;
    const value = payload ? payload.value : undefined;
    const cmd = toRuleCmd(deviceId, attribute, value);
    const args = (attribute === 'home_mode' && value !== undefined) ? { mode: String(value) } : undefined;
    return {
        deviceId,
        attribute,
        value,
        cmd,
        args,
        platform: payload ? payload.platform : undefined,
    };
}

function normalizeEventPayload(payload) {
    return {
        deviceId: payload && payload.device ? payload.device.uid : undefined,
        attribute: payload ? payload.attribute : undefined,
        value: payload ? payload.value : undefined,
    };
}

// ----- Matching helpers -----

function actionMatchesCommand(action, cmdCtx) {
    if (!action || !cmdCtx) return false;
    if (String(action.uid) !== String(cmdCtx.deviceId)) return false;
    if (!action.cmd || !cmdCtx.cmd) return false;
    if (action.cmd !== cmdCtx.cmd) return false;
    if (action.cmd === 'mode.set') {
        const want = action.args && action.args.mode;
        const got = cmdCtx.args && cmdCtx.args.mode;
        if (want && got) return String(want) === String(got);
    }
    return true;
}

function candActionMatchesCommand(actionSpec, cmdCtx) {
    // actionSpec shape: {uid, cmd, args?}
    if (!actionSpec || !cmdCtx) return false;
    const a = { uid: actionSpec.uid, cmd: actionSpec.cmd, args: actionSpec.args };
    return actionMatchesCommand(a, cmdCtx);
}


function findRulesForCommand(cmdCtx) {
    const matched = [];
    for (const r of rules) {
        for (const a of Array.isArray(r.action) ? r.action : []) {
            if (actionMatchesCommand(a, cmdCtx)) {
                matched.push(r);
                break;
            }
        }
    }
    return matched;
}

function getLatestEventValue(uid, attr) {
    for (let i = recentEvents.length - 1; i >= 0; i--) {
        const e = recentEvents[i];
        if (String(e.deviceId) === String(uid) && String(e.attribute) === String(attr)) {
            return e.value;
        }
    }
    return undefined;
}

function getLatestEventValueWithOverride(uid, attr, override) {
    // override: {uid, attr, val}
    if (override && String(override.uid) === String(uid) && String(override.attr) === String(attr)) {
        return override.val;
    }
    return getLatestEventValue(uid, attr);
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
        const ap = m[3];
        if (ap === 'pm') h += 12;
        if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) return h * 60 + mm;
    }
    return null;
}

function minutesNow() {
    const d = new Date(Date.now());
    return d.getHours() * 60 + d.getMinutes();
}

function currentTimeHHMM() {
    const mins = minutesNow();
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
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

function betweenCheck(value, range, asTime) {
    if (!Array.isArray(range) || range.length < 2) return false;
    if (asTime) {
        const v = parseTimeToMinutes(value);
        const lo = parseTimeToMinutes(range[0]);
        const hi = parseTimeToMinutes(range[1]);
        if (v === null || lo === null || hi === null) return false;
        // Support wrap-around windows such as [23:00, 06:00].
        if (lo <= hi) return v >= lo && v <= hi;
        return v >= lo || v <= hi;
    }
    const v = Number(value);
    const lo = Number(range[0]);
    const hi = Number(range[1]);
    if (!Number.isFinite(v) || !Number.isFinite(lo) || !Number.isFinite(hi)) return false;
    return v >= Math.min(lo, hi) && v <= Math.max(lo, hi);
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

function compareTermValue(term, value) {
    const t = normalizeTerm(term);
    if (!t || !t.op) return false;
    if (t.op === 'between') return betweenCheck(value, t.val, isTimeTerm(t));

    if (isTimeTerm(t)) {
        const lv = parseTimeToMinutes(value);
        const rv = parseTimeToMinutes(t.val);
        if (lv === null || rv === null) return false;
        if (t.op === '==') return lv === rv;
        if (t.op === '!=') return lv !== rv;
        if (t.op === '>') return lv > rv;
        if (t.op === '>=') return lv >= rv;
        if (t.op === '<') return lv < rv;
        if (t.op === '<=') return lv <= rv;
        return false;
    }

    return compareValues(t.op, value, t.val);
}

function getRuleLogic(rule, scope /* 'trigger' | 'condition' */) {
    // Most rules use AND, but some cases use OR semantics.
    // We support both top-level and metadata-carried logic annotations.
    const direct = rule ? rule[`${scope}_logic`] : undefined;
    const legacy = (scope === 'condition')
        ? (rule ? rule.condition_logic : undefined)
        : (rule ? rule.trigger_logic : undefined);
    const meta = rule && rule.metadata
        ? (rule.metadata[`${scope}_logic`] || (scope === 'condition' ? rule.metadata.condition_logic : rule.metadata.trigger_logic))
        : undefined;
    const logic = String(direct || legacy || meta || 'AND').toUpperCase();
    return logic === 'OR' ? 'OR' : 'AND';
}

function termSatisfied(term, override) {
    const t = normalizeTerm(term);
    if (!t || !t.uid || !t.attr || !t.op) return { ok: false, reason: 'unsupported_term' };

    if (isTimeTerm(t)) {
        // Time terms can be driven either by injected GLOBAL.time events
        // (preferred for replay reproducibility) or by the virtual/system clock.
        if (override && String(override.uid) === String(t.uid) && String(override.attr) === String(t.attr)) {
            return { ok: compareTermValue(t, override.val), reason: 'override' };
        }
        const latest = getLatestEventValue(t.uid, t.attr);
        if (latest !== undefined) return { ok: compareTermValue(t, latest), reason: 'event_context' };
        const timeVal = currentTimeHHMM();
        return { ok: compareTermValue(t, timeVal), reason: 'clock' };
    }

    const latest = getLatestEventValueWithOverride(t.uid, t.attr, override);
    if (latest === undefined) return { ok: false, reason: 'no_recent_event' };
    return { ok: compareTermValue(t, latest), reason: 'event_context' };
}

function evalTermsByLogic(terms, override, logic) {
    const list = Array.isArray(terms) ? terms : [];
    if (list.length === 0) return { ok: true };
    if (logic === 'OR') {
        let lastReason = 'no_term_satisfied';
        for (const t of list) {
            const res = termSatisfied(t, override);
            if (res.ok) return { ok: true };
            lastReason = res.reason;
        }
        return { ok: false, reason: lastReason };
    }
    for (const t of list) {
        const res = termSatisfied(t, override);
        if (!res.ok) return { ok: false, reason: res.reason };
    }
    return { ok: true };
}

function evalTrigger(rule, override) {
    return evalTermsByLogic(rule && rule.trigger, override, getRuleLogic(rule, 'trigger'));
}

function evalCondition(rule, override) {
    return evalTermsByLogic(rule && rule.condition, override, getRuleLogic(rule, 'condition'));
}

// Event matches a term (as obsE(E(term)))
function eventMatchesTerm(evt, term) {
    const t = normalizeTerm(term);
    if (!evt || !t) return false;
    if (String(evt.deviceId) !== String(t.uid)) return false;
    if (String(evt.attribute) !== String(t.attr)) return false;
    return compareTermValue(t, evt.value);
}

// obsE(T): observe an event that contributes to trigger, and trigger becomes satisfied
function obsE_trigger(rule, evt) {
    if (!rule || !evt) return { ok: false };
    const terms = Array.isArray(rule.trigger) ? rule.trigger : [];
    const anyMatch = terms.some(t => eventMatchesTerm(evt, t));
    if (!anyMatch) return { ok: false };
    // Evaluate trigger with current event override so that event-driven
    // time terms (GLOBAL.time) and same-attribute updates are handled correctly.
    const trig = evalTrigger(rule, { uid: evt.deviceId, attr: evt.attribute, val: evt.value });
    return trig.ok ? { ok: true, witness: { evt } } : { ok: false };
}

// obsE(C): observe event making condition become true (flip false->true)
function obsE_conditionBecameTrue(rule, evt) {
    if (!rule || !evt) return { ok: false };
    const override = (evt.prevValue !== undefined)
        ? { uid: evt.deviceId, attr: evt.attribute, val: evt.prevValue }
        : null;
    const before = evalCondition(rule, override).ok;
    const after = evalCondition(rule).ok;
    if (!before && after) return { ok: true, witness: { evt, before, after } };
    return { ok: false };
}

// obsE(¬C): observe event making condition become false (flip true->false)
function obsE_conditionBecameFalse(rule, evt) {
    if (!rule || !evt) return { ok: false };
    const override = (evt.prevValue !== undefined)
        ? { uid: evt.deviceId, attr: evt.attribute, val: evt.prevValue }
        : null;
    const before = evalCondition(rule, override).ok;
    const after = evalCondition(rule).ok;
    if (before && !after) return { ok: true, witness: { evt, before, after } };
    return { ok: false };
}

// matchS(¬T): trigger false
function matchNotTrigger(rule) {
    const trig = evalTrigger(rule);
    return { ok: !trig.ok };
}

// Build expected state predicate for matchS(A) / matchS(c)
function expectedStatePredFromCmdLike(cmdLike) {
    // Patch: rely on semantic domains in cmdLike.cmd (light/heater/window/...) rather than guessing raw platform attributes.
    if (!cmdLike || !cmdLike.uid || !cmdLike.cmd) return null;
    const parts = String(cmdLike.cmd).split('.');
    if (parts.length !== 2) return null;
    const domain = parts[0];
    const verb = parts[1];

    const domainToAttr = {
        light: 'light',
        heater: 'heater',
        window: 'window',
        microwave: 'microwave',
        oven: 'oven',
        mode: 'home_mode',
    };
    const attr = domainToAttr[domain] || cmdLike.attribute || domain;

    const okVerbs = new Set(['on', 'off', 'open', 'close', 'opened', 'closed', 'lock', 'unlock', 'locked', 'unlocked', 'home', 'away', 'saving', 'party', 'set']);
    if (!okVerbs.has(String(verb))) {
        return null;
    }

    let expectedVal = verb;
    if (cmdLike.cmd === 'mode.set' && cmdLike.args && cmdLike.args.mode) expectedVal = String(cmdLike.args.mode).toLowerCase();

    return { uid: cmdLike.uid, attr, op: '==', val: expectedVal };
}

// Does an incoming event correspond to a state-change of a command/action?
function obsE_ofActionLike(actionLike, evt) {
    if (!actionLike || !evt) return { ok: false };
    const wantUid = String(actionLike.uid);
    if (String(evt.deviceId) !== wantUid) return { ok: false };

    // Map event to cmd using deviceDomainByUid or attribute itself
    const inferredCmd = toRuleCmd(evt.deviceId, evt.attribute, evt.value);
    if (!inferredCmd) return { ok: false };

    // For mode.set, inferredCmd is mode.set; compare args
    if (actionLike.cmd === 'mode.set' && inferredCmd === 'mode.set') {
        const want = actionLike.args && actionLike.args.mode;
        const got = String(evt.value);
        if (want && got) return (String(want) === String(got)) ? { ok: true, witness: { evt } } : { ok: false };
    }

    return (String(actionLike.cmd) === String(inferredCmd)) ? { ok: true, witness: { evt } } : { ok: false };
}

// XOR helper
function xor(a, b) { return (!!a) !== (!!b); }

// ----- Source inference for command -----

function ruleContextSatisfied(rule) {
    const tRes = evalTrigger(rule);
    if (!tRes.ok) return { ok: false, reason: tRes.reason };
    const cRes = evalCondition(rule);
    if (!cRes.ok) return { ok: false, reason: cRes.reason };
    return { ok: true };
}

async function termSatisfiedAsync(term) {
    const t = normalizeTerm(term);
    if (!t || !t.uid || !t.attr || !t.op) return { ok: false, reason: 'unsupported_term' };

    if (isTimeTerm(t)) {
        const timeVal = currentTimeHHMM();
        return { ok: compareTermValue(t, timeVal), reason: 'clock' };
    }

    const latest = await getLatestValue(t.uid, t.attr);
    if (latest.value === undefined) return { ok: false, reason: 'no_value' };
    return { ok: compareTermValue(t, latest.value), reason: latest.source };
}

async function evalTermsByLogicAsync(terms, logic) {
    const list = Array.isArray(terms) ? terms : [];
    if (list.length === 0) return { ok: true };
    if (logic === 'OR') {
        let lastReason = 'no_term_satisfied';
        for (const t of list) {
            const res = await termSatisfiedAsync(t);
            if (res.ok) return { ok: true };
            lastReason = res.reason;
        }
        return { ok: false, reason: lastReason };
    }
    for (const t of list) {
        const res = await termSatisfiedAsync(t);
        if (!res.ok) return { ok: false, reason: res.reason };
    }
    return { ok: true };
}

async function ruleContextSatisfiedAsync(rule) {
    const triggers = Array.isArray(rule.trigger) ? rule.trigger : [];
    const conditions = Array.isArray(rule.condition) ? rule.condition : [];
    const trigRes = await evalTermsByLogicAsync(triggers, getRuleLogic(rule, 'trigger'));
    if (!trigRes.ok) return { ok: false, reason: trigRes.reason };
    const condRes = await evalTermsByLogicAsync(conditions, getRuleLogic(rule, 'condition'));
    if (!condRes.ok) return { ok: false, reason: condRes.reason };
    return { ok: true };
}

async function latestTriggerTimestamp(rule, windowMs) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const triggers = Array.isArray(rule.trigger) ? rule.trigger : [];
    if (triggers.length === 0) return null;

    const logic = getRuleLogic(rule, 'trigger');
    const termLatest = [];
    for (const rawTerm of triggers) {
        const t = normalizeTerm(rawTerm);
        if (!t || !t.uid || !t.attr || !t.op) return null;

        if (isTimeTerm(t)) {
            termLatest.push(compareTermValue(t, currentTimeHHMM()) ? now : null);
            continue;
        }

        let rows = [];
        try {
            rows = await dbAll(
                'SELECT value, timestamp FROM Events WHERE device_id=? AND attribute=? ORDER BY timestamp DESC LIMIT 50',
                [String(t.uid), String(t.attr)]
            );
        } catch (_) { rows = []; }
        let best = null;
        for (const row of rows) {
            const ts = row.timestamp ? Date.parse(row.timestamp) : null;
            if (ts && ts < cutoff) break;
            if (ts && compareTermValue(t, row.value)) {
                best = ts;
                break;
            }
        }
        termLatest.push(best);
    }
    if (logic === 'OR') {
        const okTs = termLatest.filter(x => Number.isFinite(x));
        if (okTs.length === 0) return null;
        return okTs.reduce((a, b) => Math.max(a, b), okTs[0]);
    }
    if (termLatest.some(x => !Number.isFinite(x))) return null;
    return termLatest.reduce((a, b) => Math.max(a, b), termLatest[0]);
}

async function inferCommandSource(cmdCtx) {
    const rulesForCmd = findRulesForCommand(cmdCtx);
    if (rulesForCmd.length === 0) {
        return { source: 'mc_remote', reason: 'no_action_match' };
    }

    const satisfiedFast = [];
    for (const r of rulesForCmd) {
        const ctx = ruleContextSatisfied(r);
        if (ctx.ok) satisfiedFast.push(r);
    }
    if (satisfiedFast.length === 1) {
        await recordInferredRuleExec({ ruleId: satisfiedFast[0].rule_id, cmdCtx, confidence: 0.70, notes: 'fastpath_memory' });
        return { source: 'rule', ruleId: satisfiedFast[0].rule_id };
    }
    if (satisfiedFast.length > 1) {
        await recordInferredRuleExec({ ruleId: satisfiedFast[0].rule_id, cmdCtx, confidence: 0.50, notes: 'fastpath_memory_ambiguous' });
        return { source: 'rule', ruleId: satisfiedFast[0].rule_id, ambiguous: true, candidates: satisfiedFast.map(r => r.rule_id) };
    }

    const windowMs = Number(process.env.RULE_BACKTRACE_WINDOW_MS) || 60000;
    const satisfiedDb = [];
    for (const r of rulesForCmd) {
        const ctx = await ruleContextSatisfiedAsync(r);
        if (ctx.ok) satisfiedDb.push(r);
    }
    if (satisfiedDb.length === 1) {
        await recordInferredRuleExec({ ruleId: satisfiedDb[0].rule_id, cmdCtx, confidence: 0.80, notes: 'fallback_db_context' });
        return { source: 'rule', ruleId: satisfiedDb[0].rule_id, inferred: true };
    }
    if (satisfiedDb.length > 1) {
        let bestRule = satisfiedDb[0];
        let bestTs = null;
        for (const r of satisfiedDb) {
            const ts = await latestTriggerTimestamp(r, windowMs);
            if (ts && (!bestTs || ts > bestTs)) {
                bestTs = ts; bestRule = r;
            }
        }
        await recordInferredRuleExec({ ruleId: bestRule.rule_id, cmdCtx, confidence: 0.60, notes: 'fallback_db_latest_trigger' });
        return { source: 'rule', ruleId: bestRule.rule_id, ambiguous: true, inferred: true, candidates: satisfiedDb.map(r => r.rule_id), chosen_by: 'latest_trigger_ts' };
    }

    return { source: 'mc_remote', reason: 'context_not_matched' };
}



function buildMcFromCommand(cmdCtx) {
    if (!cmdCtx || !cmdCtx.deviceId) return null;
    const cmd = cmdCtx.cmd || (cmdCtx.attribute ? `${cmdCtx.attribute}.${normalizeCommandValue(cmdCtx.value)}` : null);
    return { uid: cmdCtx.deviceId, cmd, args: cmdCtx.args };
}

function buildMcFromEvent(evtCtx) {
    if (!evtCtx || !evtCtx.deviceId) return null;
    const cmd = evtCtx.attribute ? `${evtCtx.attribute}.${normalizeCommandValue(evtCtx.value)}` : null;
    return { uid: evtCtx.deviceId, cmd };
}

// ----- Candidate lookup -----

function dedupCandidates(list) {
    const seen = new Set();
    const out = [];
    for (const c of list) {
        const key = c && c.candidate_id ? c.candidate_id : JSON.stringify(c);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
    }
    return out;
}

function findCandidatesForOrigin(origin) {
    if (!origin || !origin.source) return [];
    if (origin.source === 'rule') {
        const list = caiByRule.get(origin.ruleId) || [];
        return dedupCandidates(list);
    }
    if (origin.source === 'mc_remote' || origin.source === 'mc_physical') {
        const key = buildMcKey(origin.mc);
        if (!key) return [];
        const list = cmaiByMcKey.get(key) || [];
        return dedupCandidates(list);
    }
    return [];
}

// ----- Session management -----

function sessionKeyForCandidate(cand, dir) {
    // dir is used for symmetric patterns needing both orders; else null
    return dir ? `${cand.candidate_id}#${dir}` : `${cand.candidate_id}`;
}

function resetSession(key) {
    sessions.delete(key);
}

function getOrCreateSession(cand, dir) {
    const key = sessionKeyForCandidate(cand, dir);
    const now = Date.now();
    let s = sessions.get(key);
    if (!s) {
        if (sessions.size > MAX_ACTIVE_SESSIONS) {
            // Best-effort prune oldest
            let oldestKey = null;
            let oldestTs = Infinity;
            for (const [k, v] of sessions.entries()) {
                if (v && v.startTs < oldestTs) { oldestTs = v.startTs; oldestKey = k; }
            }
            if (oldestKey) sessions.delete(oldestKey);
        }
        s = {
            key,
            candidate_id: cand.candidate_id,
            kind: cand.kind,
            pattern: cand.pattern,
            r1: cand.r1,
            r2: cand.r2,
            r3: cand.r3,
            mc: cand.mc,
            dir: dir || null,
            state: 0,
            startTs: now,
            lastTs: now,
            holdPred: null,   // function returning boolean, checked on each stream item
            timeline: [],
        };
        sessions.set(key, s);
    }
    s.lastTs = now;
    return s;
}

function pruneSessions() {
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    for (const [k, s] of sessions.entries()) {
        if (!s || s.startTs < cutoff || s.lastTs < cutoff) sessions.delete(k);
    }
}

// Emit verified instance (can be wired to DB / threat handling module)
function emitVerifiedInstance(cand, session, timelineExtra) {
    const instance = {
        instance_id: genInstanceId(),
        kind: cand.kind,
        pattern: cand.pattern,
        candidate_id: cand.candidate_id,
        rules: cand.kind === 'CAI' ? [cand.r1, cand.r2] : [cand.r3],
        manual_control: cand.kind === 'CMAI' ? cand.mc : null,
        dir: session && session.dir ? session.dir : null,
        start_ts: session ? session.startTs : Date.now(),
        end_ts: Date.now(),
        timeline: (session ? session.timeline : []).concat(timelineExtra || []),
    };
    console.log('[verification] VERIFIED:', JSON.stringify(instance, null, 2));
    return instance;
}

// Check hold predicate if exists; if fails, reset session
function enforceHoldOrReset(session, cand) {
    if (!session || !session.holdPred) return true;
    try {
        const ok = !!session.holdPred();
        if (!ok) {
            debugLog(`[verification] hold predicate failed -> reset session ${session.key}`);
            resetSession(session.key);
            return false;
        }
        return true;
    } catch (e) {
        resetSession(session.key);
        return false;
    }
}

// Append to timeline
function tl(session, assertion, matched) {
    session.timeline.push({
        step: session.state,
        assertion,
        matched: matched || null,
        ts: Date.now(),
    });
}

// ----- Pattern verifiers (per stream item) -----

function verifyCAI_ChainedOrRevert(cand, session, ctx) {
    const r1 = rulesById.get(cand.r1);
    const r2 = rulesById.get(cand.r2);
    if (!r1 || !r2) return { progressed: false };

    // Steps (Section 4.2.2):
    // 0 obsE(T1)
    // 1 matchS(C1)
    // 2 obsC(A1)
    // 3 matchS(¬T2)
    // 4 obsE(T2)
    // 5 matchS(C2) -> verified

    if (session.state === 0) {
        if (ctx.kind === 'event') {
            const res = obsE_trigger(r1, ctx.event);
            if (res.ok) {
                tl(session, 'obsE(T1)', res.witness);
                session.state = 1;
            }
        }
        return { progressed: true };
    }

    if (session.state === 1) {
        const c1 = evalCondition(r1);
        if (c1.ok) {
            tl(session, 'matchS(C1)', { ok: true });
            session.state = 2;
        } else {
            resetSession(session.key);
        }
        return { progressed: true };
    }

    if (session.state === 2) {
        if (ctx.kind === 'command' && ctx.origin && ctx.origin.source === 'rule' && ctx.origin.ruleId === cand.r1) {
            // obsC(A1): observe any action command of R1
            tl(session, 'obsC(A1)', { command: ctx.command, rule: cand.r1 });
            session.state = 3;
        }
        return { progressed: true };
    }

    if (session.state === 3) {
        const nt2 = matchNotTrigger(r2);
        if (nt2.ok) {
            tl(session, 'matchS(¬T2)', { ok: true });
            session.state = 4;
        } else {
            resetSession(session.key);
        }
        return { progressed: true };
    }

    if (session.state === 4) {
        if (ctx.kind === 'event') {
            const res = obsE_trigger(r2, ctx.event);
            if (res.ok) {
                tl(session, 'obsE(T2)', res.witness);
                session.state = 5;
            }
        }
        return { progressed: true };
    }

    if (session.state === 5) {
        const c2 = evalCondition(r2);
        if (c2.ok) {
            tl(session, 'matchS(C2)', { ok: true });
            const inst = emitVerifiedInstance(cand, session);
            resetSession(session.key);
            return { progressed: true, verified: inst };
        }
        resetSession(session.key);
        return { progressed: true };
    }

    return { progressed: false };
}

function verifyCAI_CondEnableDisable(cand, session, ctx, mode /*'enable'|'disable'*/) {
    const r1 = rulesById.get(cand.r1);
    const r2 = rulesById.get(cand.r2);
    if (!r1 || !r2) return { progressed: false };

    // Appendix B:
    // Disabling:
    // obsE(T1), matchS(C1),
    // obsC(A1), matchS(C2),
    // obsE(¬C2) matchS(¬C2) ----> (remains false),
    // obsE(T2)
    //
    // Enabling:
    // obsE(T1), matchS(C1),
    // obsC(A1), matchS(¬C2),
    // obsE(C2) matchS(C2) ----> (remains true),
    // obsE(T2)

    const wantBeforeC2 = (mode === 'disable') ? true : false;
    const flipTo = (mode === 'disable') ? 'false' : 'true';

    if (session.state === 0) {
        if (ctx.kind === 'event') {
            const res = obsE_trigger(r1, ctx.event);
            if (res.ok) { tl(session, 'obsE(T1)', res.witness); session.state = 1; }
        }
        return { progressed: true };
    }

    if (session.state === 1) {
        const c1 = evalCondition(r1);
        if (c1.ok) { tl(session, 'matchS(C1)', { ok: true }); session.state = 2; }
        else resetSession(session.key);
        return { progressed: true };
    }

    if (session.state === 2) {
        if (ctx.kind === 'command' && ctx.origin && ctx.origin.source === 'rule' && ctx.origin.ruleId === cand.r1) {
            // obsC(A1)
            tl(session, 'obsC(A1)', { command: ctx.command, rule: cand.r1 });

            const c2 = evalCondition(r2).ok;
            const ok = (wantBeforeC2 ? c2 : !c2);
            if (!ok) { resetSession(session.key); return { progressed: true }; }
            tl(session, wantBeforeC2 ? 'matchS(C2)' : 'matchS(¬C2)', { ok: true });

            session.state = 3;
        }
        return { progressed: true };
    }

    if (session.state === 3) {
        if (ctx.kind === 'event') {
            const flipRes = (flipTo === 'false') ? obsE_conditionBecameFalse(r2, ctx.event) : obsE_conditionBecameTrue(r2, ctx.event);
            if (flipRes.ok) {
                tl(session, flipTo === 'false' ? 'obsE(¬C2)' : 'obsE(C2)', flipRes.witness);

                // start hold: condition remains false/true until T2
                session.holdPred = () => {
                    const cur = evalCondition(r2).ok;
                    return (flipTo === 'false') ? (!cur) : (!!cur);
                };
                tl(session, `matchS(${flipTo === 'false' ? '¬C2' : 'C2'})---->`, { start: true });

                session.state = 4;
            }
        }
        return { progressed: true };
    }

    if (session.state === 4) {
        // enforce hold each tick
        if (!enforceHoldOrReset(session, cand)) return { progressed: true };

        if (ctx.kind === 'event') {
            const res = obsE_trigger(r2, ctx.event);
            if (res.ok) {
                tl(session, 'obsE(T2)', res.witness);
                const inst = emitVerifiedInstance(cand, session);
                resetSession(session.key);
                return { progressed: true, verified: inst };
            }
        }
        return { progressed: true };
    }

    return { progressed: false };
}

function verifyCAI_RaceCondition(cand, session, ctx) {
    const r1 = rulesById.get(cand.r1);
    const r2 = rulesById.get(cand.r2);
    if (!r1 || !r2) return { progressed: false };

    // Appendix B:
    // obsE(T1), matchS(C1), matchS(C2)

    if (session.state === 0) {
        if (ctx.kind === 'event') {
            const e1 = obsE_trigger(r1, ctx.event);
            const e2 = obsE_trigger(r2, ctx.event);
            if (e1.ok && e2.ok) {
                tl(session, 'obsE(T1)', { evt: ctx.event });
                session.state = 1;
            }
        }
        return { progressed: true };
    }

    if (session.state === 1) {
        const c1 = evalCondition(r1).ok;
        const c2 = evalCondition(r2).ok;
        if (c1 && c2) {
            tl(session, 'matchS(C1),matchS(C2)', { c1: true, c2: true });
            const inst = emitVerifiedInstance(cand, session);
            resetSession(session.key);
            return { progressed: true, verified: inst };
        }
        resetSession(session.key);
        return { progressed: true };
    }

    return { progressed: false };
}

function verifyCAI_ConditionBypass(cand, session, ctx) {
    const r1 = rulesById.get(cand.r1);
    const r2 = rulesById.get(cand.r2);
    if (!r1 || !r2) return { progressed: false };

    // Appendix B:
    // obsE(T1), matchS(C1) XOR matchS(C2) = true

    if (session.state === 0) {
        if (ctx.kind === 'event') {
            const e1 = obsE_trigger(r1, ctx.event);
            const e2 = obsE_trigger(r2, ctx.event);
            if (e1.ok && e2.ok) {
                tl(session, 'obsE(T1)', { evt: ctx.event });
                session.state = 1;
            }
        }
        return { progressed: true };
    }

    if (session.state === 1) {
        const c1 = evalCondition(r1).ok;
        const c2 = evalCondition(r2).ok;
        if (xor(c1, c2)) {
            tl(session, 'matchS(C1)⊕matchS(C2)=true', { c1, c2 });
            const inst = emitVerifiedInstance(cand, session);
            resetSession(session.key);
            return { progressed: true, verified: inst };
        }
        resetSession(session.key);
        return { progressed: true };
    }

    return { progressed: false };
}

function verifyCAI_InfiniteLoop(cand, session, ctx, startFrom /*'r1'|'r2'*/) {
    const r1 = rulesById.get(cand.r1);
    const r2 = rulesById.get(cand.r2);
    if (!r1 || !r2) return { progressed: false };

    // Appendix B (starting from R1; R2 symmetric):
    // obsE(T1), matchS(C1), obsC(A1),
    // matchS(¬T2),
    // obsE(T2), matchS(C2), obsC(A2),
    // matchS(¬T1),
    // obsE(T1), matchS(C1)

    const first = (startFrom === 'r1') ? r1 : r2;
    const second = (startFrom === 'r1') ? r2 : r1;
    const firstId = (startFrom === 'r1') ? cand.r1 : cand.r2;
    const secondId = (startFrom === 'r1') ? cand.r2 : cand.r1;

    if (session.state === 0) {
        if (ctx.kind === 'event') {
            const res = obsE_trigger(first, ctx.event);
            if (res.ok) { tl(session, 'obsE(T1)', res.witness); session.state = 1; }
        }
        return { progressed: true };
    }

    if (session.state === 1) {
        if (evalCondition(first).ok) { tl(session, 'matchS(C1)', { ok: true }); session.state = 2; }
        else resetSession(session.key);
        return { progressed: true };
    }

    if (session.state === 2) {
        if (ctx.kind === 'command' && ctx.origin && ctx.origin.source === 'rule' && ctx.origin.ruleId === firstId) {
            tl(session, 'obsC(A1)', { command: ctx.command, rule: firstId });
            session.state = 3;
        }
        return { progressed: true };
    }

    if (session.state === 3) {
        const nt = matchNotTrigger(second);
        if (nt.ok) { tl(session, 'matchS(¬T2)', { ok: true }); session.state = 4; }
        else resetSession(session.key);
        return { progressed: true };
    }

    if (session.state === 4) {
        if (ctx.kind === 'event') {
            const res = obsE_trigger(second, ctx.event);
            if (res.ok) { tl(session, 'obsE(T2)', res.witness); session.state = 5; }
        }
        return { progressed: true };
    }

    if (session.state === 5) {
        if (evalCondition(second).ok) { tl(session, 'matchS(C2)', { ok: true }); session.state = 6; }
        else { resetSession(session.key); }
        return { progressed: true };
    }

    if (session.state === 6) {
        if (ctx.kind === 'command' && ctx.origin && ctx.origin.source === 'rule' && ctx.origin.ruleId === secondId) {
            tl(session, 'obsC(A2)', { command: ctx.command, rule: secondId });
            session.state = 7;
        }
        return { progressed: true };
    }

    if (session.state === 7) {
        const nt = matchNotTrigger(first);
        if (nt.ok) { tl(session, 'matchS(¬T1)', { ok: true }); session.state = 8; }
        else resetSession(session.key);
        return { progressed: true };
    }

    if (session.state === 8) {
        if (ctx.kind === 'event') {
            const res = obsE_trigger(first, ctx.event);
            if (res.ok) { tl(session, 'obsE(T1)', res.witness); session.state = 9; }
        }
        return { progressed: true };
    }

    if (session.state === 9) {
        if (evalCondition(first).ok) {
            tl(session, 'matchS(C1)', { ok: true });
            const inst = emitVerifiedInstance(cand, session);
            resetSession(session.key);
            return { progressed: true, verified: inst };
        }
        resetSession(session.key);
        return { progressed: true };
    }

    return { progressed: false };
}

function verifyCAI_PotentialRaceCondition(cand, session, ctx, order /*'r1_first'|'r2_first'*/) {
    const r1 = rulesById.get(cand.r1);
    const r2 = rulesById.get(cand.r2);
    if (!r1 || !r2) return { progressed: false };

    // Section 4.2.2:
    // Path (R1 before R2):
    // obsE(T1), matchS(C1), obsC(A1),
    // obsE(A1) matchS(A1) ----> ,
    // obsE(T2), matchS(C2)
    //
    // We implement two orders.

    const first = (order === 'r1_first') ? r1 : r2;
    const second = (order === 'r1_first') ? r2 : r1;
    const firstId = (order === 'r1_first') ? cand.r1 : cand.r2;
    const secondId = (order === 'r1_first') ? cand.r2 : cand.r1;

    if (session.state === 0) {
        if (ctx.kind === 'event') {
            const res = obsE_trigger(first, ctx.event);
            if (res.ok) { tl(session, 'obsE(T1)', res.witness); session.state = 1; }
        }
        return { progressed: true };
    }

    if (session.state === 1) {
        if (evalCondition(first).ok) { tl(session, 'matchS(C1)', { ok: true }); session.state = 2; }
        else resetSession(session.key);
        return { progressed: true };
    }

    if (session.state === 2) {
        if (ctx.kind === 'command' && ctx.origin && ctx.origin.source === 'rule' && ctx.origin.ruleId === firstId) {
            tl(session, 'obsC(A1)', { command: ctx.command, rule: firstId });
            // Prepare expected state predicate from this command (approx. S(A1))
            session._expect = {
                cmdLike: { uid: ctx.command.deviceId, cmd: ctx.command.cmd, args: ctx.command.args, attribute: ctx.command.attribute },
            };
            session.state = 3;
        }
        return { progressed: true };
    }

    if (session.state === 3) {
        // obsE(A1): observe event reflecting action effect
        if (ctx.kind === 'event' && session._expect && session._expect.cmdLike) {
            const actionLike = { uid: session._expect.cmdLike.uid, cmd: session._expect.cmdLike.cmd, args: session._expect.cmdLike.args };
            const res = obsE_ofActionLike(actionLike, ctx.event);
            if (res.ok) {
                tl(session, 'obsE(A1)', res.witness);

                // start hold matchS(A1) ---->
                const pred = expectedStatePredFromCmdLike(session._expect.cmdLike);
                if (!pred) { resetSession(session.key); return { progressed: true }; }
                session.holdPred = () => {
                    const cur = getLatestEventValue(pred.uid, pred.attr);
                    return compareValues(pred.op, cur, pred.val);
                };

                // check immediately holds
                if (!enforceHoldOrReset(session, cand)) return { progressed: true };

                tl(session, 'matchS(A1)---->', { start: true });
                session.state = 4;
            }
        }
        return { progressed: true };
    }

    if (session.state === 4) {
        // While waiting, hold must remain true
        if (!enforceHoldOrReset(session, cand)) return { progressed: true };

        if (ctx.kind === 'event') {
            const res = obsE_trigger(second, ctx.event);
            if (res.ok) {
                tl(session, 'obsE(T2)', res.witness);
                session.state = 5;
            }
        }
        return { progressed: true };
    }

    if (session.state === 5) {
        if (evalCondition(second).ok) {
            tl(session, 'matchS(C2)', { ok: true, rule: secondId });
            const inst = emitVerifiedInstance(cand, session);
            resetSession(session.key);
            return { progressed: true, verified: inst };
        }
        resetSession(session.key);
        return { progressed: true };
    }

    return { progressed: false };
}

function verifyCMAI_ChainedExecution(cand, session, ctx) {
    const r3 = rulesById.get(cand.r3);
    if (!r3) return { progressed: false };

    // Section 4.2.2:
    // obsC(c),
    // matchS(¬T3),
    // obsE(T3),
    // matchS(C3)

    if (session.state === 0) {
        // manual observed (command or physical)
        if ((ctx.kind === 'command' || ctx.kind === 'event') && ctx.origin && (ctx.origin.source === 'mc_remote' || ctx.origin.source === 'mc_physical')) {
            tl(session, 'obsC(c)', { origin: ctx.origin, cmd: ctx.command || null, evt: ctx.event || null });
            session.state = 1;
        }
        return { progressed: true };
    }

    if (session.state === 1) {
        const nt3 = matchNotTrigger(r3);
        if (nt3.ok) { tl(session, 'matchS(¬T3)', { ok: true }); session.state = 2; }
        else resetSession(session.key);
        return { progressed: true };
    }

    if (session.state === 2) {
        if (ctx.kind === 'event') {
            const res = obsE_trigger(r3, ctx.event);
            if (res.ok) { tl(session, 'obsE(T3)', res.witness); session.state = 3; }
        }
        return { progressed: true };
    }

    if (session.state === 3) {
        const c3 = evalCondition(r3);
        if (c3.ok) {
            tl(session, 'matchS(C3)', { ok: true });
            const inst = emitVerifiedInstance(cand, session);
            resetSession(session.key);
            return { progressed: true, verified: inst };
        }
        resetSession(session.key);
        return { progressed: true };
    }

    return { progressed: false };
}

function verifyCMAI_PotentialRaceCondition(cand, session, ctx) {
    const r3 = rulesById.get(cand.r3);
    if (!r3) return { progressed: false };

    // Appendix B:
    // obsC(c)
    // matchS(c) ----> (state remains unchanged)
    // obsE(T3), matchS(C3)  /* Until R3 executes */

    if (session.state === 0) {
        if ((ctx.kind === 'command' || ctx.kind === 'event') && ctx.origin && (ctx.origin.source === 'mc_remote' || ctx.origin.source === 'mc_physical')) {
            tl(session, 'obsC(c)', { origin: ctx.origin, cmd: ctx.command || null, evt: ctx.event || null });

            // Start hold pred on S(c)
            const cmdLike = (ctx.origin && ctx.origin.mc)
                ? { uid: ctx.origin.mc.uid, cmd: ctx.origin.mc.cmd, args: ctx.origin.mc.args, attribute: ctx.command ? ctx.command.attribute : (ctx.event ? ctx.event.attribute : null) }
                : null;
            const pred = expectedStatePredFromCmdLike(cmdLike);
            if (!pred) { resetSession(session.key); return { progressed: true }; }
            session.holdPred = () => {
                const cur = getLatestEventValue(pred.uid, pred.attr);
                return compareValues(pred.op, cur, pred.val);
            };

            // Check now
            if (!enforceHoldOrReset(session, cand)) return { progressed: true };

            tl(session, 'matchS(c)---->', { start: true });
            session.state = 1;
        }
        return { progressed: true };
    }

    if (session.state === 1) {
        if (!enforceHoldOrReset(session, cand)) return { progressed: true };

        if (ctx.kind === 'event') {
            const res = obsE_trigger(r3, ctx.event);
            if (res.ok) {
                tl(session, 'obsE(T3)', res.witness);
                session.state = 2;
            }
        }
        return { progressed: true };
    }

    if (session.state === 2) {
        const c3 = evalCondition(r3).ok;
        if (c3) {
            tl(session, 'matchS(C3)', { ok: true });
            const inst = emitVerifiedInstance(cand, session);
            resetSession(session.key);
            return { progressed: true, verified: inst };
        }
        resetSession(session.key);
        return { progressed: true };
    }
}

function verifyCMAI_CondEnableDisable(cand, session, ctx, mode /*'enable'|'disable'*/) {
    const r3 = rulesById.get(cand.r3);
    if (!r3) return { progressed: false };

    // Appendix B enabling:
    // obsC(c)
    // matchS(¬C3)
    // obsE(C3)
    // matchS(C3) ---->
    // obsE(T3)
    //
    // disabling:
    // obsC(c)
    // matchS(C3)
    // obsE(¬C3)
    // matchS(¬C3) ---->
    // obsE(T3)

    const beforeWantTrue = (mode === 'disable') ? true : false;
    const flipTo = (mode === 'disable') ? 'false' : 'true';

    if (session.state === 0) {
        if ((ctx.kind === 'command' || ctx.kind === 'event') && ctx.origin && (ctx.origin.source === 'mc_remote' || ctx.origin.source === 'mc_physical')) {
            tl(session, 'obsC(c)', { origin: ctx.origin, cmd: ctx.command || null, evt: ctx.event || null });

            const c3 = evalCondition(r3).ok;
            const ok = beforeWantTrue ? c3 : !c3;
            if (!ok) { resetSession(session.key); return { progressed: true }; }
            tl(session, beforeWantTrue ? 'matchS(C3)' : 'matchS(¬C3)', { ok: true });

            session.state = 1;
        }
        return { progressed: true };
    }

    if (session.state === 1) {
        if (ctx.kind === 'event') {
            const flipRes = (flipTo === 'false') ? obsE_conditionBecameFalse(r3, ctx.event) : obsE_conditionBecameTrue(r3, ctx.event);
            if (flipRes.ok) {
                tl(session, flipTo === 'false' ? 'obsE(¬C3)' : 'obsE(C3)', flipRes.witness);

                session.holdPred = () => {
                    const cur = evalCondition(r3).ok;
                    return (flipTo === 'false') ? (!cur) : (!!cur);
                };
                tl(session, `matchS(${flipTo === 'false' ? '¬C3' : 'C3'})---->`, { start: true });
                session.state = 2;
            }
        }
        return { progressed: true };
    }

    if (session.state === 2) {
        if (!enforceHoldOrReset(session, cand)) return { progressed: true };

        if (ctx.kind === 'event') {
            const res = obsE_trigger(r3, ctx.event);
            if (res.ok) {
                tl(session, 'obsE(T3)', res.witness);
                const inst = emitVerifiedInstance(cand, session);
                resetSession(session.key);
                return { progressed: true, verified: inst };
            }
        }
        return { progressed: true };
    }

    return { progressed: false };
}

// ----- Dispatcher -----

function runVerifierUntilStable(session, fn, maxSteps = 12) {
    let progressed = false;
    for (let i = 0; i < maxSteps; i++) {
        const prevState = session ? session.state : null;
        const res = fn() || { progressed: false };
        progressed = progressed || !!res.progressed;
        if (res.verified) return { progressed: true, verified: res.verified };

        if (!session || !session.key) return { progressed };
        if (!sessions.has(session.key)) return { progressed };
        if (session.state === prevState) return { progressed };
    }
    return { progressed };
}

function verifyCandidateOnStreamItem(cand, ctx) {
    // prune sessions occasionally
    pruneSessions();

    // Some patterns require verifying two directions/orders.
    if (cand.kind === 'CAI') {
        switch (cand.pattern) {
            case PATTERN.CAI_CHAIN:
            case PATTERN.CAI_REVERT: {
                const s = getOrCreateSession(cand, null);
                return runVerifierUntilStable(s, () => verifyCAI_ChainedOrRevert(cand, s, ctx));
            }
            case PATTERN.CAI_COND_EN: {
                const s = getOrCreateSession(cand, null);
                return runVerifierUntilStable(s, () => verifyCAI_CondEnableDisable(cand, s, ctx, 'enable'));
            }
            case PATTERN.CAI_COND_DIS: {
                const s = getOrCreateSession(cand, null);
                return runVerifierUntilStable(s, () => verifyCAI_CondEnableDisable(cand, s, ctx, 'disable'));
            }
            case PATTERN.CAI_RC: {
                const s = getOrCreateSession(cand, null);
                return runVerifierUntilStable(s, () => verifyCAI_RaceCondition(cand, s, ctx));
            }
            case PATTERN.CAI_BYPASS: {
                const s = getOrCreateSession(cand, null);
                return runVerifierUntilStable(s, () => verifyCAI_ConditionBypass(cand, s, ctx));
            }
            case PATTERN.CAI_LOOP: {
                // verify both starts: r1 and r2
                const s1 = getOrCreateSession(cand, 'start_r1');
                const r1 = runVerifierUntilStable(s1, () => verifyCAI_InfiniteLoop(cand, s1, ctx, 'r1'));
                const s2 = getOrCreateSession(cand, 'start_r2');
                const r2 = runVerifierUntilStable(s2, () => verifyCAI_InfiniteLoop(cand, s2, ctx, 'r2'));
                return { progressed: true, verified: r1.verified || r2.verified || null };
            }
            case PATTERN.CAI_PRC: {
                // verify both orders
                const s1 = getOrCreateSession(cand, 'r1_first');
                const r1 = runVerifierUntilStable(s1, () => verifyCAI_PotentialRaceCondition(cand, s1, ctx, 'r1_first'));
                const s2 = getOrCreateSession(cand, 'r2_first');
                const r2 = runVerifierUntilStable(s2, () => verifyCAI_PotentialRaceCondition(cand, s2, ctx, 'r2_first'));
                return { progressed: true, verified: r1.verified || r2.verified || null };
            }
            default:
                return { progressed: false };
        }
    }

    if (cand.kind === 'CMAI') {
        switch (cand.pattern) {
            case PATTERN.CMAI_CHAIN: {
                const s = getOrCreateSession(cand, null);
                return runVerifierUntilStable(s, () => verifyCMAI_ChainedExecution(cand, s, ctx));
            }
            case PATTERN.CMAI_PRC: {
                const s = getOrCreateSession(cand, null);
                return runVerifierUntilStable(s, () => verifyCMAI_PotentialRaceCondition(cand, s, ctx));
            }
            case PATTERN.CMAI_COND_EN: {
                const s = getOrCreateSession(cand, null);
                return runVerifierUntilStable(s, () => verifyCMAI_CondEnableDisable(cand, s, ctx, 'enable'));
            }
            case PATTERN.CMAI_COND_DIS: {
                const s = getOrCreateSession(cand, null);
                return runVerifierUntilStable(s, () => verifyCMAI_CondEnableDisable(cand, s, ctx, 'disable'));
            }
            default:
                return { progressed: false };
        }
    }

    return { progressed: false };
}

// Main verification entry for each stream item
async function verifyPattern({ origin, command, event, kind }) {
    const matched = findCandidatesForOrigin(origin);
    if (!matched || matched.length === 0) {
        return { allowed: true, reason: 'no_candidate', matched_count: 0, verified: [] };
    }

    const ctx = { origin, command, event, kind };

    const verified = [];
    for (const cand of matched) {
        const res = verifyCandidateOnStreamItem(cand, ctx);
        if (res && res.verified) verified.push(res.verified);
    }

    // Enforcement is handled by the handling module after verification emits instances.
    return { allowed: true, reason: verified.length ? 'verified' : 'verifying', matched_count: matched.length, verified };
}

// ----- Event/command handlers -----

function dedupInstances(list) {
    const seen = new Set();
    const out = [];
    for (const inst of (Array.isArray(list) ? list : [])) {
        if (!inst) continue;
        const key = `${inst.candidate_id || ''}|${inst.pattern || ''}|${inst.dir || ''}|${JSON.stringify(inst.timeline || [])}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(inst);
    }
    return out;
}

function broadcastEventToSessions(eventCtx) {
    return broadcastEventToCandidateList(
        eventCtx,
        Array.from(sessions.values()).map((s) => ({
            candidate_id: s.candidate_id,
            kind: s.kind,
            pattern: s.pattern,
            r1: s.r1,
            r2: s.r2,
            r3: s.r3,
            mc: s.mc,
        }))
    );
}

function broadcastEventToCandidateList(eventCtx, candidateList) {
    const verified = [];
    const ctx = { origin: null, command: null, event: eventCtx, kind: 'event' };
    for (const cand of (candidateList || [])) {
        const res = verifyCandidateOnStreamItem(cand, ctx);
        if (res && res.verified) verified.push(res.verified);
    }
    return verified;
}

async function handleEvent(payload) {
    const evtCtx = normalizeEventPayload(payload);
    const evtRecorded = recordEvent({ ...evtCtx, ts: Date.now() });

    const verified = [];
    let origin = { source: 'event' };
    const telemetry = { kind: 'event' };

    const recentCmd = findRecentCommandForEvent(evtCtx);
    if (!recentCmd && ACTUATOR_ATTRS.has(String(evtCtx.attribute))) {
        const mc = buildMcFromEvent(evtCtx);
        origin = { source: 'mc_physical', mc };
        const res = await verifyPattern({ origin, event: evtRecorded, kind: 'event' });
        verified.push(...(res.verified || []));
        telemetry.matched_candidates = res.matched_count || 0;
        telemetry.origin_reason = 'mc_physical';
    } else {
        telemetry.origin_reason = recentCmd ? 'command_correlated' : 'not_actuator';
    }

    return { origin, verified, telemetry, event: evtRecorded };
}

async function handleCommand(payload) {
    const cmdCtx = normalizeCommandPayload(payload);
    recordCommand({ ...cmdCtx, ts: Date.now() });

    const origin = await inferCommandSource(cmdCtx);
    cmdCtx.origin = origin;
    if (origin.source === 'mc_remote') {
        origin.mc = buildMcFromCommand(cmdCtx);
    }
    const res = await verifyPattern({ origin, command: cmdCtx, kind: 'command' });

    debugLog('[verification] command source:', origin);
    return {
        origin,
        verified: res.verified || [],
        telemetry: { kind: 'command', matched_candidates: res.matched_count || 0 },
        command: cmdCtx,
    };
}

async function observe({ kind, payload }) {
    if (kind === 'event') {
        const res = await handleEvent(payload);
        const broadcastVerified = broadcastEventToSessions(res.event);
        let allCaiVerified = [];
        if (VERIFICATION_EVENT_BROADCAST_ALL) {
            allCaiVerified = broadcastEventToCandidateList(
                res.event,
                candidates.filter(c => c && c.kind === 'CAI')
            );
        }
        const verified = dedupInstances((res.verified || []).concat(broadcastVerified, allCaiVerified));
        const telemetry = {
            ...res.telemetry,
            broadcast_verified: broadcastVerified.length,
            broadcast_all_verified: allCaiVerified.length,
            verified_count: verified.length,
        };
        return { origin: res.origin, verified, telemetry };
    }
    if (kind === 'command') {
        const res = await handleCommand(payload);
        const telemetry = {
            ...res.telemetry,
            verified_count: (res.verified || []).length,
        };
        return { origin: res.origin, verified: res.verified || [], telemetry };
    }
    return { origin: { source: 'unknown' }, verified: [], telemetry: { reason: 'unknown_kind' } };
}

function getDebugState() {
    return {
        recentEvents,
        recentCommands,
        sessions,
        rulesCount: rules.length,
        candidatesCount: candidates.length,
    };
}

// ----- Stream handler -----

async function stream_handler({kind, payload, next}) {
    if(kind === 'event') {
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
    if(kind === 'command') {
        const deviceId = payload && payload.device ? payload.device.uid : undefined;
        const attribute = payload ? payload.attribute : undefined;
        const value = payload ? payload.value : undefined;
        const sourcePlatform = payload ? payload.platform : undefined;
        console.log(`[stream_handler] command deviceId=${deviceId} attribute=${attribute} value=${value} sourcePlatform=${sourcePlatform}`);
    }
    const observation = await observe({ kind, payload });
    if (typeof next === 'function') {
        await next();
    }
    return { allowed: true, observation };
}

module.exports = {
    observe,
    getDebugState,
    stream_handler,
    initVerificationData,
};
