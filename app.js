const STORAGE_KEY = "pp_cycle_records_v1";
const SETTINGS_KEY = "pp_cycle_settings_v1";
const WIPE_FLAG_KEY = "pp_cycle_records_wiped_once_20260227_v3";

const state = {
  records: [],
  settings: {
    cycleLength: 28,
    periodLength: 5,
    predictionShiftDays: 0,
    customPmsStartDate: null,
    pmsStartOverrides: {},
    loveDates: [],
  },
  monthCursor: new Date(),
  gesture: {
    mode: null,
    pointerId: null,
    startDate: null,
    currentDate: null,
    recordIndex: null,
    startX: 0,
    startY: 0,
    swipeDx: 0,
    swipeDirection: 0,
    swipeHandled: false,
    moved: false,
    active: false,
    pressTimer: null,
  },
  suppressClickUntil: 0,
  pendingDeleteRecordIndex: null,
  pendingActionDate: null,
  pendingActionRecordIndex: null,
  pendingActionNextStartDate: null,
  monthAnimating: false,
};

const backend = {
  client: null,
  user: null,
  coupleId: localStorage.getItem("pp_couple_id_v1") || null,
  role: localStorage.getItem("pp_couple_role_v1") || null,
  inviteCode: localStorage.getItem("pp_couple_invite_code_v1") || "",
  ownerNickname: localStorage.getItem("pp_couple_owner_nickname_v1") || "",
  syncing: false,
  syncTimer: null,
  lastRemoteUpdatedAt: null,
  channel: null,
  pollTimer: null,
};

const $ = (id) => document.getElementById(id);

function getConfig() {
  return window.POKUPOKU_CONFIG || null;
}

function hasBackendConfig() {
  const cfg = getConfig();
  return Boolean(cfg?.supabaseUrl && cfg?.supabaseAnonKey && window.supabase?.createClient);
}

function toDateOnly(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function dayDiff(fromDate, toDate) {
  return Math.round((toDateOnly(iso(toDate)) - toDateOnly(iso(fromDate))) / 86400000);
}

function iso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function fmtDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ko-KR", { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateLong(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
}

function fmtMonthDay(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
}

function todayIso() {
  return iso(new Date());
}

function isFutureDate(dateIso) {
  return dateIso > todayIso();
}

function sortRecords() {
  state.records.sort((a, b) => b.startDate.localeCompare(a.startDate));
}

function saveRecords() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
  queueRemoteSync();
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  queueRemoteSync();
}

function getLoveDatesSet() {
  return new Set(state.settings.loveDates || []);
}

function toggleLoveDate(dateIso) {
  if (!dateIso) return false;
  const set = getLoveDatesSet();
  if (set.has(dateIso)) {
    set.delete(dateIso);
  } else {
    set.add(dateIso);
  }
  state.settings.loveDates = Array.from(set).sort();
  saveSettings();
  return set.has(dateIso);
}

function getRecordEndDate(record) {
  if (record.endDate) return record.endDate;
  const nextStart = findNearestLaterStartDate(record.startDate);
  if (nextStart) return iso(addDays(toDateOnly(nextStart), -1));
  return iso(new Date());
}

function findNearestLaterStartDate(startDate) {
  let nearest = null;
  state.records.forEach((r) => {
    if (r.startDate > startDate && (nearest === null || r.startDate < nearest)) {
      nearest = r.startDate;
    }
  });
  return nearest;
}

function loadState() {
  if (!localStorage.getItem(WIPE_FLAG_KEY)) {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(SETTINGS_KEY);
    localStorage.setItem(WIPE_FLAG_KEY, "1");
  }

  const recordsRaw = localStorage.getItem(STORAGE_KEY);
  const settingsRaw = localStorage.getItem(SETTINGS_KEY);

  if (recordsRaw) {
    state.records = JSON.parse(recordsRaw);
    sortRecords();
  }

  if (settingsRaw) {
    state.settings = { ...state.settings, ...JSON.parse(settingsRaw) };
  }
}

function setSyncStatus(message) {
  const el = $("syncStatusText");
  if (el) el.textContent = message;
  const btn = $("connectAccountBtn");
  if (!btn) return;
  const connected = backend.user && backend.coupleId;
  btn.textContent = connected ? "관리" : "연결";
}

function setAuthStatus(message) {
  const el = $("authStatusText");
  if (el) el.textContent = message || "";
}

function persistCoupleMeta() {
  if (backend.coupleId) localStorage.setItem("pp_couple_id_v1", backend.coupleId);
  else localStorage.removeItem("pp_couple_id_v1");
  if (backend.role) localStorage.setItem("pp_couple_role_v1", backend.role);
  else localStorage.removeItem("pp_couple_role_v1");
  if (backend.inviteCode) localStorage.setItem("pp_couple_invite_code_v1", backend.inviteCode);
  else localStorage.removeItem("pp_couple_invite_code_v1");
  if (backend.ownerNickname) localStorage.setItem("pp_couple_owner_nickname_v1", backend.ownerNickname);
  else localStorage.removeItem("pp_couple_owner_nickname_v1");
}

async function refreshCoupleMeta() {
  if (!backend.client || !backend.user || !backend.coupleId) return false;
  const { data: row, error } = await backend.client
    .from("couples")
    .select("id, invite_code, owner_nickname")
    .eq("id", backend.coupleId)
    .maybeSingle();
  if (error || !row?.id) return false;
  backend.inviteCode = row.invite_code || "";
  backend.ownerNickname = row.owner_nickname || "";

  const { data: member } = await backend.client
    .from("couple_members")
    .select("role")
    .eq("couple_id", backend.coupleId)
    .eq("user_id", backend.user.id)
    .maybeSingle();
  backend.role = member?.role || backend.role || null;
  persistCoupleMeta();
  return true;
}

async function initBackend() {
  if (!hasBackendConfig()) {
    setSyncStatus("로컬 저장 모드");
    return;
  }

  const cfg = getConfig();
  backend.client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await backend.client.auth.getUser();
  backend.user = data?.user || null;
  await ensureAnonymousSession();

  if (backend.user && backend.coupleId) {
    await refreshCoupleMeta();
    await pullRemoteState();
    subscribeRemoteChanges();
    setSyncStatus("커플 동기화 연결됨");
  } else {
    setSyncStatus("연결 가능");
  }
}

function queueRemoteSync() {
  if (!backend.client || !backend.user || !backend.coupleId) return;
  if (backend.syncTimer) window.clearTimeout(backend.syncTimer);
  backend.syncTimer = window.setTimeout(() => {
    pushRemoteState();
  }, 240);
}

async function pushRemoteState() {
  if (!backend.client || !backend.user || !backend.coupleId || backend.syncing) return;
  backend.syncing = true;
  try {
    const payload = {
      couple_id: backend.coupleId,
      records: state.records,
      settings: state.settings,
      updated_by: backend.user.id,
    };
    const { data, error } = await backend.client
      .from("cycle_data")
      .upsert(payload, { onConflict: "couple_id" })
      .select("updated_at")
      .maybeSingle();
    if (!error) {
      if (data?.updated_at) backend.lastRemoteUpdatedAt = data.updated_at;
      setSyncStatus("커플 동기화 연결됨");
    }
  } catch (_e) {
    setSyncStatus("로컬 저장(동기화 대기)");
  } finally {
    backend.syncing = false;
  }
}

async function pullRemoteState() {
  if (!backend.client || !backend.user || !backend.coupleId) return;
  try {
    const ok = await refreshCoupleMeta();
    if (!ok) {
      await disconnectCouple("상대가 연결을 해제했어요.", false);
      return;
    }
    const { data, error } = await backend.client
      .from("cycle_data")
      .select("records, settings, updated_at")
      .eq("couple_id", backend.coupleId)
      .maybeSingle();
    if (error) return;
    if (data?.updated_at) {
      if (backend.lastRemoteUpdatedAt && data.updated_at <= backend.lastRemoteUpdatedAt) return;
      backend.lastRemoteUpdatedAt = data.updated_at;
    }
    if (data?.records && Array.isArray(data.records) && data.records.length) {
      state.records = data.records;
      sortRecords();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
    }
    if (data?.settings && typeof data.settings === "object") {
      state.settings = { ...state.settings, ...data.settings };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    }
    renderAll();
  } catch (_e) {
    // keep local state
  }
}

