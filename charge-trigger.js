// --- defaults (overridable via flow/global) ---
const DEF = {
  ON_THRESHOLD: 26.5,
  OFF_THRESHOLD: 25.7,              // normal OFF threshold (ignored while post-boost latch holds)
  SWITCH_DELAY: 5 * 1000,
  SWITCH_DELAY_OFF: null,
  COOLDOWN_AFTER_ON: 3 * 60 * 1000,
  AVG_WINDOW: 30,
  MIN_ON_TIME: 0,

  // forced undervoltage break
  BREAK_UNDERVOLT: 23,
  BREAK_DURATION: 10 * 60 * 1000,

  // boost: rise-based trigger + tail
  BOOST_HOLD: 10 * 1000,          // keep ON this long after condition drops
  BOOST_RISE_STEPS: 5,            // lookback steps for rapid-rise detection
  BOOST_RISE_DELTA: 4,          // trigger if rise > this (in volts)
  BOOST_MIN_V: 26,              // require current voltage >= this for boost

  // post-boost keep-ON threshold
  POST_BOOST_OFF_V: 24.5          // while latched, only turn OFF if v < this
};

// ---- tunables ----
function tunable(k){ const f=flow.get(k); if (f!==undefined) return f; const g=global.get(k); if (g!==undefined) return g; return DEF[k]; }
const ON_THRESHOLD      = tunable("ON_THRESHOLD");
const OFF_THRESHOLD     = tunable("OFF_THRESHOLD");
const SWITCH_DELAY      = tunable("SWITCH_DELAY");
const SWITCH_DELAY_OFF  = (tunable("SWITCH_DELAY_OFF") === null) ? SWITCH_DELAY : tunable("SWITCH_DELAY_OFF");
const COOLDOWN_AFTER_ON = tunable("COOLDOWN_AFTER_ON");
const AVG_WINDOW        = Math.max(1, Math.floor(tunable("AVG_WINDOW")));
const MIN_ON_TIME       = Math.max(0, Math.floor(tunable("MIN_ON_TIME")));
const BREAK_UNDERVOLT   = tunable("BREAK_UNDERVOLT");
const BREAK_DURATION    = tunable("BREAK_DURATION");

// back-compat: allow BOOST_DURATION input to act as BOOST_HOLD
const BOOST_HOLD        = (() => { const d = flow.get("BOOST_DURATION") ?? global.get("BOOST_DURATION"); return (d!==undefined)? d : tunable("BOOST_HOLD"); })();

// rise-based boost parameters
const BOOST_RISE_STEPS  = Math.max(1, Math.floor(tunable("BOOST_RISE_STEPS")));
const BOOST_RISE_DELTA  = Number(tunable("BOOST_RISE_DELTA"));
const BOOST_MIN_V       = Number(tunable("BOOST_MIN_V"));
const POST_BOOST_OFF_V  = tunable("POST_BOOST_OFF_V");

// ---- manual reset ----
if (msg && msg.reset) {
  context.set("voltages", []);
  context.set("lastChange", 0);
  context.set("lastOnTime", 0);
  context.set("lastState", undefined);
  context.set("breakUntil", 0);
  context.set("boostUntil", 0);
  context.set("prevInBoost", false);
  context.set("postBoostLatch", false);
  node.status({ fill: "blue", shape: "ring", text: "State reset" });
  return null;
}

// ---- read voltage ----
const v = Number(msg.payload);
if (!isFinite(v)) { node.warn(`Charge control: invalid voltage payload: ${msg.payload}`); return null; }

// ---- rolling average ----
let voltages = context.get("voltages") || [];
voltages.push(v);
if (voltages.length > AVG_WINDOW) voltages.splice(0, voltages.length - AVG_WINDOW);
context.set("voltages", voltages);
const avgV = voltages.reduce((a,b)=>a+b,0) / voltages.length;

// ---- state ----
const now        = Date.now();
const lastChange = context.get("lastChange") || 0;
const lastOnTime = context.get("lastOnTime") || 0;
let   lastState  = context.get("lastState"); // 0=OFF, 1=ON
let   breakUntil = context.get("breakUntil") || 0;
let   boostUntil = context.get("boostUntil") || 0;
let   prevInBoost= !!context.get("prevInBoost");
let   postLatch  = !!context.get("postBoostLatch");

// ---- forced break (deep undervolt) ----
if (v < BREAK_UNDERVOLT) {
  breakUntil = now + BREAK_DURATION;           // extend on each deep dip
  context.set("breakUntil", breakUntil);
}
const inBreak = now < breakUntil;               // break overrides everything

// ---- forced boost (rapid rise over last N steps + ensure voltage >= BOOST_MIN_V) ----
let triggeredNow = false;
let riseDelta = 0;
if (voltages.length > BOOST_RISE_STEPS) {
  const pastV = voltages[voltages.length - 1 - BOOST_RISE_STEPS];
  riseDelta = v - pastV;
  triggeredNow = (riseDelta > BOOST_RISE_DELTA) && (v >= BOOST_MIN_V);
}
if (triggeredNow) {
  boostUntil = now + BOOST_HOLD;               // keep extending while condition true
  context.set("boostUntil", boostUntil);
}
const inBoost = triggeredNow || (now < boostUntil);

// ---- transition handling: when boost ends, arm post-boost latch ----
if (!inBoost && prevInBoost) {
  postLatch = v >= POST_BOOST_OFF_V;
  context.set("postBoostLatch", postLatch);
}
context.set("prevInBoost", inBoost);