function subscribeRemoteChanges() {
  if (!backend.client || !backend.coupleId) return;
  if (backend.channel) {
    backend.client.removeChannel(backend.channel);
    backend.channel = null;
  }
  backend.channel = backend.client
    .channel(`cycle_data_${backend.coupleId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "cycle_data", filter: `couple_id=eq.${backend.coupleId}` },
      () => {
        pullRemoteState();
      }
    )
    .subscribe();
  startRemotePolling();
}

function startRemotePolling() {
  if (backend.pollTimer) window.clearInterval(backend.pollTimer);
  if (!backend.client || !backend.user || !backend.coupleId) return;
  backend.pollTimer = window.setInterval(() => {
    if (document.hidden) return;
    pullRemoteState();
  }, 1800);
}

function stopRemotePolling() {
  if (!backend.pollTimer) return;
  window.clearInterval(backend.pollTimer);
  backend.pollTimer = null;
}

async function disconnectCouple(message = "커플 연결 해제됨", removeRemote = true) {
  if (removeRemote && backend.client && backend.user && backend.coupleId) {
    if (backend.role === "owner") {
      await backend.client.from("couples").delete().eq("id", backend.coupleId).eq("owner_user_id", backend.user.id);
    } else {
      await backend.client.from("couple_members").delete().eq("couple_id", backend.coupleId).eq("user_id", backend.user.id);
    }
  }
  backend.coupleId = null;
  backend.role = null;
  backend.inviteCode = "";
  backend.ownerNickname = "";
  backend.lastRemoteUpdatedAt = null;
  persistCoupleMeta();
  if (backend.client && backend.channel) {
    await backend.client.removeChannel(backend.channel);
    backend.channel = null;
  }
  stopRemotePolling();
  setSyncStatus(backend.user ? "연결 가능" : "연결 필요");
  setAuthStatus(message);
}

async function signOut() {
  if (!backend.client) return;
  await backend.client.auth.signOut();
  backend.user = null;
  await disconnectCouple("로그아웃됨", false);
  setSyncStatus("연결 필요");
}

function randomCode(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

function getAdaptiveAverages(records, settings) {
  const safeCycle = Math.max(15, Math.min(60, Number(settings.cycleLength) || 28));
  const safePeriod = Math.max(2, Math.min(10, Number(settings.periodLength) || 5));
  const safePmsLead = 5;
  if (!records.length) return { cycleLength: safeCycle, periodLength: safePeriod, pmsLeadDays: safePmsLead, windowMonths: 0 };

  const latestStart = toDateOnly(records[0].startDate);
  const threeMonthStart = addMonths(latestStart, -3);
  const sixMonthStart = addMonths(latestStart, -6);
  const hasSixMonths = records.some((r) => toDateOnly(r.startDate) <= sixMonthStart);
  const hasThreeMonths = records.some((r) => toDateOnly(r.startDate) <= threeMonthStart);
  const windowMonths = hasSixMonths ? 6 : hasThreeMonths ? 3 : 0;
  if (!windowMonths) return { cycleLength: safeCycle, periodLength: safePeriod, pmsLeadDays: safePmsLead, windowMonths: 0 };

  const windowStart = addMonths(latestStart, -windowMonths);
  const recent = records
    .filter((r) => toDateOnly(r.startDate) >= windowStart)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  const cycleSamples = [];
  for (let i = 1; i < recent.length; i += 1) {
    const prev = toDateOnly(recent[i - 1].startDate);
    const cur = toDateOnly(recent[i].startDate);
    const diff = Math.round((cur - prev) / 86400000);
    if (diff > 0) cycleSamples.push(diff);
  }

  const periodSamples = [];
  recent.forEach((r) => {
    if (!r.endDate) return;
    const start = toDateOnly(r.startDate);
    const end = toDateOnly(r.endDate);
    const days = Math.round((end - start) / 86400000) + 1;
    if (days > 0) periodSamples.push(days);
  });

  const pmsLeadSamples = [];
  recent.forEach((r) => {
    const pmsStart = settings.pmsStartOverrides?.[r.startDate];
    if (!pmsStart) return;
    const lead = Math.round((toDateOnly(r.startDate) - toDateOnly(pmsStart)) / 86400000);
    if (lead > 0) pmsLeadSamples.push(lead);
  });

  const avgCycle =
    cycleSamples.length > 0
      ? Math.round(cycleSamples.reduce((sum, n) => sum + n, 0) / cycleSamples.length)
      : safeCycle;
  const avgPeriod =
    periodSamples.length > 0
      ? Math.round(periodSamples.reduce((sum, n) => sum + n, 0) / periodSamples.length)
      : safePeriod;
  const avgPmsLead =
    pmsLeadSamples.length > 0
      ? Math.round(pmsLeadSamples.reduce((sum, n) => sum + n, 0) / pmsLeadSamples.length)
      : safePmsLead;

  return {
    cycleLength: Math.max(15, Math.min(60, avgCycle)),
    periodLength: Math.max(2, Math.min(10, avgPeriod)),
    pmsLeadDays: Math.max(1, Math.min(14, avgPmsLead)),
    windowMonths,
  };
}

function latestRecord() {
  return state.records[0] || null;
}

function getBasePredictedStart() {
  const latest = latestRecord();
  if (!latest) return null;
  const adaptive = getAdaptiveAverages(state.records, state.settings);
  return addDays(toDateOnly(latest.startDate), Number(adaptive.cycleLength));
}

function predictNextStartDate() {
  const base = getBasePredictedStart();
  if (!base) return null;
  return iso(addDays(base, Number(state.settings.predictionShiftDays || 0)));
}

function setPredictedStartDate(targetStartIso) {
  const base = getBasePredictedStart();
  if (!base) return;
  const shift = Math.round((toDateOnly(targetStartIso) - base) / 86400000);
  state.settings.predictionShiftDays = shift;
  saveSettings();
}

function movePmsOverrideKey(oldStartDate, newStartDate) {
  if (!oldStartDate || !newStartDate || oldStartDate === newStartDate) return;
  if (!state.settings.pmsStartOverrides) return;
  const value = state.settings.pmsStartOverrides[oldStartDate];
  if (!value) return;
  state.settings.pmsStartOverrides[newStartDate] = value;
  delete state.settings.pmsStartOverrides[oldStartDate];
}

function getActualDaysSet() {
  const set = new Set();
  state.records.forEach((r) => {
    let cur = toDateOnly(r.startDate);
    const end = toDateOnly(getRecordEndDate(r));
    while (cur <= end) {
      set.add(iso(cur));
      cur = addDays(cur, 1);
    }
  });
  return set;
}

function getMarkerMap() {
  const adaptive = getAdaptiveAverages(state.records, state.settings);
  const map = new Map();
  const actualSet = getActualDaysSet();
  const todayKey = todayIso();
  const periodLengthSetting = Math.max(1, Number(adaptive.periodLength) || 5);

  // Recorded starts: auto PMS for 5 days before each start.
  state.records.forEach((record) => {
    const start = toDateOnly(record.startDate);
    const startKey = record.startDate;
    const overrideStart = state.settings.pmsStartOverrides?.[startKey] || iso(addDays(start, -adaptive.pmsLeadDays));
    let cursor = toDateOnly(overrideStart);
    const pmsEnd = addDays(start, -1);
    if (cursor > pmsEnd) cursor = new Date(pmsEnd);
    while (cursor <= pmsEnd) {
      const pmsKey = iso(cursor);
      if (!actualSet.has(pmsKey)) {
        map.set(pmsKey, { type: "pms", cycle: -1 });
      }
      cursor = addDays(cursor, 1);
    }
  });

  // Ongoing period: show remaining expected days as predicted (yellow) on calendar.
  state.records.forEach((record) => {
    if (record.endDate) return;
    const elapsedDays = Math.max(
      1,
      Math.floor((toDateOnly(todayKey).getTime() - toDateOnly(record.startDate).getTime()) / 86400000) + 1
    );
    const remainingDays = Math.max(0, periodLengthSetting - elapsedDays);
    for (let i = 1; i <= remainingDays; i += 1) {
      const k = iso(addDays(toDateOnly(todayKey), i));
      if (!actualSet.has(k) && !map.has(k)) {
        map.set(k, { type: "predicted", cycle: -1 });
      }
    }
  });

  const latest = latestRecord();
  const predictedStartIso = predictNextStartDate();
  if (!latest || !predictedStartIso) return map;

  const periodLength = Number(adaptive.periodLength);
  const cycleLength = Number(adaptive.cycleLength);
  let nextStart = toDateOnly(predictedStartIso);

  const firstPmsEnd = addDays(nextStart, -1);
  const defaultFirstPmsStart = addDays(nextStart, -adaptive.pmsLeadDays);
  const customPmsStart = state.settings.customPmsStartDate ? toDateOnly(state.settings.customPmsStartDate) : null;
  const firstPmsStart = customPmsStart || defaultFirstPmsStart;

  for (let n = 0; n < 12; n += 1) {
    const startKey = iso(nextStart);
    for (let i = 0; i < periodLength; i += 1) {
      map.set(iso(addDays(nextStart, i)), { type: "predicted", cycle: n });
    }

    const defaultStart = n === 0 ? iso(firstPmsStart) : iso(addDays(nextStart, -adaptive.pmsLeadDays));
    const pmsStart = state.settings.pmsStartOverrides?.[startKey] || defaultStart;
    const pmsEnd = iso(addDays(nextStart, -1));
    let cursor = toDateOnly(pmsStart);
    if (cursor > toDateOnly(pmsEnd)) cursor = toDateOnly(pmsEnd);
    while (cursor <= toDateOnly(pmsEnd)) {
      const pmsKey = iso(cursor);
      if (!actualSet.has(pmsKey) && !map.has(pmsKey)) {
        map.set(pmsKey, { type: "pms", cycle: n });
      }
      cursor = addDays(cursor, 1);
    }

    nextStart = addDays(nextStart, cycleLength);
  }

  return map;
}

function getRecordEndDateFor(record, records) {
  if (record.endDate) return record.endDate;
  let nextStart = null;
  records.forEach((r) => {
    if (r.startDate > record.startDate && (nextStart === null || r.startDate < nextStart)) nextStart = r.startDate;
  });
  if (nextStart) return iso(addDays(toDateOnly(nextStart), -1));
  return iso(new Date());
}

function getActualDaysSetFor(records) {
  const set = new Set();
  records.forEach((r) => {
    let cur = toDateOnly(r.startDate);
    const end = toDateOnly(getRecordEndDateFor(r, records));
    while (cur <= end) {
      set.add(iso(cur));
      cur = addDays(cur, 1);
    }
  });
  return set;
}

function predictNextStartDateFor(records, settings) {
  if (!records.length) return null;
  const sorted = [...records].sort((a, b) => b.startDate.localeCompare(a.startDate));
  const adaptive = getAdaptiveAverages(sorted, settings);
  const base = addDays(toDateOnly(sorted[0].startDate), Number(adaptive.cycleLength));
  return iso(addDays(base, Number(settings.predictionShiftDays || 0)));
}

function getPredictedStartDatesFor(records, settings, count = 12) {
  const out = [];
  const first = predictNextStartDateFor(records, settings);
  if (!first) return out;
  let cursor = toDateOnly(first);
  const adaptive = getAdaptiveAverages(records, settings);
  const cycle = Number(adaptive.cycleLength);
  for (let i = 0; i < count; i += 1) {
    out.push(iso(cursor));
    cursor = addDays(cursor, cycle);
  }
  return out;
}

function findNextStartDateFor(records, settings, dateIso) {
  const starts = [];
  records.forEach((r) => starts.push(r.startDate));
  getPredictedStartDatesFor(records, settings).forEach((d) => starts.push(d));
  const uniqueSorted = Array.from(new Set(starts)).sort((a, b) => a.localeCompare(b));
  return uniqueSorted.find((d) => d > dateIso) || null;
}

function getMarkerMapFor(records, settings) {
  const adaptive = getAdaptiveAverages(records, settings);
  const map = new Map();
  const actualSet = getActualDaysSetFor(records);
  const todayKey = todayIso();
  const periodLengthSetting = Math.max(1, Number(adaptive.periodLength) || 5);

  records.forEach((record) => {
    const start = toDateOnly(record.startDate);
    const startKey = record.startDate;
    const overrideStart = settings.pmsStartOverrides?.[startKey] || iso(addDays(start, -adaptive.pmsLeadDays));
    let cursor = toDateOnly(overrideStart);
    const pmsEnd = addDays(start, -1);
    if (cursor > pmsEnd) cursor = new Date(pmsEnd);
    while (cursor <= pmsEnd) {
      const pmsKey = iso(cursor);
      if (!actualSet.has(pmsKey)) map.set(pmsKey, { type: "pms", cycle: -1 });
      cursor = addDays(cursor, 1);
    }
  });

  records.forEach((record) => {
    if (record.endDate) return;
    const elapsedDays = Math.max(
      1,
      Math.floor((toDateOnly(todayKey).getTime() - toDateOnly(record.startDate).getTime()) / 86400000) + 1
    );
    const remainingDays = Math.max(0, periodLengthSetting - elapsedDays);
    for (let i = 1; i <= remainingDays; i += 1) {
      const k = iso(addDays(toDateOnly(todayKey), i));
      if (!actualSet.has(k) && !map.has(k)) map.set(k, { type: "predicted", cycle: -1 });
    }
  });

  const predictedStartIso = predictNextStartDateFor(records, settings);
  if (!records.length || !predictedStartIso) return map;
  const periodLength = Number(adaptive.periodLength);
  const cycleLength = Number(adaptive.cycleLength);
  let nextStart = toDateOnly(predictedStartIso);
  const defaultFirstPmsStart = addDays(nextStart, -adaptive.pmsLeadDays);
  const customPmsStart = settings.customPmsStartDate ? toDateOnly(settings.customPmsStartDate) : null;
  const firstPmsStart = customPmsStart || defaultFirstPmsStart;

  for (let n = 0; n < 12; n += 1) {
    const startKey = iso(nextStart);
    for (let i = 0; i < periodLength; i += 1) {
      map.set(iso(addDays(nextStart, i)), { type: "predicted", cycle: n });
    }
    const defaultStart = n === 0 ? iso(firstPmsStart) : iso(addDays(nextStart, -adaptive.pmsLeadDays));
    const pmsStart = settings.pmsStartOverrides?.[startKey] || defaultStart;
    const pmsEnd = iso(addDays(nextStart, -1));
    let cursor = toDateOnly(pmsStart);
    if (cursor > toDateOnly(pmsEnd)) cursor = toDateOnly(pmsEnd);
    while (cursor <= toDateOnly(pmsEnd)) {
      const pmsKey = iso(cursor);
      if (!actualSet.has(pmsKey) && !map.has(pmsKey)) map.set(pmsKey, { type: "pms", cycle: n });
      cursor = addDays(cursor, 1);
    }
    nextStart = addDays(nextStart, cycleLength);
  }
  return map;
}

function findRecordContainingDateFor(records, dateIso) {
  return records.findIndex((r) => dateIso >= r.startDate && dateIso <= getRecordEndDateFor(r, records));
}

function getSimulatedRenderData() {
  const records = state.records.map((r) => ({ ...r }));
  const settings = { ...state.settings, pmsStartOverrides: { ...(state.settings.pmsStartOverrides || {}) } };
  if (!state.gesture.active || !state.gesture.mode || !state.gesture.startDate || !state.gesture.currentDate) {
    return { records, settings };
  }

  if (state.gesture.mode === "create") {
    const [a, b] = orderedDates(state.gesture.startDate, state.gesture.currentDate);
    records.push({ startDate: a, endDate: b });
    records.sort((x, y) => y.startDate.localeCompare(x.startDate));
    return { records, settings };
  }

  if (state.gesture.recordIndex !== null && records[state.gesture.recordIndex]) {
    const rec = records[state.gesture.recordIndex];
    if (state.gesture.mode === "resize-end") {
      rec.endDate = state.gesture.currentDate < rec.startDate ? rec.startDate : state.gesture.currentDate;
    } else if (state.gesture.mode === "resize-start") {
      const oldStart = rec.startDate;
      const effectiveEnd = getRecordEndDateFor(rec, records);
      rec.startDate = state.gesture.currentDate > effectiveEnd ? effectiveEnd : state.gesture.currentDate;
      const v = settings.pmsStartOverrides?.[oldStart];
      if (v) {
        settings.pmsStartOverrides[rec.startDate] = v;
        delete settings.pmsStartOverrides[oldStart];
      }
    } else if (state.gesture.mode === "resize-range") {
      const [a, b] = orderedDates(state.gesture.startDate, state.gesture.currentDate);
      rec.startDate = a;
      rec.endDate = b;
    }
    records.sort((x, y) => y.startDate.localeCompare(x.startDate));
  }

  if (state.gesture.mode === "resize-pms-start") {
    const nextStart = findNextStartDateFor(records, settings, state.gesture.startDate);
    if (nextStart) {
      const pmsEnd = iso(addDays(toDateOnly(nextStart), -1));
      settings.pmsStartOverrides[nextStart] = state.gesture.currentDate > pmsEnd ? pmsEnd : state.gesture.currentDate;
    }
  }

  return { records, settings };
}

function getCalendarType(dateKey, actualSet, markerMap) {
  if (actualSet.has(dateKey)) return "actual";
  return markerMap.get(dateKey)?.type || null;
}

function renderHomeSummary() {
  const todayStatus = $("todayStatus");
  const nextPrediction = $("nextPrediction");
  const avgStats = $("avgStats");
  const timeline = $("summaryTimeline");
  const startLabel = $("timelineStartLabel");
  const endLabel = $("timelineEndLabel");
  if (!todayStatus || !nextPrediction || !timeline || !startLabel || !endLabel || !avgStats) return;

  const today = new Date();
  const todayKey = iso(today);
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const markerMap = getMarkerMap();
  const adaptive = getAdaptiveAverages(state.records, state.settings);
  avgStats.textContent = "";
  todayStatus.classList.remove("summary-primary-period");

  const nextStart = predictNextStartDate();
  if (!nextStart) {
    todayStatus.textContent = "월경 예정일을 계산하려면 기록이 필요해요.";
    nextPrediction.textContent = "";
    timeline.innerHTML = "";
    startLabel.textContent = "";
    endLabel.textContent = "";
    startLabel.style.left = "";
    endLabel.style.left = "";
    return;
  }
  const activeRecord = state.records.find((r) => todayKey >= r.startDate && todayKey <= getRecordEndDate(r));
  const targetStartIso = activeRecord ? activeRecord.startDate : nextStart;
  const targetStart = toDateOnly(targetStartIso);
  const expectedEndBase = addDays(targetStart, adaptive.periodLength - 1);
  let targetEnd = activeRecord?.endDate
    ? toDateOnly(activeRecord.endDate)
    : new Date(expectedEndBase);
  // If an ongoing period exceeds average length, extend the journey bar with the real elapsed days.
  if (activeRecord && !activeRecord.endDate && dayStart > targetEnd) {
    targetEnd = new Date(dayStart);
  }

  const prevRecord = state.records
    .filter((r) => r.startDate < targetStartIso)
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  const fallbackJourneyStart = addDays(targetStart, -(adaptive.cycleLength - adaptive.periodLength));
  const journeyStart = prevRecord ? addDays(toDateOnly(getRecordEndDate(prevRecord)), 1) : fallbackJourneyStart;

  let pmsStart = state.settings.pmsStartOverrides?.[targetStartIso]
    ? toDateOnly(state.settings.pmsStartOverrides[targetStartIso])
    : addDays(targetStart, -adaptive.pmsLeadDays);
  if (pmsStart < journeyStart) pmsStart = new Date(journeyStart);

  const totalDays = Math.max(1, dayDiff(journeyStart, targetEnd) + 1);
  const elapsedDays = Math.min(totalDays, Math.max(1, dayDiff(journeyStart, dayStart) + 1));
  const progress = Math.max(0, Math.min(100, Math.round((elapsedDays / totalDays) * 100)));

  const nonPeriodDays = Math.max(0, dayDiff(journeyStart, addDays(pmsStart, -1)) + 1);
  const pmsDays = Math.max(0, dayDiff(pmsStart, addDays(targetStart, -1)) + 1);
  const periodDays = Math.max(1, dayDiff(targetStart, targetEnd) + 1);
  const nonW = (nonPeriodDays / totalDays) * 100;
  const pmsW = (pmsDays / totalDays) * 100;
  const periodW = (periodDays / totalDays) * 100;

  const periodSegClass = activeRecord ? "period" : "period-predicted";
  const cells = [];
  for (let i = 0; i < totalDays; i += 1) {
    let cellClass = "non";
    if (i >= nonPeriodDays && i < nonPeriodDays + pmsDays) {
      cellClass = "pms";
    } else if (i >= nonPeriodDays + pmsDays) {
      cellClass = periodSegClass;
    }
    const todayClass = i === elapsedDays - 1 ? " today" : "";
    cells.push(`<span class="journey-cell ${cellClass}${todayClass}"></span>`);
  }
  timeline.innerHTML = `<div class="journey-bar" style="--journey-cells:${totalDays}">${cells.join("")}</div>`;
  startLabel.textContent = "PMS";
  const endLabelText = activeRecord ? (!activeRecord.endDate ? "진행중" : "완료") : "예정일";
  endLabel.textContent = endLabelText;
  startLabel.classList.remove("timeline-label-pms", "timeline-label-period", "timeline-label-predicted");
  endLabel.classList.remove("timeline-label-pms", "timeline-label-period", "timeline-label-predicted");
  startLabel.classList.add("timeline-label-pms");
  endLabel.classList.add(activeRecord ? "timeline-label-period" : "timeline-label-predicted");
  const pmsCenter = nonW + pmsW / 2;
  const periodCenter = nonW + pmsW + periodW / 2;
  startLabel.style.left = `${Math.max(3, Math.min(97, pmsCenter))}%`;
  endLabel.style.left = `${Math.max(3, Math.min(97, periodCenter))}%`;

  if (dayStart < targetStart) {
    const daysUntilStart = Math.max(0, dayDiff(dayStart, targetStart));
    const inPmsWindow = dayStart >= pmsStart;
    const baseText = daysUntilStart === 0 ? "오늘 시작해요" : `${daysUntilStart}일 뒤에 시작해요`;
    if (inPmsWindow) {
      todayStatus.textContent = daysUntilStart === 0 ? "PMS 기간 · 월경 오늘 시작" : `PMS 기간 · 월경 ${daysUntilStart}일 뒤 시작`;
    } else {
      todayStatus.textContent = baseText;
    }
  } else {
    const day = Math.max(1, dayDiff(targetStart, dayStart) + 1);
    if (activeRecord) {
      const isOngoing = !activeRecord.endDate;
      const endedToday = !!activeRecord.endDate && activeRecord.endDate === todayKey;
      const overDays = Math.max(0, dayDiff(expectedEndBase, dayStart));
      if (isOngoing && overDays > 0) {
        todayStatus.textContent = `${day}일차, 평소보다 ${overDays}일 더 길어요`;
      } else if (isOngoing && dayDiff(dayStart, expectedEndBase) === 0) {
        todayStatus.textContent = `${day}일차, 오늘 끝날 예정이에요`;
      } else if (endedToday) {
        todayStatus.textContent = `${day}일차, 오늘 끝났어요`;
      } else {
        const left = Math.max(0, dayDiff(dayStart, targetEnd));
        const endingText = left === 0 ? "오늘 끝나요" : left === 1 ? "하루 뒤면 끝나요" : `${left}일 뒤면 끝나요`;
        todayStatus.textContent = `${day}일차 · ${endingText}`;
      }
    } else {
      const delayedDays = Math.max(0, dayDiff(targetStart, dayStart));
      todayStatus.textContent = delayedDays === 0 ? "오늘 시작할 예정이에요" : `⚠️ 평소보다 ${delayedDays}일 더 늦어요`;
    }
    todayStatus.classList.add("summary-primary-period");
  }
  if (activeRecord) {
    const diffToExpected = dayDiff(dayStart, expectedEndBase);
    let expectedText = "";
    if (diffToExpected === 0) expectedText = "예상종료일 오늘";
    else if (diffToExpected > 0) expectedText = `예상종료일 D-${diffToExpected}`;
    else expectedText = `예상종료일 D+${Math.abs(diffToExpected)}`;
    nextPrediction.innerHTML = `${expectedText} · <span class="summary-subtle">주기 ${adaptive.cycleLength}일, 기간 ${adaptive.periodLength}일</span>`;
  } else {
    const startDateText = fmtMonthDay(iso(targetStart));
    const isTodayStart = dayDiff(dayStart, targetStart) === 0;
    const prefix = isTodayStart ? "오늘 시작할 예정" : `${startDateText}에 시작할 예정`;
    nextPrediction.innerHTML = `${prefix} · <span class="summary-subtle">주기 ${adaptive.cycleLength}일, 기간 ${adaptive.periodLength}일</span>`;
  }
}

function findRecordContainingDate(dateIso) {
  return state.records.findIndex((r) => dateIso >= r.startDate && dateIso <= getRecordEndDate(r));
}

function orderedDates(a, b) {
  return a <= b ? [a, b] : [b, a];
}

function fillDateRangeSet(set, startIso, endIso) {
  let cursor = toDateOnly(startIso);
  const end = toDateOnly(endIso);
  while (cursor <= end) {
    set.add(iso(cursor));
    cursor = addDays(cursor, 1);
  }
}

function getPreviewDaysSet() {
  const set = new Set();
  if (!state.gesture.mode || !state.gesture.startDate || !state.gesture.currentDate) return set;

  if (state.gesture.mode === "create") {
    const [a, b] = orderedDates(state.gesture.startDate, state.gesture.currentDate);
    fillDateRangeSet(set, a, b);
    return set;
  }

  if ((state.gesture.mode === "resize-end" || state.gesture.mode === "resize-start") && state.gesture.recordIndex !== null) {
    const record = state.records[state.gesture.recordIndex];
    if (!record) return set;
    const effectiveEnd = getRecordEndDate(record);

    if (state.gesture.mode === "resize-end") {
      const endDate = state.gesture.currentDate < record.startDate ? record.startDate : state.gesture.currentDate;
      fillDateRangeSet(set, record.startDate, endDate);
    } else {
      const startDate = state.gesture.currentDate > effectiveEnd ? effectiveEnd : state.gesture.currentDate;
      fillDateRangeSet(set, startDate, effectiveEnd);
    }
  }

  if (state.gesture.mode === "resize-range" && state.gesture.recordIndex !== null) {
    const [a, b] = orderedDates(state.gesture.startDate, state.gesture.currentDate);
    fillDateRangeSet(set, a, b);
  }

  if (state.gesture.mode === "resize-pms-start") {
    const nextStart = findNextStartDate(state.gesture.startDate);
    if (!nextStart) return set;
    const pmsEnd = iso(addDays(toDateOnly(nextStart), -1));
    const candidate = state.gesture.currentDate > pmsEnd ? pmsEnd : state.gesture.currentDate;
    fillDateRangeSet(set, candidate, pmsEnd);
  }

  return set;
}

function getLiveActualBounds() {
  if (!state.gesture.active || state.gesture.recordIndex === null) return null;
  const record = state.records[state.gesture.recordIndex];
  if (!record || !state.gesture.currentDate) return null;
  const effectiveEnd = getRecordEndDate(record);

  if (state.gesture.mode === "resize-end") {
    const end = state.gesture.currentDate < record.startDate ? record.startDate : state.gesture.currentDate;
    return { start: record.startDate, end };
  }

  if (state.gesture.mode === "resize-start") {
    const start = state.gesture.currentDate > effectiveEnd ? effectiveEnd : state.gesture.currentDate;
    return { start, end: effectiveEnd };
  }

  if (state.gesture.mode === "resize-range" && state.gesture.startDate) {
    const [start, end] = orderedDates(state.gesture.startDate, state.gesture.currentDate);
    return { start, end };
  }

  return null;
}

function getLivePmsStart() {
  if (!state.gesture.active || state.gesture.mode !== "resize-pms-start") return null;
  if (!state.gesture.startDate || !state.gesture.currentDate) return null;
  const nextStart = findNextStartDate(state.gesture.startDate);
  if (!nextStart) return null;
  const pmsEnd = iso(addDays(toDateOnly(nextStart), -1));
  const start = state.gesture.currentDate > pmsEnd ? pmsEnd : state.gesture.currentDate;
  return { start, end: pmsEnd };
}

function hasRangeOverlap(startDate, endDate) {
  return state.records.some((record) => !(endDate < record.startDate || startDate > getRecordEndDate(record)));
}

function hasRangeOverlapExcludingIndex(startDate, endDate, excludeIndex) {
  return state.records.some((record, idx) => idx !== excludeIndex && !(endDate < record.startDate || startDate > getRecordEndDate(record)));
}

function renderCalendar() {
  const grid = $("calendarGrid");
  if (!grid) return;
  renderTopbarMonth(state.monthCursor);
  renderCalendarInto(state.monthCursor, grid);
}

function renderTopbarMonth(monthCursor) {
  const yearEl = $("topbarYear");
  const monthEl = $("topbarMonth");
  if (!yearEl || !monthEl) return;
  yearEl.textContent = String(monthCursor.getFullYear());
  monthEl.textContent = `${monthCursor.getMonth() + 1}월`;
}

function renderCalendarInto(monthCursor, grid) {
  if (!grid) return;
  grid.innerHTML = "";
  const today = new Date();

  const year = monthCursor.getFullYear();
  const month = monthCursor.getMonth();
  const firstDay = new Date(year, month, 1);
  let startWeekday = (firstDay.getDay() + 6) % 7; // Monday-first
  if (startWeekday === 0) startWeekday = 7; // show previous month's last week
  const lastDate = new Date(year, month + 1, 0).getDate();
  const prevMonthLastDate = new Date(year, month, 0).getDate();
  ["월", "화", "수", "목", "금", "토", "일"].forEach((d) => {
    const el = document.createElement("div");
    el.className = "weekday-cell";
    el.textContent = d;
    grid.appendChild(el);
  });

  const simulated = getSimulatedRenderData();
  const renderRecords = simulated.records;
  const renderSettings = simulated.settings;
  const actualSet = getActualDaysSetFor(renderRecords);
  const markerMap = getMarkerMapFor(renderRecords, renderSettings);
  const previewSet = getPreviewDaysSet();
  const loveDatesSet = getLoveDatesSet();

  function appendDayCell(current, isOutsideMonth) {
    const key = iso(current);
    const todayKey = iso(new Date());
    const isRealCurrentMonth =
      current.getFullYear() === today.getFullYear() && current.getMonth() === today.getMonth();
    const dayOfWeek = (current.getDay() + 6) % 7;
    const recordIndex = findRecordContainingDateFor(renderRecords, key);
    const record = recordIndex !== -1 ? renderRecords[recordIndex] : null;

    const marker = markerMap.get(key) || null;
    const type = getCalendarType(key, actualSet, markerMap);
    const prevType = dayOfWeek === 0 ? null : getCalendarType(iso(addDays(current, -1)), actualSet, markerMap);
    const nextType = dayOfWeek === 6 ? null : getCalendarType(iso(addDays(current, 1)), actualSet, markerMap);
    const prevTypeGlobal = getCalendarType(iso(addDays(current, -1)), actualSet, markerMap);
    const nextTypeGlobal = getCalendarType(iso(addDays(current, 1)), actualSet, markerMap);
    const prevRecordIndex = findRecordContainingDateFor(renderRecords, iso(addDays(current, -1)));
    const nextRecordIndex = findRecordContainingDateFor(renderRecords, iso(addDays(current, 1)));

    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.date = key;
    if (isOutsideMonth) cell.classList.add("outside");
    cell.classList.add(isRealCurrentMonth ? "real-current-month" : "real-other-month");
    if (key === todayKey) cell.classList.add("today");

    const num = document.createElement("span");
    num.className = "day-num";
    num.textContent = String(current.getDate());
    cell.appendChild(num);

    if (loveDatesSet.has(key)) {
      const love = document.createElement("span");
      love.className = "love-mark";
      love.textContent = "✓";
      cell.appendChild(love);
    }

    if (type) {
      cell.classList.add(type);
      const fill = document.createElement("span");
      fill.className = "fill-layer";
      cell.appendChild(fill);
      if (marker) {
        cell.dataset.markerType = marker.type;
        cell.dataset.markerCycle = String(marker.cycle);
      }
      if (type === "actual") {
        const samePrevRecord = prevType === type && prevRecordIndex !== -1 && prevRecordIndex === recordIndex;
        const sameNextRecord = nextType === type && nextRecordIndex !== -1 && nextRecordIndex === recordIndex;
        if (!samePrevRecord) cell.classList.add("range-startcap");
        if (!sameNextRecord) cell.classList.add("range-endcap");
      } else {
        if (prevType !== type) cell.classList.add("range-startcap");
        if (nextType !== type) cell.classList.add("range-endcap");
      }
    }

    if (type === "actual" && record) {
      cell.dataset.recordIndex = String(recordIndex);
      if (record.startDate === key) cell.classList.add("actual-start");
      if (record.endDate && record.endDate === key) cell.classList.add("actual-end");
      if (!record.endDate && key === todayKey) {
        cell.classList.add("actual-ongoing");
        cell.dataset.ongoingLabel = "진행중";
      }
      if (record.endDate && record.startDate === record.endDate && record.startDate === key) {
        cell.classList.add("actual-one-day");
      }
    }

    if (type === "predicted" && prevTypeGlobal !== type && marker?.cycle !== -1) {
      cell.classList.add("predicted-start");
    }
    if (type === "predicted" && marker?.cycle === -1 && nextTypeGlobal !== type) {
      cell.classList.add("predicted-end");
    }

    if (type === "pms" && prevTypeGlobal !== type) cell.classList.add("pms-start");

    if (type === "pms" && nextTypeGlobal !== type && marker?.cycle === 0) {
      cell.classList.add("pms-end");
    }

    if (previewSet.has(key)) {
      const isResizeGesture =
        state.gesture.mode === "resize-start" ||
        state.gesture.mode === "resize-end" ||
        state.gesture.mode === "resize-range" ||
        state.gesture.mode === "resize-pms-start";
      if (!isResizeGesture) {
        cell.classList.add("preview");
      }
    }

    grid.appendChild(cell);
  }

  for (let i = 0; i < startWeekday; i += 1) {
    const day = prevMonthLastDate - startWeekday + 1 + i;
    appendDayCell(new Date(year, month - 1, day), true);
  }

  for (let day = 1; day <= lastDate; day += 1) {
    appendDayCell(new Date(year, month, day), false);
  }

  const totalDayCells = 42; // 6 rows x 7 columns
  const leadingCount = startWeekday;
  const renderedCurrentMonth = lastDate;
  const trailingCount = totalDayCells - (leadingCount + renderedCurrentMonth);
  for (let i = 1; i <= trailingCount; i += 1) {
    appendDayCell(new Date(year, month + 1, i), true);
  }
}

function renderGhostCalendar(monthCursor) {
  const ghostGrid = $("calendarGhostGrid");
  if (!ghostGrid) return;
  renderCalendarInto(monthCursor, ghostGrid);
}

function resetSwipePreview(immediate = false) {
  const main = $("calendarMainSurface");
  const ghost = $("calendarGhost");
  if (main) {
    main.style.transition = immediate ? "none" : "";
    main.style.transform = "";
  }
  if (ghost) {
    ghost.style.transition = immediate ? "none" : "";
    ghost.style.transform = "";
    ghost.classList.add("hidden");
  }
}

function triggerHapticFeedback() {
  if (!navigator.vibrate) return;
  navigator.vibrate(14);
}

function fireLoveCelebration(anchorEl) {
  if (typeof window.confetti !== "function") return;
  const rect = anchorEl && anchorEl.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
  const originX = rect ? Math.min(0.96, Math.max(0.04, (rect.left + rect.width / 2) / window.innerWidth)) : 0.86;
  const originY = rect ? Math.min(0.96, Math.max(0.04, rect.top / window.innerHeight)) : 0.78;
  window.confetti({
    particleCount: 70,
    spread: 62,
    startVelocity: 32,
    ticks: 140,
    scalar: 0.92,
    origin: { x: originX, y: originY },
    colors: ["#ff7f6e", "#f7d8ea", "#ffd8b1", "#ffffff"],
  });
}

function setSwipePreviewTransform(dx, direction, width, dragging, durationMs = 180) {
  const main = $("calendarMainSurface");
  const ghost = $("calendarGhost");
  if (!main || !ghost) return;
  main.style.transition = dragging ? "none" : `transform ${durationMs}ms ease`;
  ghost.style.transition = dragging ? "none" : `transform ${durationMs}ms ease`;
  ghost.classList.remove("hidden");
  main.style.transform = `translateX(${dx}px)`;
  ghost.style.transform = `translateX(${dx + direction * width}px)`;
}

function monthDiff(fromDate, toDate) {
  return (toDate.getFullYear() - fromDate.getFullYear()) * 12 + (toDate.getMonth() - fromDate.getMonth());
}

function animateMonthStep(direction, durationMs = 170) {
  return new Promise((resolve) => {
    if (state.monthAnimating) {
      resolve(false);
      return;
    }
    const main = $("calendarMainSurface");
    const grid = $("calendarGrid");
    if (!main || !grid || (direction !== 1 && direction !== -1)) {
      resolve(false);
      return;
    }

    state.monthAnimating = true;
    const width = main.clientWidth || grid.clientWidth || 1;
    const targetDx = direction === 1 ? -width : width;
    const nextMonth = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth() + direction, 1);

    renderGhostCalendar(nextMonth);
    setSwipePreviewTransform(0, direction, width, true);

    window.requestAnimationFrame(() => {
      setSwipePreviewTransform(targetDx, direction, width, false, durationMs);
      window.setTimeout(() => {
        state.monthCursor = nextMonth;
        resetSwipePreview(true);
        renderCalendar();
        state.monthAnimating = false;
        resolve(true);
      }, durationMs);
    });
  });
}

async function animateToMonth(targetMonth) {
  const current = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth(), 1);
  const target = new Date(targetMonth.getFullYear(), targetMonth.getMonth(), 1);
  const diff = monthDiff(current, target);
  if (diff === 0 || state.monthAnimating) return;
  const direction = diff > 0 ? 1 : -1;
  const main = $("calendarMainSurface");
  const grid = $("calendarGrid");
  if (!main || !grid) return;

  state.monthAnimating = true;
  const width = main.clientWidth || grid.clientWidth || 1;
  const duration = Math.min(360, 190 + Math.abs(diff) * 18);

  renderGhostCalendar(target);
  setSwipePreviewTransform(0, direction, width, true);

  window.requestAnimationFrame(() => {
    const targetDx = direction === 1 ? -width : width;
    setSwipePreviewTransform(targetDx, direction, width, false, duration);
    window.setTimeout(() => {
      state.monthCursor = target;
      resetSwipePreview(true);
      renderCalendar();
      state.monthAnimating = false;
    }, duration);
  });
}

function getDateCellFromPointEvent(e) {
  let target = e.target;
  if (!(target instanceof HTMLElement) || !target.closest(".cell[data-date]")) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!(el instanceof HTMLElement)) return null;
    target = el;
  }
  return target.closest(".cell[data-date]");
}

function openDeleteModal(index) {
  const modal = $("deleteModal");
  if (!modal || !state.records[index]) return;
  state.pendingDeleteRecordIndex = index;
  const rec = state.records[index];
  const text = $("deleteModalText");
  if (text) text.textContent = `${fmtDate(rec.startDate)} 기록을 삭제할까요?`;
  modal.classList.remove("hidden");
}

function closeDeleteModal() {
  const modal = $("deleteModal");
  if (!modal) return;
  modal.classList.add("hidden");
  state.pendingDeleteRecordIndex = null;
}

function getOpenEndedRecordIndex() {
  return state.records.findIndex((r) => !r.endDate);
}

function hasLaterRecordThan(dateIso, excludeIndex) {
  return state.records.some((r, idx) => idx !== excludeIndex && r.startDate > dateIso);
}

function getPredictedStartDates() {
  const out = [];
  const first = predictNextStartDate();
  if (!first) return out;
  let cur = toDateOnly(first);
  const adaptive = getAdaptiveAverages(state.records, state.settings);
  const cycleLength = Number(adaptive.cycleLength);
  for (let i = 0; i < 12; i += 1) {
    out.push(iso(cur));
    cur = addDays(cur, cycleLength);
  }
  return out;
}

function findNextStartDate(dateIso) {
  const starts = [];
  state.records.forEach((r) => starts.push(r.startDate));
  getPredictedStartDates().forEach((d) => starts.push(d));
  const uniqueSorted = Array.from(new Set(starts)).sort((a, b) => a.localeCompare(b));
  return uniqueSorted.find((d) => d > dateIso) || null;
}

function openActionModal(dateIso, recordIndex) {
  const modal = $("actionModal");
  if (!modal) return;

  state.pendingActionDate = dateIso;
  state.pendingActionRecordIndex = Number.isInteger(recordIndex) ? recordIndex : null;
  state.pendingActionNextStartDate = findNextStartDate(dateIso);
  const range = $("actionModalRange");

  const startBtn = $("actionStartBtn");
  const endBtn = $("actionEndBtn");
  const deleteBtn = $("actionDeleteBtn");
  const reopenBtn = $("actionReopenBtn");
  const loveRow = $("actionLoveRow");
  const pmsBtn = $("actionPmsBtn");
  const isActualDate = state.pendingActionRecordIndex !== null && state.pendingActionRecordIndex >= 0;
  const isFuture = isFutureDate(dateIso);
  const setActionButton = (btn, text, enabled, order, isEdit) => {
    if (!btn) return;
    btn.style.display = "block";
    btn.textContent = text;
    btn.disabled = !enabled;
    if (btn.id === "actionStartBtn" || btn.id === "actionEndBtn") {
      btn.style.order = "";
    } else {
      btn.style.order = String(order);
    }
    if (isEdit) btn.classList.add("btn-edit");
    else btn.classList.remove("btn-edit");
  };
  if (endBtn) {
    endBtn.dataset.actionRole = "end";
    endBtn.classList.remove("pms-inline");
    endBtn.style.gridColumn = "";
    endBtn.style.order = "";
  }
  if (startBtn) {
    startBtn.style.order = "";
    startBtn.style.gridColumn = "";
  }

  if (isActualDate) {
    const rec = state.records[state.pendingActionRecordIndex];
    const isStartDate = !!(rec && rec.startDate === dateIso);
    const isEndDate = !!(rec && rec.endDate && rec.endDate === dateIso);
    const isOngoing = !!(rec && !rec.endDate);
    const hasLater = !!(rec && rec.endDate && hasLaterRecordThan(rec.endDate, state.pendingActionRecordIndex));
    const canEditStart = !!(rec && !isFuture && !isEndDate && !isStartDate);
    setActionButton(startBtn, "시작", canEditStart, 6, canEditStart);

    const canAddEnd = !!(rec && isOngoing && !isFuture);
    const isOneDayRecord = !!(rec && isStartDate && isEndDate);
    const canEditEnd = !!(rec && !isOngoing && !isFuture && !(isEndDate && !isStartDate) && !isOneDayRecord);
    const canSameDayEndAtEndDate = !!(rec && isEndDate && !isStartDate && !isFuture && hasLater);
    let endLabel = "종료";
    let endEnabled = false;
    let endOrder = 7;
    let endEdit = false;
    const oneDayLabel = "✓ 딱 하루만 월경했어요";
    if (canAddEnd) {
      endLabel = isStartDate ? oneDayLabel : "✓ 종료";
      endEnabled = true;
      endOrder = 2;
    } else if (canSameDayEndAtEndDate) {
      endLabel = oneDayLabel;
      endEnabled = true;
      endOrder = 2;
      if (endBtn) endBtn.dataset.actionRole = "same-day-end";
    } else if (canEditEnd) {
      endLabel = isStartDate ? oneDayLabel : "종료";
      endEnabled = true;
      endEdit = !isStartDate;
    }
    setActionButton(endBtn, endLabel, endEnabled, endOrder, endEdit);
    if (endLabel === oneDayLabel && startBtn) {
      startBtn.style.display = "none";
      if (endBtn) endBtn.style.gridColumn = "1 / -1";
    } else if (endBtn) {
      endBtn.style.gridColumn = "";
    }
    if (startBtn && endBtn && startBtn.disabled && endBtn.disabled) {
      startBtn.style.display = "none";
      endBtn.style.display = "none";
    }

    if (range && rec) {
      let endIso = rec.endDate || todayIso();
      if (isOngoing) {
        const adaptive = getAdaptiveAverages(state.records, state.settings);
        const periodLength = Math.max(1, Number(adaptive.periodLength) || 5);
        const startedAt = toDateOnly(rec.startDate).getTime();
        const todayAt = toDateOnly(todayIso()).getTime();
        const elapsedDays = Math.max(1, Math.floor((todayAt - startedAt) / 86400000) + 1);
        const remainingDays = Math.max(0, periodLength - elapsedDays);
        endIso = iso(addDays(toDateOnly(todayIso()), remainingDays));
      }
      const rangePrefix = isOngoing ? "월경 중 · " : "월경 · ";
      range.textContent = `${rangePrefix}${fmtMonthDay(rec.startDate)} - ${fmtMonthDay(endIso)}`;
      range.classList.add("period-range");
      range.classList.remove("hidden");
    }
    if (deleteBtn) {
      deleteBtn.style.display = "block";
      deleteBtn.disabled = false;
    }
    if (reopenBtn) {
      reopenBtn.style.display = isEndDate && !hasLater ? "block" : "none";
      reopenBtn.style.order = "4";
    }
    if (isEndDate && !hasLater) {
      if (startBtn && startBtn.disabled) startBtn.style.display = "none";
      if (endBtn && endBtn.disabled) endBtn.style.display = "none";
    }
    if (loveRow) {
      loveRow.disabled = isFuture;
      loveRow.setAttribute("aria-pressed", state.settings.loveDates?.includes(dateIso) ? "true" : "false");
    }
    if (pmsBtn) {
      pmsBtn.style.display = "none";
      pmsBtn.textContent = "PMS 시작";
      pmsBtn.style.order = "5";
    }
  } else {
    const openIdx = getOpenEndedRecordIndex();
    const canEnd = openIdx !== -1 && dateIso >= state.records[openIdx].startDate;
    const startEnabled = !isFuture && !canEnd;
    const startLabel = startEnabled ? "+ 월경 시작" : "시작";
    setActionButton(startBtn, startLabel, startEnabled, 1, false);

    const endEnabled = !isFuture && canEnd;
    const endLabel = endEnabled ? "✓ 종료" : "종료";
    setActionButton(endBtn, endLabel, endEnabled, 2, false);
    if (startBtn && endBtn && startBtn.disabled && endBtn.disabled) {
      startBtn.style.display = "none";
      endBtn.style.display = "none";
    }

    if (range) {
      range.textContent = fmtMonthDay(dateIso);
      range.classList.remove("period-range");
      range.classList.remove("hidden");
    }
    if (deleteBtn) {
      deleteBtn.style.display = "none";
      deleteBtn.disabled = true;
    }
    if (reopenBtn) {
      reopenBtn.style.display = "none";
      reopenBtn.style.order = "4";
    }
    if (loveRow) {
      loveRow.disabled = isFuture;
      loveRow.setAttribute("aria-pressed", state.settings.loveDates?.includes(dateIso) ? "true" : "false");
    }
    const canInlinePms = !isFuture && !canEnd && !!state.pendingActionNextStartDate;
    if (canInlinePms && endBtn) {
      setActionButton(endBtn, "PMS 시작", true, 2, false);
      endBtn.dataset.actionRole = "pms";
      endBtn.classList.add("pms-inline");
      if (startBtn) {
        startBtn.style.order = "1";
        startBtn.style.gridColumn = "1 / -1";
      }
      endBtn.style.order = "2";
      endBtn.style.gridColumn = "1 / -1";
    }
    if (pmsBtn) {
      pmsBtn.style.display = canInlinePms ? "none" : !isFuture && state.pendingActionNextStartDate ? "block" : "none";
      pmsBtn.textContent = "PMS 시작";
      pmsBtn.style.order = "5";
    }
  }

  resetActionSheetDragStyles();
  modal.classList.remove("hidden");
  const sheet = modal.querySelector(".modal-sheet");
  if (sheet) {
    const rise = Math.max(26, Math.round(sheet.clientHeight * 0.08));
    sheet.style.transition = "none";
    modal.style.transition = "none";
    sheet.style.transform = `translateY(${rise}px)`;
    sheet.style.opacity = "0.98";
    modal.style.background = "rgba(16, 18, 22, 0)";
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        sheet.style.transition = "transform 260ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 220ms ease";
        modal.style.transition = "background 260ms ease";
        sheet.style.transform = "translateY(0)";
        sheet.style.opacity = "1";
        modal.style.background = "rgba(16, 18, 22, 0.35)";
      });
    });
  }
}

function closeActionModal() {
  const modal = $("actionModal");
  if (!modal) return;
  modal.classList.add("hidden");
  resetActionSheetDragStyles();
  state.pendingActionDate = null;
  state.pendingActionRecordIndex = null;
  state.pendingActionNextStartDate = null;
}

function closeActionModalAnimated() {
  const modal = $("actionModal");
  const sheet = modal ? modal.querySelector(".modal-sheet") : null;
  if (!modal || !sheet || modal.classList.contains("hidden")) return;
  sheet.style.transition = "transform 240ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 180ms ease";
  modal.style.transition = "background 240ms ease";
  sheet.style.transform = `translateY(${sheet.clientHeight + 40}px)`;
  sheet.style.opacity = "0.98";
  modal.style.background = "rgba(16, 18, 22, 0)";
  window.setTimeout(() => {
    closeActionModal();
  }, 250);
}

function openAuthModal() {
  const modal = $("authModal");
  if (!modal) return;
  setAuthStatus("");
  if (backend.coupleId && backend.role === "owner") {
    if ($("createdCodeInput")) $("createdCodeInput").value = backend.inviteCode || "";
    showAuthPane("createDone");
  } else if (backend.coupleId && backend.role === "member") {
    if ($("partnerNicknameText")) $("partnerNicknameText").textContent = backend.ownerNickname || "상대방";
    showAuthPane("joinDone");
  } else {
    showAuthPane("entry");
  }
  modal.classList.remove("hidden");
  if (backend.coupleId && !backend.role) {
    refreshCoupleMeta().then(() => {
      if (backend.role === "owner") {
        if ($("createdCodeInput")) $("createdCodeInput").value = backend.inviteCode || "";
        showAuthPane("createDone");
      } else if (backend.role === "member") {
        if ($("partnerNicknameText")) $("partnerNicknameText").textContent = backend.ownerNickname || "상대방";
        showAuthPane("joinDone");
      }
    });
  }
}

function closeAuthModal() {
  const modal = $("authModal");
  if (!modal) return;
  modal.classList.add("hidden");
  resetAuthSheetDragStyles();
}

function showAuthPane(mode) {
  const ids = ["authEntryRow", "createFlow", "createDoneFlow", "joinFlow", "joinDoneFlow"];
  ids.forEach((id) => {
    const el = $(id);
    if (!el) return;
    const show =
      (mode === "entry" && id === "authEntryRow") ||
      (mode === "create" && id === "createFlow") ||
      (mode === "createDone" && id === "createDoneFlow") ||
      (mode === "join" && id === "joinFlow") ||
      (mode === "joinDone" && id === "joinDoneFlow");
    el.classList.toggle("hidden", !show);
  });
  const backBtn = $("authBackBtn");
  if (backBtn) backBtn.classList.toggle("hidden", mode === "entry" || mode === "createDone" || mode === "joinDone");
}

function closeAuthModalAnimated() {
  const modal = $("authModal");
  const sheet = modal ? modal.querySelector(".modal-sheet") : null;
  if (!modal || !sheet || modal.classList.contains("hidden")) return;
  sheet.style.transition = "transform 240ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 180ms ease";
  modal.style.transition = "background 240ms ease";
  sheet.style.transform = `translateY(${sheet.clientHeight + 40}px)`;
  sheet.style.opacity = "0.98";
  modal.style.background = "rgba(16, 18, 22, 0)";
  window.setTimeout(() => {
    closeAuthModal();
  }, 250);
}

function resetAuthSheetDragStyles() {
  const modal = $("authModal");
  const sheet = modal ? modal.querySelector(".modal-sheet") : null;
  if (!modal || !sheet) return;
  sheet.style.transform = "";
  sheet.style.transition = "";
  sheet.style.opacity = "";
  modal.style.background = "";
  modal.style.transition = "";
}

function initAuthSheetDragClose() {
  const modal = $("authModal");
  const handle = $("authSheetHandle");
  const sheet = modal ? modal.querySelector(".modal-sheet") : null;
  if (!modal || !handle || !sheet) return;

  let dragging = false;
  let activePointerId = null;
  let startY = 0;
  let offsetY = 0;

  const getBackdrop = (dy) => {
    const max = Math.max(sheet.clientHeight * 0.8, 1);
    const alpha = Math.max(0, 0.35 * (1 - dy / max));
    return `rgba(16, 18, 22, ${alpha})`;
  };

  handle.addEventListener("pointerdown", (e) => {
    if (modal.classList.contains("hidden")) return;
    dragging = true;
    activePointerId = e.pointerId;
    startY = e.clientY;
    offsetY = 0;
    sheet.style.transition = "none";
    modal.style.transition = "none";
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (_e) {}
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== activePointerId) return;
    offsetY = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${offsetY}px)`;
    modal.style.background = getBackdrop(offsetY);
  });

  const finish = (e) => {
    if (!dragging || e.pointerId !== activePointerId) return;
    dragging = false;
    activePointerId = null;
    if (offsetY > Math.max(56, sheet.clientHeight * 0.16)) {
      closeAuthModalAnimated();
    } else {
      sheet.style.transition = "transform 180ms ease, opacity 180ms ease";
      modal.style.transition = "background 180ms ease";
      sheet.style.transform = "translateY(0)";
      sheet.style.opacity = "1";
      modal.style.background = "rgba(16, 18, 22, 0.35)";
      window.setTimeout(() => {
        resetAuthSheetDragStyles();
      }, 190);
    }
  };

  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

async function ensureAnonymousSession() {
  if (!backend.client) return;
  if (backend.user) return;
  const { data, error } = await backend.client.auth.signInAnonymously();
  if (!error) backend.user = data?.user || null;
}

async function createCoupleByFlow() {
  if (!backend.client) return;
  await ensureAnonymousSession();
  if (!backend.user) {
    setAuthStatus("연결 세션 생성에 실패했어요.");
    return;
  }
  const nickname = ($("createNicknameInput")?.value || "").trim();
  const pin = ($("createPinInput")?.value || "").trim();
  if (!nickname) return setAuthStatus("닉네임을 입력해 주세요.");
  if (!/^[0-9]{6}$/.test(pin)) return setAuthStatus("비밀번호는 숫자 6자리여야 해요.");

  let invite = randomCode(6);
  let tries = 0;
  let firstErrorMessage = "";
  while (tries < 3) {
    const { data, error } = await backend.client
      .from("couples")
      .insert({ owner_user_id: backend.user.id, invite_code: invite, owner_nickname: nickname, owner_pin: pin })
      .select("id, invite_code")
      .maybeSingle();
    if (!error && data?.id) {
      backend.coupleId = data.id;
      backend.role = "owner";
      backend.inviteCode = data.invite_code || "";
      backend.ownerNickname = nickname;
      persistCoupleMeta();
      await backend.client.from("couple_members").upsert({ couple_id: data.id, user_id: backend.user.id, role: "owner" });
      await pushRemoteState();
      subscribeRemoteChanges();
      if ($("createdCodeInput")) $("createdCodeInput").value = data.invite_code || "";
      setSyncStatus("커플 동기화 연결됨");
      setAuthStatus("");
      showAuthPane("createDone");
      return;
    }
    if (error && tries === 0) firstErrorMessage = error.message || "";
    invite = randomCode(6);
    tries += 1;
  }
  if (firstErrorMessage) setAuthStatus(`코드 생성 실패: ${firstErrorMessage}`);
  else setAuthStatus("코드 생성 실패. 잠시 후 다시 시도해 주세요.");
}