// ---- if voltage drops below the latch threshold at any time, clear the latch ----
if (postLatch && v < POST_BOOST_OFF_V) {
  postLatch = false;
  context.set("postBoostLatch", false);
}

// ---- decide desired state ----
let newState = lastState;
if (lastState === undefined) {
  newState = (avgV >= ON_THRESHOLD && !inBreak) ? 1 : 0;
} else if (inBreak) {
  newState = 0;                               // forced OFF
} else if (inBoost) {
  newState = 1;                               // forced ON
} else if (postLatch) {
  newState = 1;                               // keep ON until v < POST_BOOST_OFF_V
} else {
  if (lastState === 1) {
    const longEnough = (now - lastOnTime) >= MIN_ON_TIME;
    if (v <= OFF_THRESHOLD && longEnough) newState = 0;
  } else {
    if (avgV >= ON_THRESHOLD) newState = 1;
  }
}

// ---- telemetry helper ----
function tele(m, reason){
  m = m || {};
  m.voltage = v;
  m.avgVoltage = Number(avgV.toFixed(3));
  m.state = (context.get("lastState") !== undefined) ? context.get("lastState") : newState;
  m.reason = reason;
  m.break = { active: inBreak, until: breakUntil };
  m.boost = {
    active: inBoost,
    until: boostUntil,
    triggeredNow,
    rise: { steps: BOOST_RISE_STEPS, delta: Number(riseDelta.toFixed(3)), threshold: BOOST_RISE_DELTA },
    minV: BOOST_MIN_V
  };
  m.postBoostLatch = { active: postLatch, offBelow: POST_BOOST_OFF_V };
  return m;
}

// ---- output / timing ----
if (newState !== lastState) {
  // forced states override delay/cooldown/min-on
  if (inBreak && newState === 0) {
    context.set("lastChange", now);
    context.set("lastState", 0);
    node.status({ fill: "red", shape: "dot", text: `Break ${Math.ceil((breakUntil-now)/1000)}s (v=${v.toFixed(2)}V)` });
    return tele({ payload: 0 }, "forced-break");
  }
  if ((inBoost || postLatch) && newState === 1) {
    context.set("lastChange", now);
    context.set("lastState", 1);
    context.set("lastOnTime", now);
    node.status({ fill: "green", shape: "dot",
      text: inBoost
        ? (triggeredNow ? `Boost (rise Δ${riseDelta.toFixed(2)}V/${BOOST_RISE_STEPS}, v=${v.toFixed(2)}V)`
                        : `Boost tail ${Math.ceil((boostUntil-now)/1000)}s`)
        : `Post-boost latch (≥${POST_BOOST_OFF_V.toFixed(1)}V)` });
    return tele({ payload: 1 }, inBoost ? "forced-boost" : "post-boost-latch-on");
  }

  // normal timing rules
  const timeSinceChange = now - lastChange;
  const timeSinceOn = now - lastOnTime;
  const requiredDelay = (newState === 0) ? SWITCH_DELAY_OFF : SWITCH_DELAY;

  if (requiredDelay > 0 && timeSinceChange < requiredDelay) {
    node.status({ fill: "yellow", shape: "ring",
      text: `Change blocked ${Math.ceil((requiredDelay - timeSinceChange)/1000)}s` });
    return null;
  }
  if (newState === 1 && timeSinceOn < COOLDOWN_AFTER_ON) {
    node.status({ fill: "yellow", shape: "ring",
      text: `ON cooldown ${Math.ceil((COOLDOWN_AFTER_ON - timeSinceOn)/1000)}s` });
    return null;
  }
  if (newState === 0 && MIN_ON_TIME > 0 && (now - lastOnTime) < MIN_ON_TIME) {
    node.status({ fill: "yellow", shape: "ring",
      text: `Min ON ${Math.ceil((MIN_ON_TIME - (now - lastOnTime))/1000)}s` });
    return null;
  }

  // accept change
  context.set("lastChange", now);
  context.set("lastState", newState);
  if (newState === 1) context.set("lastOnTime", now);

  const out = tele({ payload: newState }, "state-change");
  node.status({ fill: newState ? "green" : "grey", shape: "dot",
    text: `Avg ${avgV.toFixed(2)} → ${newState ? "ON" : "OFF"}` });
  return out;

} else {
  // steady status
  if (inBreak) {
    node.status({ fill: "red", shape: "ring", text: `OFF (break ${Math.ceil((breakUntil-now)/1000)}s)` });
    return null;
  }
  if (inBoost) {
    node.status({ fill: "green", shape: "ring",
      text: triggeredNow ? `ON (boost rise Δ${riseDelta.toFixed(2)}V/${BOOST_RISE_STEPS}, v=${v.toFixed(2)}V)`
                         : `ON (boost tail ${Math.ceil((boostUntil-now)/1000)}s)` });
    return null;
  }
  if (postLatch) {
    node.status({ fill: "green", shape: "ring", text: `ON (post-boost latch, off < ${POST_BOOST_OFF_V.toFixed(1)}V)` });
    return null;
  }
  node.status({ fill: lastState ? "green" : "grey", shape: "ring",
    text: `v=${v.toFixed(2)}V Avg ${avgV.toFixed(2)} steady ${lastState ? "ON" : "OFF"}` });
  return null;
}