async function joinCoupleByFlow() {
  if (!backend.client) return;
  await ensureAnonymousSession();
  if (!backend.user) return setAuthStatus("연결 세션 생성에 실패했어요.");
  const code = ($("joinCodeInput")?.value || "").trim().toUpperCase();
  if (!code) return setAuthStatus("초대 코드를 입력해 주세요.");

  const { data, error } = await backend.client
    .from("couples")
    .select("id, owner_nickname")
    .eq("invite_code", code)
    .maybeSingle();
  if (error || !data?.id) return setAuthStatus("유효한 초대 코드를 찾지 못했어요.");

  const { error: memberError } = await backend.client
    .from("couple_members")
    .upsert({ couple_id: data.id, user_id: backend.user.id, role: "member" });
  if (memberError) return setAuthStatus(`연결 실패: ${memberError.message}`);

  backend.coupleId = data.id;
  backend.role = "member";
  backend.inviteCode = code;
  backend.ownerNickname = data.owner_nickname || "";
  persistCoupleMeta();
  await pullRemoteState();
  await pushRemoteState();
  subscribeRemoteChanges();
  if ($("partnerNicknameText")) $("partnerNicknameText").textContent = data.owner_nickname || "상대방";
  setSyncStatus("커플 동기화 연결됨");
  setAuthStatus("");
  showAuthPane("joinDone");
}

async function copyCreatedCode() {
  const code = ($("createdCodeInput")?.value || "").trim();
  if (!code) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(code);
      setAuthStatus("코드가 복사됐어요.");
      return;
    }
    throw new Error("clipboard_unavailable");
  } catch (_e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) {
        setAuthStatus("코드가 복사됐어요.");
      } else {
        setAuthStatus("복사에 실패했어요. 코드를 길게 눌러 복사해 주세요.");
      }
    } catch (_e2) {
      setAuthStatus("복사에 실패했어요. 코드를 길게 눌러 복사해 주세요.");
    }
  }
}

function resetActionSheetDragStyles() {
  const modal = $("actionModal");
  const sheet = modal ? modal.querySelector(".modal-sheet") : null;
  if (!modal || !sheet) return;
  sheet.style.transform = "";
  sheet.style.transition = "";
  sheet.style.opacity = "";
  modal.style.background = "";
  modal.style.transition = "";
}

function initActionSheetDragClose() {
  const modal = $("actionModal");
  const handle = $("actionSheetHandle");
  const sheet = modal ? modal.querySelector(".modal-sheet") : null;
  if (!modal || !handle || !sheet) return;
  const dragZone = modal.querySelector(".action-sheet");
  if (!dragZone) return;

  let dragging = false;
  let activePointerId = null;
  let activeTouchId = null;
  let startY = 0;
  let offsetY = 0;

  const getBackdrop = (dy) => {
    const max = Math.max(sheet.clientHeight * 0.8, 1);
    const alpha = Math.max(0, 0.35 * (1 - dy / max));
    return `rgba(16, 18, 22, ${alpha})`;
  };

  const startDrag = (clientY) => {
    if (modal.classList.contains("hidden")) return;
    dragging = true;
    startY = clientY;
    offsetY = 0;
    sheet.style.transition = "none";
    modal.style.transition = "none";
  };

  const moveDrag = (clientY) => {
    if (!dragging) return;
    offsetY = Math.max(0, clientY - startY);
    sheet.style.transform = `translateY(${offsetY}px)`;
    modal.style.background = getBackdrop(offsetY);
  };

  const finishDrag = () => {
    if (!dragging) return;
    dragging = false;
    activePointerId = null;
    activeTouchId = null;
    const threshold = Math.max(96, sheet.clientHeight * 0.24);
    const shouldClose = offsetY > threshold;
    if (shouldClose) {
      closeActionModalAnimated();
      return;
    }
    sheet.style.transition = "transform 180ms ease";
    sheet.style.transform = "translateY(0)";
    modal.style.transition = "background 180ms ease";
    modal.style.background = "rgba(16, 18, 22, 0.35)";
    window.setTimeout(() => {
      resetActionSheetDragStyles();
    }, 190);
  };

  dragZone.addEventListener("pointerdown", (e) => {
    if (!(e.target instanceof HTMLElement)) return;
    const interactive = e.target.closest(".sheet-list, .sheet-footer, button");
    if (interactive) return;
    activePointerId = e.pointerId;
    startDrag(e.clientY);
    dragZone.setPointerCapture(e.pointerId);
  });

  dragZone.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== activePointerId) return;
    moveDrag(e.clientY);
  });

  dragZone.addEventListener("pointerup", (e) => {
    if (e.pointerId !== activePointerId) return;
    finishDrag();
  });

  dragZone.addEventListener("pointercancel", (e) => {
    if (e.pointerId !== activePointerId) return;
    finishDrag();
  });

  dragZone.addEventListener(
    "touchstart",
    (e) => {
      if (!(e.target instanceof HTMLElement)) return;
      const interactive = e.target.closest(".sheet-list, .sheet-footer, button");
      if (interactive) return;
      if (modal.classList.contains("hidden") || !e.touches.length) return;
      const t = e.touches[0];
      activeTouchId = t.identifier;
      startDrag(t.clientY);
    },
    { passive: true }
  );

  dragZone.addEventListener(
    "touchmove",
    (e) => {
      if (!dragging || activeTouchId === null) return;
      const t = Array.from(e.touches).find((x) => x.identifier === activeTouchId);
      if (!t) return;
      moveDrag(t.clientY);
      e.preventDefault();
    },
    { passive: false }
  );

  dragZone.addEventListener(
    "touchend",
    (e) => {
      if (activeTouchId === null) return;
      const ended = Array.from(e.changedTouches).some((x) => x.identifier === activeTouchId);
      if (ended) finishDrag();
    },
    { passive: true }
  );
}

function getGestureModeFromCell(cell, clientX) {
  const date = cell.dataset.date;
  const recordIndex = date ? findRecordContainingDate(date) : -1;
  const markerType = cell.dataset.markerType;
  const markerCycle = Number(cell.dataset.markerCycle || "-1");
  if (recordIndex === -1) {
    if (markerType === "pms" && cell.classList.contains("pms-start")) {
      return { mode: "resize-pms-start", recordIndex: null, startDate: date || null };
    }
    return { mode: "create", recordIndex: null, startDate: date || null };
  }

  const record = state.records[recordIndex];
  const effectiveEnd = getRecordEndDate(record);
  const isStart = record.startDate === date;
  const isEnd = effectiveEnd === date;

  if (isStart && isEnd) {
    const rect = cell.getBoundingClientRect();
    const inLeftHalf = clientX <= rect.left + rect.width / 2;
    return { mode: inLeftHalf ? "resize-start" : "resize-end", recordIndex, startDate: record.startDate };
  }

  if (isStart) return { mode: "resize-start", recordIndex, startDate: record.startDate };
  if (isEnd) return { mode: "resize-end", recordIndex, startDate: record.startDate };
  return { mode: "resize-range", recordIndex, startDate: date || null };
}

function finalizeResizePmsStartGesture() {
  if (!state.gesture.startDate || !state.gesture.currentDate) return;
  const nextStart = findNextStartDate(state.gesture.startDate);
  if (!nextStart) return;
  const pmsEnd = iso(addDays(toDateOnly(nextStart), -1));
  const clamped = state.gesture.currentDate > pmsEnd ? pmsEnd : state.gesture.currentDate;
  if (isFutureDate(clamped)) {
    alert("오늘 이후 날짜에는 PMS 시작을 설정할 수 없어요.");
    return;
  }
  if (!state.settings.pmsStartOverrides) state.settings.pmsStartOverrides = {};
  state.settings.pmsStartOverrides[nextStart] = clamped;
  saveSettings();
}

function finalizeCreateGesture() {
  if (!state.gesture.startDate || !state.gesture.currentDate) return;
  let startDate = state.gesture.startDate;
  let endDate = state.gesture.currentDate;

  if (startDate === endDate) {
    if (isFutureDate(startDate)) {
      alert("오늘 이후 날짜에는 월경일정을 기록할 수 없어요.");
      return;
    }
    if (hasRangeOverlap(startDate, endDate)) {
      alert("이미 기록된 기간과 겹쳐요.");
      return;
    }
    state.records.push({ startDate, endDate });
    sortRecords();
    saveRecords();
    return;
  }

  [startDate, endDate] = orderedDates(startDate, endDate);
  if (isFutureDate(startDate) || isFutureDate(endDate)) {
    alert("오늘 이후 날짜에는 월경일정을 기록할 수 없어요.");
    return;
  }

  if (hasRangeOverlap(startDate, endDate)) {
    alert("이미 기록된 기간과 겹쳐요.");
    return;
  }

  state.records.push({ startDate, endDate });
  sortRecords();
  saveRecords();
}

function createOpenEndedStartRecord(startDate) {
  if (isFutureDate(startDate)) {
    alert("오늘 이후 날짜에는 월경시작을 기록할 수 없어요.");
    return false;
  }
  if (getOpenEndedRecordIndex() !== -1) {
    alert("아직 월경끝이 없는 기록이 있어요. 먼저 월경끝을 지정해 주세요.");
    return false;
  }
  const untilToday = iso(new Date());
  if (hasRangeOverlap(startDate, untilToday)) {
    alert("이미 기록된 기간과 겹쳐요.");
    return false;
  }
  state.records.push({ startDate, endDate: null });
  sortRecords();
  saveRecords();
  return true;
}

function finalizeResizePmsEndGesture() {
  // PMS end is locked to period start; no direct resize.
}

function setPmsStartByAction() {
  const clicked = state.pendingActionDate;
  const nextStart = state.pendingActionNextStartDate;
  if (!clicked || !nextStart) return;
  if (isFutureDate(clicked)) {
    alert("오늘 이후 날짜에는 PMS 시작을 설정할 수 없어요.");
    return;
  }
  const pmsEnd = iso(addDays(toDateOnly(nextStart), -1));
  const clamped = clicked > pmsEnd ? pmsEnd : clicked;
  if (!state.settings.pmsStartOverrides) state.settings.pmsStartOverrides = {};
  state.settings.pmsStartOverrides[nextStart] = clamped;
  saveSettings();
}

function finalizeResizeEndGesture() {
  const idx = state.gesture.recordIndex;
  if (idx === null || !state.records[idx] || !state.gesture.currentDate) return;

  const record = state.records[idx];
  const previous = { ...record };
  if (isFutureDate(state.gesture.currentDate)) {
    alert("오늘 이후 날짜에는 월경끝을 설정할 수 없어요.");
    return;
  }
  record.endDate = state.gesture.currentDate < record.startDate ? record.startDate : state.gesture.currentDate;

  if (hasRangeOverlapExcludingIndex(record.startDate, record.endDate, idx)) {
    state.records[idx] = previous;
    alert("다른 기록과 겹쳐서 종료일을 조정할 수 없어요.");
    return;
  }

  sortRecords();
  saveRecords();
}

function finalizeResizeStartGesture() {
  const idx = state.gesture.recordIndex;
  if (idx === null || !state.records[idx] || !state.gesture.currentDate) return;

  const record = state.records[idx];
  const previous = { ...record };
  const oldStart = record.startDate;
  if (isFutureDate(state.gesture.currentDate)) {
    alert("오늘 이후 날짜에는 월경시작을 설정할 수 없어요.");
    return;
  }
  const effectiveEnd = getRecordEndDate(record);
  record.startDate = state.gesture.currentDate > effectiveEnd ? effectiveEnd : state.gesture.currentDate;

  if (hasRangeOverlapExcludingIndex(record.startDate, getRecordEndDate(record), idx)) {
    state.records[idx] = previous;
    alert("다른 기록과 겹쳐서 시작일을 조정할 수 없어요.");
    return;
  }

  movePmsOverrideKey(oldStart, record.startDate);
  sortRecords();
  saveRecords();
  saveSettings();
}

function finalizeResizeRangeGesture() {
  const idx = state.gesture.recordIndex;
  if (idx === null || !state.records[idx] || !state.gesture.startDate || !state.gesture.currentDate) return;

  const record = state.records[idx];
  const previous = { ...record };
  const oldStart = record.startDate;
  const [newStart, newEnd] = orderedDates(state.gesture.startDate, state.gesture.currentDate);
  if (isFutureDate(newStart) || isFutureDate(newEnd)) {
    alert("오늘 이후 날짜에는 월경기간을 설정할 수 없어요.");
    return;
  }

  record.startDate = newStart;
  record.endDate = newEnd;

  if (hasRangeOverlapExcludingIndex(record.startDate, record.endDate, idx)) {
    state.records[idx] = previous;
    alert("다른 기록과 겹쳐서 기간을 조정할 수 없어요.");
    return;
  }

  movePmsOverrideKey(oldStart, record.startDate);
  sortRecords();
  saveRecords();
  saveSettings();
}

function createStartByAction(dateIso) {
  if (!dateIso) return;
  if (isFutureDate(dateIso)) {
    alert("오늘 이후 날짜에는 월경시작을 설정할 수 없어요.");
    return;
  }
  const idx = state.pendingActionRecordIndex;
  if (idx !== null && idx >= 0 && state.records[idx]) {
    const record = state.records[idx];
    const previous = { ...record };
    const oldStart = record.startDate;
    const effectiveEnd = getRecordEndDate(record);
    record.startDate = dateIso > effectiveEnd ? effectiveEnd : dateIso;
    if (hasRangeOverlapExcludingIndex(record.startDate, getRecordEndDate(record), idx)) {
      state.records[idx] = previous;
      alert("다른 기록과 겹쳐서 시작일을 조정할 수 없어요.");
      return;
    }
    movePmsOverrideKey(oldStart, record.startDate);
    sortRecords();
    saveRecords();
    saveSettings();
    return;
  }

  const nextIdx = findNearestNextRecordIndex(dateIso);
  if (nextIdx === -1) {
    // No later record: this should be an ongoing period (no end date yet).
    createOpenEndedStartRecord(dateIso);
    return;
  }

  createPastPeriodRecordFromStart(dateIso);
}

function findNearestNextRecordIndex(dateIso) {
  let bestIdx = -1;
  let bestStart = null;
  state.records.forEach((r, idx) => {
    if (r.startDate > dateIso && (bestStart === null || r.startDate < bestStart)) {
      bestStart = r.startDate;
      bestIdx = idx;
    }
  });
  return bestIdx;
}

function createPastPeriodRecordFromStart(startDate) {
  const adaptive = getAdaptiveAverages(state.records, state.settings);
  const periodLength = Number(adaptive.periodLength) || 5;
  let endDate = iso(addDays(toDateOnly(startDate), periodLength - 1));

  const nextIdx = findNearestNextRecordIndex(startDate);
  if (nextIdx !== -1) {
    const nextStart = state.records[nextIdx].startDate;
    if (endDate >= nextStart) {
      endDate = iso(addDays(toDateOnly(nextStart), -1));
    }
  }

  if (endDate < startDate) {
    alert("직후 월경시작과 너무 가까워 새 월경를 추가할 수 없어요.");
    return;
  }

  if (hasRangeOverlap(startDate, endDate)) {
    alert("기존 월경일정과 겹쳐서 추가할 수 없어요.");
    return;
  }

  state.records.push({ startDate, endDate });
  sortRecords();
  saveRecords();
}

function createEndByAction(dateIso) {
  if (!dateIso) return;
  if (isFutureDate(dateIso)) {
    alert("오늘 이후 날짜에는 월경끝을 설정할 수 없어요.");
    return;
  }
  const selectedIdx = state.pendingActionRecordIndex;
  const idx = selectedIdx !== null && selectedIdx >= 0 ? selectedIdx : getOpenEndedRecordIndex();
  if (idx === -1) {
    alert("월경끝을 지정할 시작 기록이 없어요.");
    return;
  }
  const record = state.records[idx];
  const targetEnd = dateIso < record.startDate ? record.startDate : dateIso;
  const previous = { ...record };
  record.endDate = targetEnd;
  if (hasRangeOverlapExcludingIndex(record.startDate, record.endDate, idx)) {
    state.records[idx] = previous;
    alert("다른 기록과 겹쳐서 월경끝을 지정할 수 없어요.");
    return;
  }
  sortRecords();
  saveRecords();
}

function deleteByAction() {
  const idx = state.pendingActionRecordIndex;
  if (idx === null || idx < 0 || !state.records[idx]) return;
  state.records.splice(idx, 1);
  saveRecords();
}

function reopenByAction() {
  const idx = state.pendingActionRecordIndex;
  const dateIso = state.pendingActionDate;
  if (idx === null || idx < 0 || !state.records[idx] || !dateIso) return;
  const rec = state.records[idx];
  if (!rec.endDate || rec.endDate !== dateIso) return;
  rec.endDate = null;
  sortRecords();
  saveRecords();
}

function recordLoveByAction() {
  if (!state.pendingActionDate) return;
  return toggleLoveDate(state.pendingActionDate);
}

function resetGesture() {
  if (state.gesture.pressTimer) {
    clearTimeout(state.gesture.pressTimer);
    state.gesture.pressTimer = null;
  }
  state.gesture.mode = null;
  state.gesture.pointerId = null;
  state.gesture.startDate = null;
  state.gesture.currentDate = null;
  state.gesture.recordIndex = null;
  state.gesture.startX = 0;
  state.gesture.startY = 0;
  state.gesture.swipeDx = 0;
  state.gesture.swipeDirection = 0;
  state.gesture.swipeHandled = false;
  state.gesture.moved = false;
  state.gesture.active = false;
}

function bindCalendarGestures() {
  const grid = $("calendarGrid");
  const mainSurface = $("calendarMainSurface");
  const ghost = $("calendarGhost");
  if (!grid) return;
  const LONG_PRESS_CREATE_MS = 420;
  const LONG_PRESS_EDIT_MS = 110;
  const SWIPE_START_PX = 12;

  grid.addEventListener("pointerdown", (e) => {
    const dateCell = getDateCellFromPointEvent(e);
    if (!dateCell) return;
    e.preventDefault();

    state.gesture.pointerId = e.pointerId;
    state.gesture.currentDate = dateCell.dataset.date;
    state.gesture.startX = e.clientX;
    state.gesture.startY = e.clientY;
    state.gesture.swipeDx = 0;
    state.gesture.swipeDirection = 0;
    state.gesture.swipeHandled = false;
    state.gesture.moved = false;
    state.gesture.active = false;

    const hitMode = getGestureModeFromCell(dateCell, e.clientX);
    state.gesture.mode = hitMode.mode;
    state.gesture.recordIndex = hitMode.recordIndex;
    state.gesture.startDate = hitMode.startDate;
    const pressMs = hitMode.mode === "create" ? LONG_PRESS_CREATE_MS : LONG_PRESS_EDIT_MS;

    state.gesture.pressTimer = setTimeout(() => {
      if (!state.gesture.pointerId) return;
      resetSwipePreview();
      state.gesture.active = true;
      if (state.gesture.mode && state.gesture.mode.startsWith("resize")) {
        triggerHapticFeedback();
      }
      if (!grid.hasPointerCapture(state.gesture.pointerId)) {
        grid.setPointerCapture(state.gesture.pointerId);
      }
      renderCalendar();
    }, pressMs);
  });

  grid.addEventListener("pointermove", (e) => {
    if (!state.gesture.mode || state.gesture.pointerId !== e.pointerId) return;
    if (!state.gesture.active) {
      const dx = e.clientX - state.gesture.startX;
      const dy = e.clientY - state.gesture.startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      if (absX >= SWIPE_START_PX && absX > absY * 1.1) {
        if (state.gesture.pressTimer) {
          clearTimeout(state.gesture.pressTimer);
          state.gesture.pressTimer = null;
        }
        state.gesture.swipeHandled = true;
        state.gesture.swipeDx = dx;
        const direction = dx < 0 ? 1 : -1;
        const width = mainSurface ? mainSurface.clientWidth : grid.clientWidth;
        if (state.gesture.swipeDirection !== direction) {
          state.gesture.swipeDirection = direction;
          const adjMonth = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth() + direction, 1);
          renderGhostCalendar(adjMonth);
        }
        setSwipePreviewTransform(dx, direction, width, true);
        return;
      }
    }
    if (state.gesture.swipeHandled && !state.gesture.active) return;
    if (!state.gesture.active) return;
    const cell = getDateCellFromPointEvent(e);
    if (!cell) return;
    if (state.gesture.currentDate !== cell.dataset.date) state.gesture.moved = true;
    state.gesture.currentDate = cell.dataset.date;
    renderCalendar();
  });

  const finishGesture = (e) => {
    if (!state.gesture.mode || state.gesture.pointerId !== e.pointerId) return;
    if (state.gesture.swipeHandled && !state.gesture.active) {
      const width = mainSurface ? mainSurface.clientWidth : grid.clientWidth;
      const commitThreshold = Math.min(140, Math.max(56, width * 0.22));
      const dx = state.gesture.swipeDx;
      if (Math.abs(dx) >= commitThreshold && state.gesture.swipeDirection !== 0) {
        const targetDx = state.gesture.swipeDirection < 0 ? width : -width;
        setSwipePreviewTransform(targetDx, state.gesture.swipeDirection, width, false);
        const monthDelta = state.gesture.swipeDirection;
        window.setTimeout(() => {
          state.monthCursor = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth() + monthDelta, 1);
          resetSwipePreview(true);
          renderCalendar();
        }, 170);
      } else {
        setSwipePreviewTransform(0, state.gesture.swipeDirection || 1, width, false, 170);
        window.setTimeout(() => {
          resetSwipePreview(true);
          renderCalendar();
        }, 170);
      }
      resetGesture();
      if (grid.hasPointerCapture(e.pointerId)) grid.releasePointerCapture(e.pointerId);
      return;
    }
    const cell = getDateCellFromPointEvent(e);
    if (cell) state.gesture.currentDate = cell.dataset.date;

    if (state.gesture.active && !state.gesture.moved && state.gesture.mode === "create") {
      finalizeCreateGesture();
      state.suppressClickUntil = Date.now() + 260;
    } else if (state.gesture.active && state.gesture.moved) {
      if (state.gesture.mode === "create") finalizeCreateGesture();
      if (state.gesture.mode === "resize-end") finalizeResizeEndGesture();
      if (state.gesture.mode === "resize-start") finalizeResizeStartGesture();
      if (state.gesture.mode === "resize-range") finalizeResizeRangeGesture();
      if (state.gesture.mode === "resize-pms-start") finalizeResizePmsStartGesture();
    } else if (state.gesture.currentDate) {
      const idx = cell && cell.dataset.recordIndex !== undefined ? Number(cell.dataset.recordIndex) : null;
      openActionModal(state.gesture.currentDate, idx);
    }

    if (state.gesture.active && state.gesture.moved) state.suppressClickUntil = Date.now() + 260;

    resetGesture();
    if (grid.hasPointerCapture(e.pointerId)) grid.releasePointerCapture(e.pointerId);
    renderAll();
  };

  grid.addEventListener("pointerup", finishGesture);
  window.addEventListener("pointerup", finishGesture);
  grid.addEventListener("pointercancel", finishGesture);
  window.addEventListener("pointercancel", finishGesture);
}

function bindEvents() {
  if ($("prevMonth")) {
    $("prevMonth").addEventListener("click", () => {
      animateMonthStep(-1);
    });
  }

  if ($("nextMonth")) {
    $("nextMonth").addEventListener("click", () => {
      animateMonthStep(1);
    });
  }

  if ($("goToday")) {
    $("goToday").addEventListener("click", () => {
      animateToMonth(new Date());
    });
  }

  if ($("dashboardAddTodayBtn")) {
    $("dashboardAddTodayBtn").addEventListener("click", () => {
      const today = todayIso();
      const idx = findRecordContainingDate(today);
      openActionModal(today, idx === -1 ? null : idx);
    });
  }

  bindCalendarGestures();

  if ($("cancelDeleteBtn")) {
    $("cancelDeleteBtn").addEventListener("click", closeDeleteModal);
  }

  if ($("confirmDeleteBtn")) {
    $("confirmDeleteBtn").addEventListener("click", () => {
      const idx = state.pendingDeleteRecordIndex;
      if (idx !== null && state.records[idx]) {
        state.records.splice(idx, 1);
        saveRecords();
        renderAll();
      }
      closeDeleteModal();
    });
  }

  if ($("deleteModal")) {
    $("deleteModal").addEventListener("click", (e) => {
      if (e.target === $("deleteModal")) closeDeleteModal();
    });
  }

  if ($("actionStartBtn")) {
    $("actionStartBtn").addEventListener("click", () => {
      createStartByAction(state.pendingActionDate);
      closeActionModalAnimated();
      renderAll();
    });
  }

  if ($("actionEndBtn")) {
    $("actionEndBtn").addEventListener("click", () => {
      if ($("actionEndBtn").dataset.actionRole === "pms") {
        setPmsStartByAction();
      } else if ($("actionEndBtn").dataset.actionRole === "same-day-end") {
        createStartByAction(state.pendingActionDate);
      } else {
        createEndByAction(state.pendingActionDate);
      }
      closeActionModalAnimated();
      renderAll();
    });
  }

  if ($("actionPmsBtn")) {
    $("actionPmsBtn").addEventListener("click", () => {
      setPmsStartByAction();
      closeActionModalAnimated();
      renderAll();
    });
  }

  if ($("actionLoveRow")) {
    $("actionLoveRow").addEventListener("click", (e) => {
      e.stopPropagation();
      recordLoveByAction();
      const pressed = state.settings.loveDates?.includes(state.pendingActionDate || "") ? "true" : "false";
      $("actionLoveRow").setAttribute("aria-pressed", pressed);
      if (pressed === "true") {
        fireLoveCelebration($("actionLoveRow"));
      }
      renderCalendar();
      window.setTimeout(() => {
        closeActionModalAnimated();
      }, 180);
    });
  }

  if ($("actionDeleteBtn")) {
    $("actionDeleteBtn").addEventListener("click", () => {
      deleteByAction();
      closeActionModalAnimated();
      renderAll();
    });
  }

  if ($("actionReopenBtn")) {
    $("actionReopenBtn").addEventListener("click", () => {
      reopenByAction();
      closeActionModalAnimated();
      renderAll();
    });
  }

  if ($("actionModal")) {
    $("actionModal").addEventListener("click", (e) => {
      if (e.target === $("actionModal")) closeActionModalAnimated();
    });
  }

  if ($("connectAccountBtn")) {
    $("connectAccountBtn").addEventListener("click", () => {
      if (!hasBackendConfig()) {
        window.alert("먼저 config.js에 Supabase 설정을 넣어주세요.");
        return;
      }
      openAuthModal();
    });
  }

  if ($("entryCreateInviteBtn")) {
    $("entryCreateInviteBtn").addEventListener("click", () => {
      showAuthPane("create");
      $("createNicknameInput")?.focus();
    });
  }

  if ($("entryJoinByCodeBtn")) {
    $("entryJoinByCodeBtn").addEventListener("click", () => {
      showAuthPane("join");
      $("joinCodeInput")?.focus();
    });
  }

  if ($("createFlowNextBtn")) {
    $("createFlowNextBtn").addEventListener("click", () => {
      createCoupleByFlow();
    });
  }

  if ($("joinFlowNextBtn")) {
    $("joinFlowNextBtn").addEventListener("click", () => {
      joinCoupleByFlow();
    });
  }

  if ($("copyCreatedCodeBtn")) {
    $("copyCreatedCodeBtn").addEventListener("click", () => {
      copyCreatedCode();
    });
  }

  if ($("disconnectCoupleBtn")) {
    $("disconnectCoupleBtn").addEventListener("click", () => {
      disconnectCouple();
      showAuthPane("entry");
    });
  }

  if ($("disconnectCoupleBtnJoin")) {
    $("disconnectCoupleBtnJoin").addEventListener("click", () => {
      disconnectCouple();
      showAuthPane("entry");
    });
  }

  if ($("authBackBtn")) {
    $("authBackBtn").addEventListener("click", () => {
      showAuthPane("entry");
      setAuthStatus("");
    });
  }

  if ($("authModal")) {
    $("authModal").addEventListener("click", (e) => {
      if (e.target === $("authModal")) closeAuthModalAnimated();
    });
  }

  initActionSheetDragClose();
  initAuthSheetDragClose();

  if ($("resetDataBtn")) {
    $("resetDataBtn").addEventListener("click", () => {
      const ok = window.confirm("테스트용으로 모든 기록/설정을 삭제할까요?");
      if (!ok) return;
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(SETTINGS_KEY);
      state.records = [];
      state.settings = {
        cycleLength: 28,
        periodLength: 5,
        predictionShiftDays: 0,
        customPmsStartDate: null,
        pmsStartOverrides: {},
        loveDates: [],
      };
      closeDeleteModal();
      renderAll();
    });
  }

  // iOS Safari double-tap zoom guard
  let lastTouchEnd = 0;
  document.addEventListener(
    "touchend",
    (e) => {
      const now = Date.now();
      if (now - lastTouchEnd < 320) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false }
  );

  // pinch zoom guard
  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches && e.touches.length > 1) e.preventDefault();
    },
    { passive: false }
  );
}

function renderAll() {
  renderHomeSummary();
  renderCalendar();
  updateBottomPanelInset();
}

function updateBottomPanelInset() {
  const panel = document.querySelector(".bottom-panel");
  if (!panel) return;
  const height = Math.ceil(panel.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--bottom-panel-height", `${height}px`);
}

function init() {
  loadState();
  bindEvents();
  window.addEventListener("resize", updateBottomPanelInset);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && backend.client && backend.user && backend.coupleId) {
      pullRemoteState();
    }
  });
  renderAll();
  initBackend();
}

init();
