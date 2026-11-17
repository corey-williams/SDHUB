(() => {
  'use strict';

  // Service Desk Hub — no server. The page reads and writes data.json in a
  // folder the user picks (normally the Teams/OneDrive folder synced to their
  // PC). OneDrive then syncs that file to everyone else.

  const DATA_FILE = 'data.json';
  const POLL_MS = 5000;
  const DEFAULT_PIN = '1234';

  const REGIONS = ['Bellin', 'Gundersen', 'Research', 'Emplify'];
  const ROLES = ['IT Support Technician Associate', 'IT Support Technician', 'IT Support Technician Senior'];
  const REGION_COLORS = { Bellin: '#0d9488', Gundersen: '#2563eb', Research: '#ea580c', Emplify: '#7c3aed', '': '#94a3b8' };

  // ---------- state ----------
  const S = {
    data: null,
    employees: [],
    pto: [],
    overrides: [],
    meetings: [],
    splits: [],
    admin: false, // set by setRole() at boot
    role: null,
    supId: null,
    adminKey: null,
    dir: null,
    fileHandle: null,
    lastModified: 0,
    conflicts: [],
    saving: false,
    // Home
    homeDate: ymd(new Date()),
    region: localStorage.getItem('sdh-region') || 'all',
    // PTO tab
    view: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    selected: null,
    ptoRegion: 'all',
    calFilter: 'all',
    ptoFilter: 'pending',
    // Admin
    editingId: null,
    editColor: null,
  };

  const COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#14b8a6', '#0ea5e9', '#3b82f6', '#64748b'];
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- helpers ----------
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function parseYmd(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(s, n) {
    const d = parseYmd(s);
    return ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n));
  }
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  }
  function firstName(name) {
    return name.split(/\s+/)[0];
  }
  function fmtTime(t) {
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    const hh = h % 12 || 12;
    return m ? `${hh}:${String(m).padStart(2, '0')} ${ap}` : `${hh} ${ap}`;
  }
  function toMin(t) {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }
  function minToTime(min) {
    const m = ((min % 1440) + 1440) % 1440;
    return fmtTime(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  function shiftEndMin(shift) {
    // A shift that ends at or before it starts runs past midnight.
    const s = toMin(shift.start), e = toMin(shift.end);
    return e <= s ? e + 1440 : e;
  }
  function hourLabel(h) {
    const hh = ((h % 24) + 24) % 24;
    return `${hh % 12 || 12} ${hh >= 12 ? 'PM' : 'AM'}`;
  }
  function fmtDate(s, opts = { month: 'short', day: 'numeric' }) {
    return parseYmd(s).toLocaleDateString(undefined, opts);
  }
  function fmtRange(a, b) {
    if (a === b) return fmtDate(a, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    const sameYear = a.slice(0, 4) === b.slice(0, 4);
    return `${fmtDate(a, sameYear ? undefined : { month: 'short', day: 'numeric', year: 'numeric' })} – ${fmtDate(b, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  function daysBetween(a, b) {
    return Math.round((parseYmd(b) - parseYmd(a)) / 86400000) + 1;
  }
  function emp(id) {
    return S.employees.find((e) => e.id === id);
  }
  function regionOf(e) {
    return REGIONS.includes(e.region) ? e.region : '';
  }
  function regionLabel(r) {
    return r || 'Unassigned';
  }
  function inRegion(e, r) {
    return r === 'all' || regionOf(e) === r;
  }
  function isHidden(r) {
    return (S.data?.settings.hiddenRegions || []).includes(r);
  }
  // People in a hidden region are left off the Home and PTO tabs entirely (they stay in Admin).
  function visibleEmp(e) {
    return !isHidden(regionOf(e));
  }
  function unassigned() {
    return S.employees.some((e) => !regionOf(e)) ? [''] : [];
  }
  // Region buttons and filters: visible regions only, plus "Unassigned" when someone has no region.
  function regionTabs() {
    return [...REGIONS.filter((r) => !isHidden(r)), ...unassigned()];
  }
  // Grouped lists: visible regions, plus any hidden region that still has people in it,
  // so hiding a region never makes anyone disappear.
  function regionGroups() {
    return [...REGIONS.filter((r) => !isHidden(r) || S.employees.some((e) => regionOf(e) === r)), ...unassigned()];
  }
  function regionTag(e) {
    const r = regionOf(e);
    return `<span class="rtag" style="--c:${REGION_COLORS[r]}">${esc(regionLabel(r))}</span>`;
  }
  async function sha256(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
    return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  function scheduleSummary(schedule) {
    const on = schedule.map((d, i) => (d.on ? i : -1)).filter((i) => i >= 0);
    if (!on.length) return 'No scheduled days';
    const groups = [];
    for (const i of on) {
      const d = schedule[i];
      const last = groups[groups.length - 1];
      if (last && last.end === i - 1 && last.start_t === d.start && last.end_t === d.end) last.end = i;
      else groups.push({ start: i, end: i, start_t: d.start, end_t: d.end });
    }
    return groups
      .map((g) => `${DAY_SHORT[g.start]}${g.end > g.start ? '–' + DAY_SHORT[g.end] : ''} ${fmtTime(g.start_t)}–${fmtTime(g.end_t)}`)
      .join(', ');
  }

  // A one-off change to someone's hours for a date range. If several cover the
  // same day, the most recent one wins.
  // On a regular day off, only adjustments marked "include days off" count.
  function overrideFor(e, dateStr, offDay = false) {
    let best = null;
    for (const o of S.overrides) {
      if (o.employeeId !== e.id || o.start > dateStr || o.end < dateStr) continue;
      if (offDay && !o.allDays) continue;
      if (!best || (o.createdAt || '') > (best.createdAt || '')) best = o;
    }
    return best;
  }
  // On a full-day holiday nobody works unless an admin adjusted their hours or
  // added a shift for that day. On a half day, shifts end at closing time.
  function effectiveShift(e, dateStr, dow = parseYmd(dateStr).getDay()) {
    const base = e.schedule[dow];
    const hol = holidayOn(dateStr);
    if (hol) {
      const o = overrideFor(e, dateStr, false);
      if (o) return { on: true, start: o.startTime, end: o.endTime, override: o, extra: !base.on || hol.kind === 'full', holiday: hol };
      if (hol.kind === 'full' || !base.on) return { ...base, on: false, holiday: hol };
      const close = toMin(hol.closesAt || '12:00');
      if (toMin(base.start) >= close) return { ...base, on: false, holiday: hol };
      return { on: true, start: base.start, end: minToHHMM(Math.min(shiftEndMin(base), close)), holiday: hol, halfDay: true };
    }
    const o = overrideFor(e, dateStr, !base.on);
    return o ? { on: true, start: o.startTime, end: o.endTime, override: o, extra: !base.on } : base;
  }

  // ---------- holidays ----------
  // Rules: 'fixed' = same date every year (optionally observed on the nearest
  // weekday when it lands on a weekend), 'nth' = e.g. 4th Thursday of November
  // (n = -1 means the last one), 'date' = one specific date.
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DEFAULT_HOLIDAYS = [
    { id: 'h-newyear', name: "New Year's Day", rule: { type: 'fixed', month: 1, day: 1, observe: true }, kind: 'full' },
    { id: 'h-memorial', name: 'Memorial Day', rule: { type: 'nth', month: 5, weekday: 1, n: -1 }, kind: 'full' },
    { id: 'h-july4', name: 'Independence Day', rule: { type: 'fixed', month: 7, day: 4, observe: true }, kind: 'full' },
    { id: 'h-labor', name: 'Labor Day', rule: { type: 'nth', month: 9, weekday: 1, n: 1 }, kind: 'full' },
    { id: 'h-thanks', name: 'Thanksgiving', rule: { type: 'nth', month: 11, weekday: 4, n: 4 }, kind: 'full' },
    { id: 'h-xmaseve', name: 'Christmas Eve', rule: { type: 'fixed', month: 12, day: 24, observe: false }, kind: 'half', closesAt: '12:00' },
    { id: 'h-xmas', name: 'Christmas Day', rule: { type: 'fixed', month: 12, day: 25, observe: true }, kind: 'full' },
  ];
  function holidayDate(h, year) {
    const r = h.rule || {};
    if (r.type === 'date') return DATE_RE.test(r.date) && Number(r.date.slice(0, 4)) === year ? r.date : null;
    if (r.type === 'nth') {
      const m = r.month - 1;
      if (r.n === -1) {
        const last = new Date(year, m + 1, 0);
        return ymd(new Date(year, m, last.getDate() - ((last.getDay() - r.weekday + 7) % 7)));
      }
      const first = new Date(year, m, 1);
      const day = 1 + ((r.weekday - first.getDay() + 7) % 7) + (r.n - 1) * 7;
      const d = new Date(year, m, day);
      return d.getMonth() === m ? ymd(d) : null;
    }
    if (r.type === 'fixed') {
      const d = new Date(year, r.month - 1, r.day);
      if (r.observe && d.getDay() === 6) d.setDate(d.getDate() - 1); // Saturday → Friday
      else if (r.observe && d.getDay() === 0) d.setDate(d.getDate() + 1); // Sunday → Monday
      return ymd(d);
    }
    return null;
  }
  // Holidays observed on a date (a Jan 1 on a Saturday is observed Dec 31,
  // so the next year's rules are checked too). Full days come first.
  function holidaysOn(dateStr) {
    const y = Number(dateStr.slice(0, 4));
    const out = [];
    for (const h of S.data?.settings.holidays || []) {
      if (holidayDate(h, y) === dateStr || holidayDate(h, y + 1) === dateStr) out.push(h);
    }
    return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'full' ? -1 : 1));
  }
  function holidayOn(dateStr) {
    return holidaysOn(dateStr)[0] || null;
  }
  function holidayLabel(h) {
    return h.kind === 'half' ? `Half day, closes at ${fmtTime(h.closesAt || '12:00')}` : 'Office closed';
  }
  function ruleLabel(r) {
    if (r.type === 'fixed') return `Every ${MONTHS[r.month - 1]} ${r.day}${r.observe ? ' (weekday observed)' : ''}`;
    if (r.type === 'nth') return `${r.n === -1 ? 'Last' : ['1st', '2nd', '3rd', '4th', '5th'][r.n - 1]} ${DAY_NAMES[r.weekday]} of ${MONTHS[r.month - 1]}`;
    if (r.type === 'date') return 'One time only';
    return '';
  }
  function normHolidays(list) {
    if (!Array.isArray(list)) return DEFAULT_HOLIDAYS.map((h) => JSON.parse(JSON.stringify(h)));
    return list.filter((h) => h && typeof h.name === 'string' && h.rule && ['fixed', 'nth', 'date'].includes(h.rule.type));
  }
  // ---------- recurring meetings ----------
  // A meeting starts on m.date and may repeat: 'daily', 'weekly', 'biweekly'
  // or 'monthly' (same day of the month), optionally until m.until. Single
  // cancelled days are listed in m.skip.
  const REPEAT_KINDS = ['none', 'daily', 'weekly', 'biweekly', 'monthly'];
  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function repeatLabel(kind, dateStr) {
    const d = parseYmd(dateStr);
    const wd = DAY_NAMES[d.getDay()];
    return {
      none: "Doesn't repeat",
      daily: 'Every day',
      weekly: `Every week on ${wd}`,
      biweekly: `Every 2 weeks on ${wd}`,
      monthly: `Every month on the ${ordinal(d.getDate())}`,
    }[kind];
  }
  function occursOn(m, dateStr) {
    if (dateStr < m.date) return false;
    const kind = m.repeat || 'none';
    if (kind === 'none') return dateStr === m.date;
    if (m.until && dateStr > m.until) return false;
    if ((m.skip || []).includes(dateStr)) return false;
    const days = daysBetween(m.date, dateStr) - 1;
    if (kind === 'daily') return true;
    if (kind === 'weekly') return days % 7 === 0;
    if (kind === 'biweekly') return days % 14 === 0;
    if (kind === 'monthly') return parseYmd(dateStr).getDate() === parseYmd(m.date).getDate();
    return false;
  }

  // ---------- split shifts ----------
  // A split moves part of someone's shift to another region:
  // { id, employeeId, region, date, startTime, endTime, repeat, until, skip }
  // (repeat/until/skip work like recurring meetings). Only used when the
  // admin has switched split shifts on.
  function splitsEnabled() {
    return !!S.data?.settings.splitShifts;
  }
  function splitSpans(e, dateStr, shift) {
    if (!splitsEnabled() || !shift?.on) return [];
    const s = toMin(shift.start), end = shiftEndMin(shift);
    return S.splits
      .filter((sp) => sp.employeeId === e.id && sp.region !== regionOf(e) && occursOn(sp, dateStr))
      .map((sp) => {
        let a = toMin(sp.startTime), b = toMin(sp.endTime);
        if (a < s && a + 1440 < end) a += 1440;
        while (b <= a) b += 1440;
        return { sp, region: sp.region, from: Math.max(a, s), to: Math.min(b, end) };
      })
      .filter((x) => x.to > x.from)
      .sort((x, y) => x.from - y.from);
  }
  // People from other regions covering `region` on a date: [{ w, spans }].
  function visitorsFor(region, dateStr) {
    if (!splitsEnabled()) return [];
    return dayStatus(dateStr)
      .working.filter((w) => visibleEmp(w.e) && regionOf(w.e) !== region)
      .map((w) => ({ w, spans: splitSpans(w.e, dateStr, w.shift).filter((x) => x.region === region) }))
      .filter((v) => v.spans.length);
  }

  // Meetings for one person on one day, as minute spans inside their shift
  // (handles shifts that run past midnight).
  function meetingSpans(e, dateStr, shift) {
    const s = toMin(shift.start), end = shiftEndMin(shift);
    return S.meetings
      .filter((m) => m.employeeId === e.id && occursOn(m, dateStr))
      .map((m) => {
        let ms = toMin(m.startTime), me = toMin(m.endTime);
        if (ms < s && ms + 1440 < end) ms += 1440;
        while (me <= ms) me += 1440;
        return { m, from: Math.max(ms, s), to: Math.min(me, end) };
      })
      .filter((x) => x.to > x.from)
      .sort((a, b) => a.from - b.from);
  }

  // ---------- breaks & lunch ----------
  // Each employee can have up to two breaks and a lunch, the same on every
  // working day: { start: 'HH:MM', mins: 15 }. Shown on Home and counted as
  // "not available" for coverage, like meetings.
  function breakList(e) {
    const out = [];
    (e.breaks || []).forEach((b, i) => b && out.push({ kind: 'break', label: 'Break', n: i + 1, ...b }));
    if (e.lunch) out.push({ kind: 'lunch', label: 'Lunch', ...e.lunch });
    return out;
  }
  function breakSpans(e, shift) {
    const s = toMin(shift.start), end = shiftEndMin(shift);
    return breakList(e)
      .map((b) => {
        let bs = toMin(b.start);
        if (bs < s && bs + 1440 < end) bs += 1440;
        return { b, from: Math.max(bs, s), to: Math.min(bs + b.mins, end) };
      })
      .filter((x) => x.to > x.from)
      .sort((a, b) => a.from - b.from);
  }
  // Everything that makes someone unavailable during their shift.
  function busySpans(e, dateStr, shift) {
    return [...meetingSpans(e, dateStr, shift), ...breakSpans(e, shift)];
  }
  // Fork and knife, used for lunch on the shift bars and in the Events feed.
  const LUNCH_ICON = `<svg class="lunch-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 2v6a3 3 0 0 0 6 0V2"/><path d="M8 2v20"/><path d="M19 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/></svg>`;
  // Pause symbol, used for breaks on the shift bars.
  const BREAK_ICON = `<svg class="lunch-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M9 5v14M15 5v14"/></svg>`;
  function fmtBreak(b) {
    return `${fmtTime(b.start)} – ${minToTime(toMin(b.start) + b.mins)}`;
  }

  // ---------- coverage ----------
  // The hours the desk must be staffed, per weekday. Default: Mon–Fri 6 AM – 5 PM.
  function defaultCoverage() {
    return DAY_NAMES.map((_, i) => ({ on: i > 0 && i < 6, start: '06:00', end: '17:00' }));
  }
  function normCoverage(c) {
    if (!Array.isArray(c) || c.length !== 7) return defaultCoverage();
    return c.map((d) => ({ on: !!d?.on, start: TIME_RE.test(d?.start) ? d.start : '06:00', end: TIME_RE.test(d?.end) ? d.end : '17:00' }));
  }
  // Each region has its own coverage: one start/end time and the weekdays it
  // applies. Older files only had one shared weekly schedule; that becomes
  // every region's starting point.
  function normRegionCoverage(rc, legacy) {
    const on = legacy.filter((d) => d.on);
    const fallback = {
      start: on[0]?.start || '06:00',
      end: on[0]?.end || '17:00',
      days: legacy.map((d, i) => (d.on ? i : -1)).filter((i) => i >= 1 && i <= 5),
    };
    if (!fallback.days.length) fallback.days = [1, 2, 3, 4, 5];
    const out = {};
    for (const r of REGIONS) {
      const c = rc?.[r];
      out[r] = c
        ? {
            start: TIME_RE.test(c.start) ? c.start : fallback.start,
            end: TIME_RE.test(c.end) ? c.end : fallback.end,
            // Weekdays only: Saturday and Sunday are never checked for coverage.
            days: Array.isArray(c.days) ? c.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 5) : fallback.days,
          }
        : { ...fallback, days: [...fallback.days] };
    }
    return out;
  }
  function regionCoverage(region) {
    return S.data?.settings.regionCoverage?.[region] || { start: '06:00', end: '17:00', days: [1, 2, 3, 4, 5] };
  }
  // The coverage window (in minutes) for a region on a date, or null if that
  // region isn't covered that weekday.
  function coverageWindow(dateStr, region) {
    const c = regionCoverage(region);
    if (!c.days.includes(parseYmd(dateStr).getDay())) return null;
    const hol = holidayOn(dateStr);
    if (hol?.kind === 'full') return null; // closed: nothing to cover
    const s = toMin(c.start);
    let e = toMin(c.end);
    if (e <= s) e += 1440;
    if (hol) e = Math.min(e, toMin(hol.closesAt || '12:00')); // half day: only until closing
    return e > s ? { s, e } : null;
  }
  function fmtWindow(w) {
    return `${minToTime(w.s)} – ${minToTime(w.e)}`;
  }
  // Coverage is checked per region: each region must have someone available
  // on its own. A region is checked when it's shown, has gap alerts on, and
  // has at least one person in it.
  function alertsOn(r) {
    return !(S.data?.settings.coverageOff || []).includes(r);
  }
  function checkedRegions() {
    return REGIONS.filter((r) => !isHidden(r) && alertsOn(r) && S.employees.some((e) => regionOf(e) === r));
  }
  // Per-region gaps for a day: [{ region, win, gaps }] for every checked
  // region whose coverage applies that weekday.
  function regionGaps(dateStr) {
    return checkedRegions()
      .map((r) => ({ region: r, win: coverageWindow(dateStr, r), gaps: coverageGaps(dateStr, r) }))
      .filter((x) => x.win);
  }
  // Stretches inside coverage hours where nobody in the region is on shift
  // and out of meetings. Checked in 5-minute steps.
  function coverageGaps(dateStr, region) {
    const win = coverageWindow(dateStr, region);
    if (!win || !S.employees.some((e) => regionOf(e) === region)) return [];
    // The region's own people (minus time split out to other regions), plus
    // people from other regions during the time they're covering this one.
    const people = [
      ...dayStatus(dateStr)
        .working.filter((w) => regionOf(w.e) === region)
        .map((w) => ({ s: toMin(w.shift.start), e: shiftEndMin(w.shift), busy: [...busySpans(w.e, dateStr, w.shift), ...splitSpans(w.e, dateStr, w.shift)] })),
      ...visitorsFor(region, dateStr).flatMap(({ w, spans }) => spans.map((x) => ({ s: x.from, e: x.to, busy: busySpans(w.e, dateStr, w.shift) }))),
    ];
    const STEP = 5;
    const gaps = [];
    for (let t = win.s; t < win.e; t += STEP) {
      if (people.some((p) => t >= p.s && t < p.e && !p.busy.some((b) => t >= b.from && t < b.to))) continue;
      const last = gaps[gaps.length - 1];
      if (last && last.to === t) last.to = t + STEP;
      else gaps.push({ from: t, to: t + STEP });
    }
    for (const g of gaps) g.to = Math.min(g.to, win.e);
    return gaps;
  }
  function fmtGap(g) {
    const mins = g.to - g.from;
    const dur = mins >= 60 ? `${+(mins / 60).toFixed(2)} hr${mins === 60 ? '' : 's'}` : `${mins} min`;
    return `${minToTime(g.from)} – ${minToTime(g.to)} (${dur})`;
  }
  // After a change, warn if any day in the range now has a coverage gap.
  // Only the changed person's region is checked, so unrelated gaps elsewhere
  // don't show up in the warning.
  function warnGaps(start, end, onlyRegion = null) {
    const hits = [];
    for (let d = start; d <= end && hits.length < 4; d = addDays(d, 1)) {
      for (const { region, gaps } of regionGaps(d).filter((x) => !onlyRegion || x.region === onlyRegion)) {
        if (gaps.length) hits.push(`${region}, ${fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}: ${gaps.map(fmtGap).join(', ')}`);
      }
    }
    if (hits.length) toast(`Heads up, no coverage in ${hits.slice(0, 4).join('; ')}`, 'warn');
  }

  // Typical hours to suggest when adding a shift on a day off.
  function typicalHours(e) {
    const d = e.schedule.find((x) => x.on);
    return d ? { start: d.start, end: d.end } : { start: '08:00', end: '17:00' };
  }

  // Everyone's status on a date: working (with shift), on approved PTO, or not scheduled.
  function dayStatus(dateStr) {
    const dow = parseYmd(dateStr).getDay();
    const working = [], pto = [], off = [];
    for (const e of S.employees) {
      const reqs = S.pto.filter((p) => p.employeeId === e.id && p.start <= dateStr && p.end >= dateStr && p.status !== 'denied');
      const approved = reqs.find((p) => p.status === 'approved');
      const pending = reqs.find((p) => p.status === 'pending');
      const shift = effectiveShift(e, dateStr, dow);
      if (approved) pto.push({ e, req: approved, scheduled: shift.on });
      else if (shift.on) working.push({ e, shift, pending });
      else off.push({ e, pending });
    }
    return { working, pto, off };
  }

  // PTO (approved or pending) that covers a date, one entry per person.
  function ptoOn(dateStr) {
    const out = new Map();
    for (const p of S.pto) {
      if (p.status === 'denied' || p.start > dateStr || p.end < dateStr) continue;
      const e = emp(p.employeeId);
      if (!e) continue;
      const cur = out.get(e.id);
      if (!cur || (cur.req.status !== 'approved' && p.status === 'approved')) out.set(e.id, { e, req: p });
    }
    return [...out.values()];
  }

  // ---------- validation ----------
  function str(v, field, max = 80, required = true) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (required && !s) throw new Error(`${field} is required`);
    if (s.length > max) throw new Error(`${field} is too long`);
    return s;
  }
  function cleanSchedule(raw) {
    if (!Array.isArray(raw) || raw.length !== 7) throw new Error('Schedule must have 7 days');
    return raw.map((d, i) => {
      const on = !!(d && d.on);
      const start = d && TIME_RE.test(d.start) ? d.start : '08:00';
      const end = d && TIME_RE.test(d.end) ? d.end : '17:00';
      if (on && start === end) throw new Error(`${DAY_NAMES[i]}: start and end times can't match`);
      return { on, start, end };
    });
  }
  function cleanEmployee(body, prevRole) {
    if (!REGIONS.includes(body.region)) throw new Error('Please choose a region');
    // Roles come from the fixed list; an older free-text role is kept only if left unchanged.
    if (!ROLES.includes(body.role) && !(prevRole && body.role === prevRole)) throw new Error('Please choose a role');
    return {
      name: str(body.name, 'Name', 60),
      role: body.role,
      region: body.region,
      color: COLOR_RE.test(body.color) ? body.color : COLORS[0],
      schedule: cleanSchedule(body.schedule),
      ...cleanInfo(body),
      ...cleanBreaks(body),
    };
  }
  function cleanBreaks(body) {
    const one = (b, label, maxMins) => {
      if (!b) return null;
      if (!TIME_RE.test(b.start)) throw new Error(`${label}: please enter a start time`);
      const mins = Number(b.mins);
      if (!Number.isInteger(mins) || mins < 5 || mins > maxMins) throw new Error(`${label}: please choose a length`);
      return { start: b.start, mins };
    };
    return {
      breaks: [one(body.breaks?.[0], 'Break 1', 60), one(body.breaks?.[1], 'Break 2', 60)],
      lunch: one(body.lunch, 'Lunch', 120),
    };
  }
  // Employee info (all optional). staffId/staffNumber are the company's own
  // identifiers, separate from the internal id the app uses.
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function formatPhone(raw) {
    const s = String(raw || '').trim();
    const digits = s.replace(/\D/g, '');
    if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    if (digits.length === 11 && digits[0] === '1') return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    return s;
  }
  function cleanInfo(body) {
    const email = str(body.email, 'Email', 120, false);
    if (email && !EMAIL_RE.test(email)) throw new Error('Please enter a valid email address');
    const startDate = str(body.startDate, 'Start date', 10, false);
    if (startDate && !DATE_RE.test(startDate)) throw new Error('Please enter a valid start date');
    return {
      staffId: str(body.staffId, 'Employee ID', 40, false),
      staffNumber: str(body.staffNumber, 'Employee number', 40, false),
      email,
      phone: formatPhone(str(body.phone, 'Phone', 40, false)),
      startDate,
    };
  }
  function tenure(startDate) {
    if (!DATE_RE.test(startDate || '')) return '';
    const s = parseYmd(startDate), now = new Date();
    if (s > now) return 'starts ' + fmtDate(startDate, { month: 'short', day: 'numeric', year: 'numeric' });
    let months = (now.getFullYear() - s.getFullYear()) * 12 + (now.getMonth() - s.getMonth());
    if (now.getDate() < s.getDate()) months--;
    if (months < 1) return 'new this month';
    const y = Math.floor(months / 12), m = months % 12;
    return [y && `${y} yr${y > 1 ? 's' : ''}`, m && `${m} mo`].filter(Boolean).join(' ');
  }
  function cleanPto(body, data) {
    const employeeId = str(body.employeeId, 'Employee');
    if (!data.employees.some((e) => e.id === employeeId)) throw new Error('That employee no longer exists');
    const start = str(body.start, 'Start date', 10);
    const end = str(body.end, 'End date', 10);
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw new Error('Please enter valid dates');
    if (end < start) throw new Error('End date is before start date');
    return { employeeId, start, end, note: str(body.note, 'Note', 300, false) };
  }
  function normalize(d) {
    if (!d || typeof d !== 'object') throw new Error('not an object');
    return {
      version: 1,
      settings: {
        adminPinHash: d.settings?.adminPinHash || null,
        hiddenRegions: Array.isArray(d.settings?.hiddenRegions) ? d.settings.hiddenRegions.filter((r) => REGIONS.includes(r)) : [],
        splitShifts: !!d.settings?.splitShifts,
        coverageOff: Array.isArray(d.settings?.coverageOff) ? d.settings.coverageOff.filter((r) => REGIONS.includes(r)) : [],
        coverage: normCoverage(d.settings?.coverage),
        regionCoverage: normRegionCoverage(d.settings?.regionCoverage, normCoverage(d.settings?.coverage)),
        holidays: normHolidays(d.settings?.holidays),
        keySalt: d.settings?.keySalt || null,
      },
      employees: Array.isArray(d.employees) ? d.employees : [],
      pto: Array.isArray(d.pto) ? d.pto : [],
      overrides: Array.isArray(d.overrides) ? d.overrides : [],
      meetings: Array.isArray(d.meetings) ? d.meetings : [],
      splits: Array.isArray(d.splits) ? d.splits : [],
      updatedAt: d.updatedAt || null,
    };
  }

  // ---------- sample data ----------
  async function newData(withSamples) {
    const day = (on, start = '08:00', end = '17:00') => ({ on, start, end });
    const wk = (start, end) => [day(false), day(true, start, end), day(true, start, end), day(true, start, end), day(true, start, end), day(true, start, end), day(false)];
    const employees = withSamples
      ? [
          { id: uid(), name: 'Alex Rivera', role: 'IT Support Technician Senior', region: 'Bellin', color: '#6366f1', schedule: wk('08:00', '17:00') },
          { id: uid(), name: 'Taylor Brooks', role: 'IT Support Technician Associate', region: 'Bellin', color: '#f59e0b', schedule: wk('06:00', '14:30') },
          { id: uid(), name: 'Jordan Lee', role: 'IT Support Technician', region: 'Gundersen', color: '#0ea5e9', schedule: wk('11:00', '20:00') },
          { id: uid(), name: 'Morgan Chen', role: 'IT Support Technician Associate', region: 'Gundersen', color: '#ec4899', schedule: wk('07:30', '16:00') },
          { id: uid(), name: 'Sam Patel', role: 'IT Support Technician Associate', region: 'Bellin', color: '#10b981', schedule: [day(true, '09:00', '17:00'), day(false), day(false), day(true), day(true), day(true), day(true, '09:00', '17:00')] },
          { id: uid(), name: 'Riley Kim', role: 'IT Support Technician', region: 'Gundersen', color: '#8b5cf6', schedule: wk('10:00', '18:30') },
        ]
      : [];
    // Emplify starts hidden; an admin can show it under Admin → Settings.
    return { version: 1, settings: { adminPinHash: await sha256(DEFAULT_PIN), hiddenRegions: ['Emplify'], coverage: defaultCoverage(), regionCoverage: normRegionCoverage(null, defaultCoverage()), holidays: normHolidays(null) }, employees, pto: [], overrides: [], meetings: [], splits: [], updatedAt: new Date().toISOString() };
  }

  // ---------- remembered folder (IndexedDB) ----------
  function idbOpen() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('service-desk-hub', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  // ---------- file storage ----------
  async function readData() {
    // OneDrive can briefly leave a half-written file while syncing; retry before giving up.
    for (let attempt = 0; ; attempt++) {
      const file = await S.fileHandle.getFile();
      const text = await file.text();
      try {
        return { data: normalize(JSON.parse(text)), lastModified: file.lastModified };
      } catch {
        if (attempt >= 2) throw new Error(`${DATA_FILE} couldn't be read. It may still be syncing; try again in a moment. Nothing was changed.`);
        await sleep(700);
      }
    }
  }

  async function writeData(handle, data) {
    const w = await handle.createWritable();
    await w.write(JSON.stringify(data, null, 2));
    await w.close();
  }

  function applyData(data, lastModified) {
    S.data = data;
    S.employees = data.employees;
    S.pto = data.pto;
    S.overrides = data.overrides;
    S.meetings = data.meetings;
    S.splits = data.splits;
    S.lastModified = lastModified;
  }

  async function scanConflicts() {
    // OneDrive saves the losing side of a sync conflict as e.g. "data-LAPTOP123.json".
    const found = [];
    try {
      for await (const [name] of S.dir.entries()) {
        if (name !== DATA_FILE && /^data.*\.json$/i.test(name)) found.push(name);
      }
    } catch {
      /* listing isn't essential */
    }
    S.conflicts = found.sort();
  }

  async function reload(force = false) {
    const file = await S.fileHandle.getFile();
    if (!force && file.lastModified === S.lastModified) return;
    const { data, lastModified } = await readData();
    applyData(data, lastModified);
    await scanConflicts();
    renderAll();
  }

  function friendly(e) {
    if (e?.name === 'NotAllowedError') return 'Permission to edit the folder was lost. Reload the page and reconnect.';
    if (e?.name === 'NotFoundError') return `${DATA_FILE} was moved or deleted. Reload the page and reconnect.`;
    if (e?.name === 'NoModificationAllowedError' || e?.name === 'InvalidStateError') return `${DATA_FILE} is busy (maybe syncing). Try again in a moment.`;
    return e?.message || 'Something went wrong';
  }

  // Read the latest file, apply one change to it, save. Re-reading right before
  // saving means we only ever overwrite what's actually on disk, not a stale copy.
  async function mutate(fn, okMsg) {
    if (S.saving) return false;
    S.saving = true;
    try {
      const { data } = await readData();
      await fn(data);
      data.updatedAt = new Date().toISOString();
      await writeData(S.fileHandle, data);
      const file = await S.fileHandle.getFile();
      applyData(data, file.lastModified);
      renderAll();
      if (okMsg) toast(okMsg);
      return true;
    } catch (e) {
      toast(friendly(e), true);
      return false;
    } finally {
      S.saving = false;
    }
  }

  // ---------- connecting to the folder ----------
  function setConnected(on) {
    document.body.classList.toggle('disconnected', !on);
  }

  function showConnect(state, dir) {
    setConnected(false);
    const box = $('#connect-body');
    const folderNote = `<p class="muted small">Pick the team's <b>Service Desk Hub</b> folder in OneDrive (synced from your Teams channel). That's where the shared <code>data.json</code> lives.</p>`;
    if (state === 'unsupported') {
      box.innerHTML = `<h2>Open this in Edge or Chrome</h2>
        <p class="muted">This page saves to a shared file in your Teams/OneDrive folder, which only Microsoft Edge and Google Chrome on a computer can do.</p>`;
    } else if (state === 'reconnect') {
      box.innerHTML = `<h2>Welcome back</h2>
        <p class="muted">Allow access to the <b>${esc(dir.name)}</b> folder again to load the team calendar.</p>
        <button class="btn primary block" id="btn-reconnect">Reconnect to “${esc(dir.name)}”</button>
        <button class="btn ghost block" id="btn-pick">Choose a different folder</button>`;
    } else if (state === 'nofile') {
      box.innerHTML = `<h2>No data file yet</h2>
        <p class="muted">There's no <code>${DATA_FILE}</code> in <b>${esc(dir.name)}</b>. If your team already uses Service Desk Hub, you probably picked the wrong folder. Otherwise, create one here.</p>
        <label class="toggle"><input type="checkbox" id="chk-sample" /> Include sample employees</label>
        <button class="btn primary block" id="btn-create">Create ${DATA_FILE} here</button>
        <button class="btn ghost block" id="btn-pick">Choose a different folder</button>`;
      S.pendingDir = dir;
    } else {
      box.innerHTML = `<h2>Connect to your team's folder</h2>
        ${folderNote}
        <button class="btn primary block" id="btn-pick">Choose folder</button>
        <p class="muted small">Your browser will ask to let this page view and edit files in that folder. Choose <b>Allow on every visit</b> if it's offered so you won't be asked again.</p>`;
    }
  }

  async function connect(dir, { create = false, samples = false } = {}) {
    S.dir = dir;
    let fh;
    try {
      fh = await dir.getFileHandle(DATA_FILE);
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
      if (!create) return showConnect('nofile', dir);
      fh = await dir.getFileHandle(DATA_FILE, { create: true });
      await writeData(fh, await newData(samples));
    }
    S.fileHandle = fh;
    await reload(true);
    try {
      await idbSet('dir', dir);
    } catch {
      /* remembering the folder is a convenience only */
    }
    setConnected(true);
  }

  async function pickFolder() {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ id: 'service-desk-hub', mode: 'readwrite' });
    } catch (e) {
      if (e.name !== 'AbortError') toast(friendly(e), true);
      return;
    }
    try {
      await connect(dir);
    } catch (e) {
      toast(friendly(e), true);
    }
  }

  // ---------- UI helpers ----------
  function toast(msg, err = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (err === 'warn' ? ' warn' : err ? ' err' : '');
    el.textContent = msg;
    $('#toasts').append(el);
    setTimeout(() => el.remove(), err === 'warn' ? 8000 : 3600);
  }

  function confirmBox(title, msg, okLabel = 'Confirm') {
    const dlg = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-msg').textContent = msg;
    $('button[value="ok"]', dlg).textContent = okLabel;
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
  }

  // Signed-in role for this browser tab: 'admin', 'supervisor' or null.
  // S.admin stays true for both, meaning "can approve PTO and adjust hours";
  // isAdmin() is for the things only the admin can do.
  function setRole(role, supId = null) {
    S.role = role;
    S.supId = role === 'supervisor' ? supId : null;
    S.admin = !!role;
    if (role !== 'admin') S.adminKey = null;
    document.body.classList.toggle('is-supervisor', role === 'supervisor');
    if (role) sessionStorage.setItem('sdh-role', JSON.stringify({ role, supId: S.supId }));
    else sessionStorage.removeItem('sdh-role');
  }
  function isAdmin() {
    return S.role === 'admin';
  }

  // ---------- PIN crypto ----------
  // Supervisor PINs are stored twice: a salted PBKDF2 hash to check sign-ins, and
  // an AES copy encrypted with a key derived from the admin PIN so only the admin
  // can reveal it. Nothing in data.json is readable as a PIN.
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const randomSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)));
  const ITER = 150000;

  async function pbkdf2(pin, saltB64) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unb64(saltB64), iterations: ITER, hash: 'SHA-256' }, base, 256));
  }
  async function hashPin(pin) {
    const salt = randomSalt();
    return { salt, hash: await pbkdf2(pin, salt) };
  }
  async function checkPin(pin, rec) {
    return !!(rec?.salt && rec?.hash) && (await pbkdf2(pin, rec.salt)) === rec.hash;
  }
  async function adminKeyFrom(pin, saltB64) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: unb64(saltB64), iterations: ITER, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function encryptPin(pin, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(pin));
    return { iv: b64(iv), data: b64(data) };
  }
  async function decryptPin(enc, key) {
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(enc.iv) }, key, unb64(enc.data));
    return new TextDecoder().decode(buf);
  }
  async function ensureKeySalt() {
    if (!S.data.settings.keySalt) {
      const salt = randomSalt();
      await mutate((d) => { if (!d.settings.keySalt) d.settings.keySalt = salt; });
    }
    return S.data.settings.keySalt;
  }
  async function isAdminPin(pin) {
    const expected = S.data.settings.adminPinHash || (await sha256(DEFAULT_PIN));
    return (await sha256(pin)) === expected;
  }
  // The admin's encryption key lives only in memory. After a page reload it's
  // gone, so ask for the admin PIN again before showing or setting a PIN.
  async function ensureAdminKey() {
    if (S.adminKey) return S.adminKey;
    if (!isAdmin()) return null;
    return askAdminPin();
  }
  function askAdminPin() {
    const dlg = $('#pin-prompt');
    const f = $('#pin-prompt-form');
    f.reset();
    dlg.showModal();
    f.elements.pp.focus();
    return new Promise((resolve) => {
      let done = false;
      f.onsubmit = async (ev) => {
        ev.preventDefault();
        const pin = f.elements.pp.value;
        if (!(await isAdminPin(pin))) {
          toast('Incorrect admin PIN', true);
          return f.elements.pp.select();
        }
        S.adminKey = await adminKeyFrom(pin, await ensureKeySalt());
        done = true;
        dlg.close();
        resolve(S.adminKey);
      };
      dlg.addEventListener('close', () => { if (!done) resolve(null); }, { once: true });
    });
  }

  function avatar(e, cls = '') {
    return `<span class="avatar ${cls}" style="--c:${e.color}">${esc(initials(e.name))}</span>`;
  }

  function personRow(e, right, sub) {
    return `<div class="person">
      ${avatar(e)}
      <div class="person-main"><div class="person-name">${esc(e.name)}</div><div class="person-sub">${sub ?? esc(e.role || '')}</div></div>
      ${right || ''}
    </div>`;
  }

  // ---------- routing ----------
  function currentTab() {
    const t = location.hash.slice(1);
    return ['home', 'pto', 'admin'].includes(t) ? t : 'home';
  }
  function showTab() {
    const tab = currentTab();
    $$('.tab').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + tab));
  }

  // ---------- render ----------
  function renderAll() {
    if (!S.data) return;
    // A supervisor signed in on this tab loses access if the admin removes it.
    if (S.role === 'supervisor' && !S.employees.some((e) => e.id === S.supId && e.supervisor)) {
      setRole(null);
      toast('Your supervisor access was removed', true);
    }
    renderTopbar();
    renderHome();
    renderPtoFilters();
    renderCalendar();
    renderPtoForm();
    renderPtoList();
    renderAdmin();
  }

  function renderTopbar() {
    const pending = S.pto.filter((p) => p.status === 'pending').length;
    const badge = $('#pending-badge');
    badge.hidden = !S.admin || !pending;
    badge.textContent = pending;
    const synced = S.data.updatedAt ? new Date(S.data.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    $('#admin-status').innerHTML =
      `<span class="sync" title="Saving to ${esc(S.dir?.name || '')}/${DATA_FILE}${synced ? ' · last change ' + esc(synced) : ''}"><i></i>${esc(S.dir?.name || '')}</span>` +
      (S.role
        ? `<span class="pill ${S.role}">● ${S.role === 'admin' ? 'Admin' : `Supervisor · ${esc(firstName(emp(S.supId)?.name || ''))}`}</span><button class="btn ghost sm" id="logout">Sign out</button>`
        : '');
  }

  // ---------- Home: day breakdown ----------
  function renderHome() {
    const ds = S.homeDate;
    const isToday = ds === ymd(new Date());
    $('#home-dow').textContent = isToday ? 'Today' : fmtDate(ds, { weekday: 'long' });
    $('#home-date').textContent = fmtDate(ds, { weekday: isToday ? 'long' : undefined, month: 'long', day: 'numeric' });

    const everyone = dayStatus(ds);
    const status = {
      working: everyone.working.filter((x) => visibleEmp(x.e)),
      pto: everyone.pto.filter((x) => visibleEmp(x.e)),
      off: everyone.off.filter((x) => visibleEmp(x.e)),
    };
    const regs = ['all', ...regionTabs()];
    if (!regs.includes(S.region)) S.region = 'all';
    $('#region-tabs').innerHTML = regs
      .map((r) => {
        const n = status.working.filter((w) => inRegion(w.e, r)).length;
        const dot = r === 'all' ? '' : `<i style="--c:${REGION_COLORS[r]}"></i>`;
        return `<button type="button" data-region="${esc(r)}" class="${S.region === r ? 'on' : ''}">${dot}${r === 'all' ? 'All regions' : esc(regionLabel(r))}<span class="cnt">${n}</span></button>`;
      })
      .join('');

    const working = status.working.filter((w) => inRegion(w.e, S.region));
    const onPto = status.pto.filter((p) => inRegion(p.e, S.region));
    const off = status.off.filter((o) => inRegion(o.e, S.region));
    const pendingPto = [...working, ...off].filter((x) => x.pending);

    const starts = working.map((w) => toMin(w.shift.start));
    const ends = working.map((w) => shiftEndMin(w.shift));
    $('#home-stats').innerHTML = [
      [working.length, 'Working', ''],
      [starts.length ? minToTime(Math.min(...starts)) : '—', 'First in', ''],
      [ends.length ? minToTime(Math.max(...ends)) : '—', 'Last out', ''],
      [onPto.length, 'On PTO', onPto.length ? 'warn' : ''],
    ]
      .map(([v, l, c]) => `<div class="card stat ${c}"><div class="stat-v">${esc(v)}</div><div class="stat-l">${l}</div></div>`)
      .join('');

    // Coverage check per region: "All regions" shows every checked region,
    // a single region's tab shows just that region.
    const hols = holidaysOn(ds);
    const hb = $('#holiday-banner');
    hb.hidden = !hols.length;
    hb.innerHTML = hols
      .map(
        (h) => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>
        <div><b>${esc(h.name)}</b> · ${esc(holidayLabel(h))}</div>`
      )
      .join('');

    const checks = regionGaps(ds).filter((x) => S.region === 'all' || x.region === S.region);
    const gapMap = Object.fromEntries(checks.map((x) => [x.region, x.gaps]));
    const bad = checks.filter((x) => x.gaps.length);
    const okRegions = checks.filter((x) => !x.gaps.length);
    // The graph's time range covers every shown region's coverage window.
    const win = checks.length ? { s: Math.min(...checks.map((x) => x.win.s)), e: Math.max(...checks.map((x) => x.win.e)) } : null;
    const tag = (r) => `<span class="rtag" style="--c:${REGION_COLORS[r]}">${esc(r)}</span>`;
    const cb = $('#coverage-banner');
    if (!checks.length) {
      cb.hidden = true;
    } else if (bad.length) {
      cb.hidden = false;
      cb.className = 'cov-banner bad';
      cb.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg>
        <div>
          <b>No coverage</b>
          ${bad
            .map((x) => `<div class="cov-line">${tag(x.region)} ${x.gaps.map((g) => esc(fmtGap(g))).join(', ')}<span class="cov-hours">covers ${fmtWindow(x.win)}</span></div>`)
            .join('')}
          ${okRegions.length ? `<span class="cov-sub">${okRegions.map((x) => `${esc(x.region)} fully covered (${fmtWindow(x.win)})`).join(' · ')}</span>` : ''}
        </div>`;
    } else {
      cb.hidden = false;
      cb.className = 'cov-banner ok';
      cb.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12l5 5L20 7"/></svg>
        <div>Full coverage · ${checks.map((x) => `${esc(x.region)} ${fmtWindow(x.win)}`).join(' · ')}</div>`;
    }

    renderTimeline(working, isToday, win, gapMap);
    renderStartGroups(working);
    renderTimeOff(onPto, pendingPto, off.filter((o) => !o.pending), working);
  }

  function renderTimeline(working, isToday, win = null, gapMap = {}) {
    const el = $('#timeline');
    const where = S.region === 'all' ? '' : ` in ${esc(regionLabel(S.region))}`;
    if (!S.employees.length) {
      el.innerHTML = `<div class="empty-big">No team members yet. Add people from the <a href="#admin">Admin</a> tab.</div>`;
      return;
    }
    // People from other regions covering the region(s) shown, by region.
    const visitRegions = S.region === 'all' ? regionGroups() : [S.region];
    const visitors = Object.fromEntries(visitRegions.map((r) => [r, visitorsFor(r, S.homeDate)]));
    const allVisits = S.region === 'all' ? [] : visitors[S.region] || [];
    if (!working.length && !allVisits.length) {
      el.innerHTML = `<div class="empty-big">Nobody is scheduled${where} on this day.</div>`;
      return;
    }

    // Axis: from the earliest start to the latest finish, at least 8 hours wide.
    const starts = [...working.map((w) => toMin(w.shift.start)), ...allVisits.flatMap((v) => v.spans.map((x) => x.from))];
    const ends = [...working.map((w) => shiftEndMin(w.shift)), ...allVisits.flatMap((v) => v.spans.map((x) => x.to))];
    let a = Math.floor(Math.min(...starts) / 60);
    let b = Math.ceil(Math.max(...ends) / 60);
    // Always show the full coverage window so gaps at either end are visible.
    if (win) {
      a = Math.min(a, Math.floor(win.s / 60));
      b = Math.max(b, Math.ceil(win.e / 60));
    }
    if (b - a < 8) {
      const pad = 8 - (b - a);
      a = Math.max(0, a - Math.floor(pad / 2));
      b = a + Math.max(8, b - a);
    }
    const hours = b - a;
    const pct = (min) => ((min - a * 60) / (hours * 60)) * 100;
    const labelEvery = hours > 14 ? 2 : 1;

    const ticks = [];
    for (let h = a; h <= b; h += 1) {
      if ((h - a) % labelEvery === 0) ticks.push(`<span class="tick" style="left:${pct(h * 60)}%">${hourLabel(h)}</span>`);
    }

    const row = (w) => {
      const s = toMin(w.shift.start), e = shiftEndMin(w.shift);
      const label = `${fmtTime(w.shift.start)} – ${fmtTime(w.shift.end)}`;
      const o = w.shift.override;
      const cls = ['tl-bar', 'editable', w.pending && 'pending', o && 'adjusted'].filter(Boolean).join(' ');
      const mtgs = meetingSpans(w.e, S.homeDate, w.shift);
      const blocks = mtgs
        .map(
          ({ m, from, to }) =>
            `<div class="mtg" data-mtg="${m.id}" style="left:${((from - s) / (e - s)) * 100}%;width:${((to - from) / (e - s)) * 100}%" title="${esc(m.title)}: ${fmtTime(m.startTime)} – ${fmtTime(m.endTime)}${
              m.repeat && m.repeat !== 'none' ? `\n${esc(repeatLabel(m.repeat, m.date))}${m.until ? ` until ${esc(fmtDate(m.until))}` : ''}` : ''
            }\nClick to edit"><span class="mtg-name">${m.repeat && m.repeat !== 'none' ? '↻ ' : ''}${esc(m.title)}</span></div>`
        )
        .join('');
      const brks = breakSpans(w.e, w.shift);
      const brkBlocks = brks
        .map(
          ({ b, from, to }) =>
            `<div class="brk ${b.kind}" style="left:${((from - s) / (e - s)) * 100}%;width:${((to - from) / (e - s)) * 100}%" title="${b.label}: ${esc(fmtBreak(b))}">${b.kind === 'lunch' ? LUNCH_ICON : BREAK_ICON}</div>`
        )
        .join('');
      // Split shift: the part worked for another region, in that region's color.
      const splits = splitSpans(w.e, S.homeDate, w.shift);
      const splitBlocks = splits
        .map(
          ({ sp, region, from, to }) =>
            `<div class="split" data-split="${sp.id}" style="--r:${REGION_COLORS[region]};left:${((from - s) / (e - s)) * 100}%;width:${((to - from) / (e - s)) * 100}%" title="Covering ${esc(region)}: ${minToTime(from)} – ${minToTime(to)}${
              sp.repeat !== 'none' ? ` (${sp.repeat === 'daily' ? 'every day' : 'every week'})` : ''
            }${S.admin ? '\nClick to change' : ''}"><span>${sp.repeat !== 'none' ? '↻ ' : ''}${esc(region)}</span></div>`
        )
        .join('');
      const tip =
        `${w.e.name}: ${label}` +
        splits.map((x) => `\nCovering ${x.region}: ${minToTime(x.from)} – ${minToTime(x.to)}`).join('') +
        brks.map(({ b }) => `\n${b.label}: ${fmtBreak(b)}`).join('') +
        (o ? ` (${w.shift.extra ? 'extra shift' : 'adjusted'}${o.note ? ': ' + o.note : ''})` : '') +
        (w.pending ? ' (PTO pending)' : '') +
        mtgs.map(({ m }) => `\nMeeting: ${m.title}, ${fmtTime(m.startTime)} – ${fmtTime(m.endTime)}`).join('') +
        `\nClick to ${S.admin ? 'add a meeting block or adjust hours' : 'add a meeting block'}`;
      return `<div class="tl-row">
        <div class="tl-who">${avatar(w.e, 'sm')}<div class="tl-names"><div class="tl-name">${esc(w.e.name)}</div><div class="tl-sub">${esc(o?.note || w.e.role || '')}</div></div></div>
        <div class="tl-track"><div class="${cls}" data-emp="${w.e.id}" style="--c:${w.e.color};left:${pct(s)}%;width:${pct(e) - pct(s)}%" title="${esc(tip)}"><span>${label}${o ? ` <em>${w.shift.extra ? 'extra shift' : 'adjusted'}</em>` : ''}</span>${splitBlocks}${brkBlocks}${blocks}</div></div>
      </div>`;
    };
    // Someone from another region shown in the region they're covering: a bar
    // for just the covering window(s).
    const visitRow = ({ w, spans }) => {
      const home = regionLabel(regionOf(w.e));
      const bars = spans
        .map(
          (x) =>
            `<div class="tl-bar visit" style="--c:${w.e.color};--r:${REGION_COLORS[regionOf(w.e)]};left:${pct(x.from)}%;width:${pct(x.to) - pct(x.from)}%" title="${esc(w.e.name)} from ${esc(home)} covering ${esc(x.region)}: ${minToTime(x.from)} – ${minToTime(x.to)}"><span>${minToTime(x.from)} – ${minToTime(x.to)}</span></div>`
        )
        .join('');
      return `<div class="tl-row tl-visit">
        <div class="tl-who">${avatar(w.e, 'sm')}<div class="tl-names"><div class="tl-name">${esc(w.e.name)}</div><div class="tl-sub">Covering from ${esc(home)}</div></div></div>
        <div class="tl-track">${bars}</div>
      </div>`;
    };
    const byStart = (x, y) => toMin(x.shift.start) - toMin(y.shift.start) || x.e.name.localeCompare(y.e.name);

    // Red shading for a region's coverage gaps, drawn over just that region's rows.
    const gapEls = (gaps = []) =>
      gaps.map((g) => `<div class="tl-gap" style="--x:${pct(g.from)};--w:${pct(g.to) - pct(g.from)}" title="No coverage ${esc(fmtGap(g))}"><span>No coverage</span></div>`).join('');

    let body = '';
    if (S.region === 'all') {
      for (const r of regionGroups()) {
        const list = working.filter((w) => regionOf(w.e) === r).sort(byStart);
        const vis = visitors[r] || [];
        const gaps = gapMap[r] || [];
        if (!list.length && !vis.length && !gaps.length) continue;
        body += `<div class="tl-group"><i style="--c:${REGION_COLORS[r]}"></i>${esc(regionLabel(r))}<span>${list.length} working${vis.length ? ` · ${vis.length} covering` : ''}</span></div>
        <div class="tl-groupbox">
          ${list.length ? list.map(row).join('') : vis.length ? '' : `<div class="tl-row"><div class="tl-who"><span class="muted small">Nobody scheduled</span></div><div class="tl-track"></div></div>`}
          ${vis.map(visitRow).join('')}
          ${gapEls(gaps)}
        </div>`;
      }
    } else {
      body = `<div class="tl-groupbox">${[...working].sort(byStart).map(row).join('')}${allVisits.map(visitRow).join('')}${gapEls(gapMap[S.region])}</div>`;
    }

    // Coverage: how many people are available during each hour. Someone counts
    // if any 15 minutes of that hour are on shift and not in a meeting. On a
    // single region's tab, time split out to other regions doesn't count and
    // people covering from other regions do.
    const single = S.region !== 'all';
    const avail = [
      ...working.map((w) => ({
        s: toMin(w.shift.start),
        e: shiftEndMin(w.shift),
        busy: [...busySpans(w.e, S.homeDate, w.shift), ...(single ? splitSpans(w.e, S.homeDate, w.shift) : [])],
      })),
      ...allVisits.flatMap(({ w, spans }) => spans.map((x) => ({ s: x.from, e: x.to, busy: busySpans(w.e, S.homeDate, w.shift) }))),
    ];
    const cov = [];
    for (let h = a; h < b; h++) {
      let n = 0;
      for (const p of avail) {
        for (let t = h * 60; t < (h + 1) * 60; t += 15) {
          if (t >= p.s && t < p.e && !p.busy.some((x) => t >= x.from && t < x.to)) {
            n++;
            break;
          }
        }
      }
      cov.push(n);
    }
    const peak = Math.max(...cov, 1);
    const inWindow = (h) => win && h * 60 < win.e && (h + 1) * 60 > win.s;
    const covCells = cov
      .map((n, i) => {
        const zero = !n && inWindow(a + i);
        return `<span class="cov-cell ${zero ? 'zero' : ''}" style="--a:${n ? 0.15 + 0.85 * (n / peak) : 0}" title="${hourLabel(a + i)}: ${n} available">${n || (zero ? '0' : '')}</span>`;
      })
      .join('');
    let now = '';
    if (isToday) {
      const d = new Date();
      const m = d.getHours() * 60 + d.getMinutes();
      if (m >= a * 60 && m <= b * 60) now = `<div class="tl-now" style="--x:${pct(m)}"><span>Now</span></div>`;
    }

    el.innerHTML = `<div class="tl" style="--hours:${hours}">
      <div class="tl-row tl-axis"><div class="tl-who"></div><div class="tl-track">${ticks.join('')}</div></div>
      ${body}
      <div class="tl-row tl-cov"><div class="tl-who"><span class="muted small">Available by hour</span></div><div class="tl-track cov">${covCells}</div></div>
      ${now}
    </div>`;
  }

  function renderStartGroups(working) {
    const el = $('#start-groups');
    if (!working.length) {
      el.innerHTML = '';
      return;
    }
    const groups = new Map();
    for (const w of [...working].sort((x, y) => toMin(x.shift.start) - toMin(y.shift.start))) {
      if (!groups.has(w.shift.start)) groups.set(w.shift.start, []);
      groups.get(w.shift.start).push(w);
    }
    el.innerHTML = [...groups]
      .map(
        ([t, list]) => `<div class="sg">
          <div class="sg-time">${fmtTime(t)}</div>
          <div class="sg-people">${list
            .map((w) => `<span class="sg-person" title="${esc(w.e.name)} · ${esc(regionLabel(regionOf(w.e)))}">${avatar(w.e, 'xs')}${esc(firstName(w.e.name))}</span>`)
            .join('')}</div>
          <div class="sg-count">${list.length}</div>
        </div>`
      )
      .join('');
  }

  // ---------- Events panel ----------
  // Build the day's events for the people shown: shift starts and ends,
  // breaks, lunch and meetings. For today, things in progress are "now" and
  // the rest are upcoming; past items drop off.
  const EVENT_CAP = 10;
  function dayEvents(working, dateStr, nowMin, visits = []) {
    const now = [], next = [];
    for (const w of working) {
      const s = toMin(w.shift.start), e = shiftEndMin(w.shift);
      const name = firstName(w.e.name);
      const add = (list, ev) => list.push({ e: w.e, ...ev });
      if (nowMin < s) add(next, { t: s, kind: 'start', text: `${name}'s shift starts`, sub: `${fmtTime(w.shift.start)} – ${fmtTime(w.shift.end)}` });
      const spans = [
        ...breakSpans(w.e, w.shift).map((x) => ({ ...x, kind: x.b.kind, what: x.b.kind === 'lunch' ? 'lunch' : 'a break', label: x.b.kind === 'lunch' ? 'lunch' : 'break' })),
        ...meetingSpans(w.e, dateStr, w.shift).map((x) => ({ ...x, kind: 'meeting', what: `a meeting: ${x.m.title}`, label: `a meeting: ${x.m.title}` })),
      ];
      for (const x of spans) {
        if (x.from <= nowMin && nowMin < x.to) add(now, { t: x.from, until: x.to, kind: x.kind, text: `${name} is ${x.kind === 'meeting' ? 'in' : 'on'} ${x.label}` });
        else if (nowMin < x.from) add(next, { t: x.from, until: x.to, kind: x.kind, text: `${name} has ${x.what}` });
      }
      for (const x of splitSpans(w.e, dateStr, w.shift)) {
        if (x.from <= nowMin && nowMin < x.to) add(now, { t: x.from, until: x.to, kind: 'split', text: `${name} is covering ${x.region}` });
        else if (nowMin < x.from) add(next, { t: x.from, until: x.to, kind: 'split', text: `${name} covers ${x.region}` });
      }
      if (nowMin < e) add(next, { t: e, kind: 'end', text: `${name}'s shift ends` });
    }
    // People from other regions covering the region being viewed.
    for (const { w, spans } of visits) {
      const name = firstName(w.e.name), home = regionLabel(regionOf(w.e));
      for (const x of spans) {
        if (x.from <= nowMin && nowMin < x.to) now.push({ e: w.e, t: x.from, until: x.to, kind: 'split', text: `${name} (${home}) is covering here` });
        else if (nowMin < x.from) next.push({ e: w.e, t: x.from, until: x.to, kind: 'split', text: `${name} (${home}) covers here` });
      }
    }
    now.sort((a, b) => a.until - b.until);
    next.sort((a, b) => a.t - b.t || a.e.name.localeCompare(b.e.name));
    return { now, next };
  }
  function relTime(mins) {
    if (mins <= 0) return 'now';
    if (mins < 60) return `in ${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return `in ${h} hr${m ? ` ${m} min` : ''}`;
  }

  function renderTimeOff(onPto, pendingPto, notScheduled, working = []) {
    const section = (title, count, body) => `<div class="panel-sec"><h3><span>${title}</span><span>${count}</span></h3>${body}</div>`;
    const sub = (e, text) => `${S.region === 'all' ? regionTag(e) + ' ' : ''}${text}`;
    const isToday = S.homeDate === ymd(new Date());
    let html = `<div class="card-head"><h2>Events</h2>${isToday ? `<span class="live-dot" title="Updates automatically">Live</span>` : ''}</div>`;
    if (!S.employees.length) {
      $('#time-off').innerHTML = html + `<div class="empty">No team members yet.</div>`;
      return;
    }

    // 1. PTO always first.
    const ptoRows = [
      ...onPto.map((p) => personRow(p.e, `<span class="tag approved">PTO</span>`, sub(p.e, esc(fmtRange(p.req.start, p.req.end))))),
      ...pendingPto.map((x) => personRow(x.e, `<span class="tag pending">Pending</span>`, sub(x.e, esc(fmtRange(x.pending.start, x.pending.end))))),
    ];
    const calIcon = `<svg class="sec-ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="4" width="18" height="17" rx="3"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>`;
    const clockIcon = `<svg class="sec-ico" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
    html += section(`${calIcon}PTO`, ptoRows.length, ptoRows.length ? ptoRows.join('') : `<div class="empty">Nobody is on PTO ${isToday ? 'today' : 'this day'}.</div>`);

    // 2. Live feed (today) or the day's schedule (other days), capped.
    const d = new Date();
    const nowMin = isToday ? d.getHours() * 60 + d.getMinutes() : -1;
    const visits = S.region === 'all' ? [] : visitorsFor(S.region, S.homeDate);
    const { now, next } = dayEvents(working, S.homeDate, nowMin, visits);
    const shownNow = now.slice(0, EVENT_CAP);
    const shownNext = next.slice(0, EVENT_CAP - shownNow.length);
    const evRow = (ev, right) => `<div class="ev ev-${ev.kind}">
        ${avatar(ev.e, 'xs')}
        <div class="ev-text">${esc(ev.text)}</div>
        <div class="ev-when">${right}</div>
      </div>`;
    let feed = '';
    if (shownNow.length)
      feed += `<div class="ev-head">Now</div>` + shownNow.map((ev) => evRow(ev, `until ${minToTime(ev.until)}<small>${ev.until - nowMin} min left</small>`)).join('');
    if (shownNext.length)
      feed +=
        (isToday ? `<div class="ev-head">Up next</div>` : '') +
        shownNext.map((ev) => evRow(ev, isToday ? `${relTime(ev.t - nowMin)}<small>${minToTime(ev.t)}</small>` : minToTime(ev.t))).join('');
    const total = now.length + next.length;
    if (total > EVENT_CAP) feed += `<div class="ev-more">+${total - EVENT_CAP} more later</div>`;
    html += section(
      `${clockIcon}${isToday ? 'Today' : 'Schedule'}`,
      '',
      feed || `<div class="empty">${isToday && working.length ? 'Nothing else coming up today.' : 'Nobody scheduled.'}</div>`
    );

    // 3. People with the day off (admins can add a shift from here).
    if (notScheduled.length)
      html += section(
        'Not scheduled',
        notScheduled.length,
        notScheduled
          .map((o) => {
            const hol = holidayOn(S.homeDate);
            const why = hol && (hol.kind === 'full' || o.e.schedule[parseYmd(S.homeDate).getDay()].on) ? esc(hol.name) : 'Regular day off';
            return personRow(o.e, S.admin ? `<button class="btn ghost xs" data-add-shift="${o.e.id}">Add shift</button>` : '', sub(o.e, why));
          })
          .join('')
      );
    $('#time-off').innerHTML = html;
  }

  // ---------- PTO tab: PTO-only calendar ----------
  function renderPtoFilters() {
    const regs = ['all', ...regionTabs()];
    if (!regs.includes(S.ptoRegion)) S.ptoRegion = 'all';
    $('#pto-region').innerHTML = regs.map((r) => `<option value="${esc(r)}">${r === 'all' ? 'All regions' : esc(regionLabel(r))}</option>`).join('');
    $('#pto-region').value = S.ptoRegion;

    const people = S.employees.filter((e) => visibleEmp(e) && inRegion(e, S.ptoRegion));
    if (!people.some((e) => e.id === S.calFilter)) S.calFilter = 'all';
    $('#cal-employee').innerHTML = `<option value="all">Everyone</option>` + people.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('');
    $('#cal-employee').value = S.calFilter;
  }

  function ptoVisible(e) {
    return visibleEmp(e) && inRegion(e, S.ptoRegion) && (S.calFilter === 'all' || e.id === S.calFilter);
  }

  function renderCalendar() {
    const y = S.view.getFullYear(), m = S.view.getMonth();
    $('#cal-title').textContent = S.view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const monthStart = ymd(new Date(y, m, 1)), monthEnd = ymd(new Date(y, m + 1, 0));
    const inMonth = S.pto.filter((p) => p.status !== 'denied' && p.start <= monthEnd && p.end >= monthStart && emp(p.employeeId) && ptoVisible(emp(p.employeeId)));
    const approved = inMonth.filter((p) => p.status === 'approved').length;
    $('#cal-sub').textContent = `${approved} approved · ${inMonth.length - approved} pending this month`;

    const first = new Date(y, m, 1);
    const start = new Date(y, m, 1 - first.getDay());
    const weeks = Math.ceil((first.getDay() + new Date(y, m + 1, 0).getDate()) / 7);
    const today = ymd(new Date());
    const MAX_LANES = 4;
    const reqs = S.pto.filter((p) => p.status !== 'denied' && emp(p.employeeId) && ptoVisible(emp(p.employeeId)));
    let html = '';

    // Draw one row per week. Each PTO request becomes a bar spanning its days in
    // that week; a request that crosses a weekend continues on the next row.
    for (let w = 0; w < weeks; w++) {
      const days = Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i));
      const ws = ymd(days[0]), we = ymd(days[6]);

      const segs = reqs
        .filter((p) => p.start <= we && p.end >= ws)
        .map((p) => {
          const s = p.start < ws ? ws : p.start;
          const e = p.end > we ? we : p.end;
          return { p, e: emp(p.employeeId), col: daysBetween(ws, s) - 1, span: daysBetween(s, e), contL: p.start < ws, contR: p.end > we };
        })
        .sort((a, b) => a.col - b.col || b.span - a.span || (a.p.status === b.p.status ? a.e.name.localeCompare(b.e.name) : a.p.status === 'approved' ? -1 : 1));

      // Holidays go in the top lane first, then PTO bars are stacked into the
      // first lane that's free for all of their days.
      const holSegs = days.flatMap((d, i) => holidaysOn(ymd(d)).map((h) => ({ h, col: i, span: 1 })));
      const occ = []; // occ[lane][col] = taken
      const place = (sg) => {
        let lane = 0;
        while (occ[lane] && [...Array(sg.span)].some((_, k) => occ[lane][sg.col + k])) lane++;
        occ[lane] = occ[lane] || Array(7).fill(false);
        for (let k = 0; k < sg.span; k++) occ[lane][sg.col + k] = true;
        sg.lane = lane;
      };
      holSegs.forEach(place);
      segs.forEach(place);
      const lanes = Math.min(occ.length, MAX_LANES);
      const count = Array(7).fill(0), hidden = Array(7).fill(0);
      for (const sg of segs) {
        for (let c = sg.col; c < sg.col + sg.span; c++) {
          count[c]++;
          if (sg.lane >= MAX_LANES) hidden[c]++;
        }
      }

      const cells = days
        .map((d, i) => {
          const ds = ymd(d);
          const hol = holidayOn(ds);
          const cls = ['day', d.getMonth() !== m && 'other', ds === today && 'today', ds === S.selected && 'selected', (d.getDay() === 0 || d.getDay() === 6) && 'weekend', hol && 'holiday']
            .filter(Boolean)
            .join(' ');
          return `<button class="${cls}" data-date="${ds}" aria-label="${fmtDate(ds, { weekday: 'long', month: 'long', day: 'numeric' })}${hol ? `, ${esc(hol.name)}` : ''}${count[i] ? `, ${count[i]} on PTO` : ''}">
            <div class="day-top"><span class="day-num">${d.getDate()}</span>${count[i] ? `<span class="day-count">${count[i]} off</span>` : ''}</div>
            ${hidden[i] ? `<span class="more">+${hidden[i]} more</span>` : ''}
          </button>`;
        })
        .join('');

      const holBars = holSegs
        .filter((sg) => sg.lane < MAX_LANES)
        .map(
          (sg) =>
            `<div class="pto-bar hol-bar ${sg.h.kind}" style="grid-column:${sg.col + 1} / span 1;grid-row:${sg.lane + 1}" title="${esc(sg.h.name)}: ${esc(holidayLabel(sg.h))}">${esc(sg.h.name)}${sg.h.kind === 'half' ? ' <em>½ day</em>' : ''}</div>`
        )
        .join('');
      const bars = holBars + segs
        .filter((sg) => sg.lane < MAX_LANES)
        .map((sg) => {
          const pending = sg.p.status === 'pending';
          const cls = ['pto-bar', pending && 'pending', sg.contL && 'cont-l', sg.contR && 'cont-r'].filter(Boolean).join(' ');
          const tip = `${sg.e.name}: ${fmtRange(sg.p.start, sg.p.end)}${pending ? ' (pending approval)' : ''}${sg.p.note ? ` — ${sg.p.note}` : ''}`;
          return `<div class="${cls}" style="--c:${sg.e.color};grid-column:${sg.col + 1} / span ${sg.span};grid-row:${sg.lane + 1}" title="${esc(tip)}">${esc(sg.e.name)}${pending ? ' <em>pending</em>' : ''}</div>`;
        })
        .join('');

      html += `<div class="cal-week" style="--lanes:${lanes}"><div class="week-days">${cells}</div><div class="week-bars">${bars}</div></div>`;
    }
    $('#cal-grid').innerHTML = html;
  }

  function renderPtoForm() {
    const sel = $('#pto-form [name=employeeId]');
    const prev = sel.value;
    if (!S.employees.length) {
      sel.innerHTML = `<option value="" disabled selected>No employees yet</option>`;
    } else {
      let opts = `<option value="" disabled ${prev ? '' : 'selected'}>Choose a person…</option>`;
      for (const r of regionTabs()) {
        const list = S.employees.filter((e) => regionOf(e) === r);
        if (list.length) opts += `<optgroup label="${esc(regionLabel(r))}">${list.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}</optgroup>`;
      }
      sel.innerHTML = opts;
    }
    if (S.employees.some((e) => e.id === prev)) sel.value = prev;
    updatePtoHint();
  }

  function updatePtoHint() {
    const f = $('#pto-form');
    const a = f.start.value, b = f.end.value;
    $('#pto-days-hint').textContent = a && b && b >= a ? `${daysBetween(a, b)} calendar day${daysBetween(a, b) === 1 ? '' : 's'}` : '';
  }

  function requestRow(p) {
    const e = emp(p.employeeId);
    if (!e) return '';
    const days = daysBetween(p.start, p.end);
    let btns = '';
    if (S.admin) {
      btns =
        p.status === 'pending'
          ? `<button class="btn ok xs" data-approve="${p.id}">Approve</button><button class="btn ghost xs" data-deny="${p.id}">Deny</button>`
          : `<button class="btn ghost xs" data-reset="${p.id}">Reopen</button><button class="btn ghost xs" data-del-pto="${p.id}">Delete</button>`;
    }
    return `<div class="req">
      ${avatar(e)}
      <div class="req-main">
        <div class="req-title">${esc(e.name)} ${regionTag(e)} <span class="tag ${esc(p.status)}">${esc(p.status[0].toUpperCase() + p.status.slice(1))}</span></div>
        <div class="req-meta">${esc(fmtRange(p.start, p.end))} · ${days} day${days === 1 ? '' : 's'}</div>
        ${p.note ? `<div class="req-note">“${esc(p.note)}”</div>` : ''}
      </div>
      <div class="req-actions">${btns}</div>
    </div>`;
  }

  function renderPtoList() {
    $$('#pto-filter button').forEach((b) => b.classList.toggle('on', b.dataset.f === S.ptoFilter));
    const list = S.pto
      .filter((p) => (S.ptoFilter === 'all' || p.status === S.ptoFilter) && emp(p.employeeId) && ptoVisible(emp(p.employeeId)))
      .sort((a, b) => b.start.localeCompare(a.start));
    $('#pto-list').innerHTML = list.length
      ? list.map(requestRow).join('')
      : `<div class="empty-big">No ${S.ptoFilter === 'all' ? '' : S.ptoFilter + ' '}requests to show.</div>`;
  }

  // ---------- Admin ----------
  function renderAdmin() {
    $('#admin-login').hidden = S.admin;
    $('#admin-panel').hidden = !S.admin;
    if (!S.admin) return;

    $('#conflict-banner').hidden = !S.conflicts.length;
    $('#conflict-files').textContent = S.conflicts.join(', ');

    const today = ymd(new Date());
    const st = dayStatus(today);
    const pending = S.pto.filter((p) => p.status === 'pending');
    const upcoming = S.pto.filter((p) => p.status === 'approved' && p.end >= today).length;
    $('#admin-stats').innerHTML = [
      [S.employees.length, 'Team members'],
      [st.working.length, 'Working today'],
      [pending.length, 'Pending requests'],
      [upcoming, 'Upcoming approved PTO'],
    ].map(([v, l]) => `<div class="card stat"><div class="stat-v">${v}</div><div class="stat-l">${l}</div></div>`).join('');

    $('#approval-list').innerHTML = pending.length
      ? [...pending].sort((a, b) => a.start.localeCompare(b.start)).map(requestRow).join('')
      : `<div class="empty-big">You're all caught up ✨</div>`;

    if (!S.employees.length) {
      $('#team-list').innerHTML = `<div class="empty-big">No team members yet. Click <b>Add employee</b> to get started.</div>`;
    } else {
      const header = `<div class="tt-row tt-head">
        <span>Employee</span><span>Schedule</span><span>Employee ID</span><span>Contact</span><span>Start date</span><span></span>
      </div>`;
      $('#team-list').innerHTML =
        `<div class="team-table ${S.admin ? '' : 'no-actions'}">` +
        header +
        regionGroups()
          .map((r) => {
            // Earliest start date first; anyone without a start date goes last, by name.
            const list = S.employees
              .filter((e) => regionOf(e) === r)
              .sort((x, y) => (x.startDate || '9999').localeCompare(y.startDate || '9999') || x.name.localeCompare(y.name));
            const hiddenNote = isHidden(r) ? `<em>hidden</em>` : '';
            const head = `<div class="team-group"><i style="--c:${REGION_COLORS[r]}"></i>${esc(regionLabel(r))}${hiddenNote}<span>${list.length}</span></div>`;
            return head + (list.length ? list.map(teamRow).join('') : `<div class="empty tt-empty">No one assigned yet.</div>`);
          })
          .join('') +
        `</div>`;
    }

    $('#folder-name').textContent = `${S.dir?.name || ''}/${DATA_FILE}`;
    $('#split-toggle').checked = splitsEnabled();

    // Coverage hours editor (left alone while someone is editing it).
    if (!S.covDirty) renderCoverageEditor();
    renderHolidays();
    // One entry per day that has a gap, listing each affected region.
    const alerts = [];
    for (let i = 0; i < 14; i++) {
      const d = addDays(today, i);
      const bad = regionGaps(d).filter((x) => x.gaps.length);
      if (bad.length) alerts.push({ d, bad });
    }
    const checked = checkedRegions();
    $('#cov-alerts').innerHTML = !checked.length
      ? `<div class="empty-big">Gap alerts are off for every region. Turn them on under Settings → Regions.</div>`
      : alerts.length
      ? alerts
          .map(
            ({ d, bad }) => `<div class="req">
              <span class="gap-dot"></span>
              <div class="req-main">
                <div class="req-title">${fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric' })}${d === today ? ' <span class="tag pending">Today</span>' : ''}</div>
                ${bad
                  .map((x) => `<div class="req-meta"><span class="rtag" style="--c:${REGION_COLORS[x.region]}">${esc(x.region)}</span> No coverage ${x.gaps.map((g) => esc(fmtGap(g))).join(', ')}</div>`)
                  .join('')}
              </div>
              <button class="btn ghost xs" data-goto-day="${d}" data-goto-region="${bad.length === 1 ? esc(bad[0].region) : 'all'}">View</button>
            </div>`
          )
          .join('')
      : `<div class="empty-big">No coverage gaps in the next 14 days ✓<br><span class="small">Checking ${esc(checked.join(', '))}</span></div>`;

    const adjs = S.overrides
      .filter((o) => o.end >= today && emp(o.employeeId))
      .sort((a, b) => a.start.localeCompare(b.start) || a.employeeId.localeCompare(b.employeeId));
    $('#adj-list').innerHTML = adjs.length
      ? adjs
          .map((o) => {
            const e = emp(o.employeeId);
            return personRow(
              e,
              `<div class="req-actions"><button class="btn ghost xs" data-del-ovr="${o.id}">Remove</button></div>`,
              `${esc(fmtRange(o.start, o.end))} · <b>${fmtTime(o.startTime)} – ${fmtTime(o.endTime)}</b>${o.allDays ? ' · incl. days off' : ''}${o.note ? ' · ' + esc(o.note) : ''}`
            );
          })
          .join('')
      : `<div class="empty-big">No current or upcoming adjustments.</div>`;

    // Regions table: show/hide, and per-region coverage gap alerts.
    $('#region-toggles').innerHTML =
      `<div class="rt-row rt-head"><span>Region</span><span>Show</span><span>Gap alerts</span></div>` +
      REGIONS.map((r) => {
        const n = S.employees.filter((e) => regionOf(e) === r).length;
        const hidden = isHidden(r);
        return `<div class="rt-row">
          <span class="rt-name"><i style="--c:${REGION_COLORS[r]}"></i>${esc(r)}<span class="muted small">${n} ${n === 1 ? 'person' : 'people'}</span></span>
          <label class="toggle"><input type="checkbox" data-region-toggle="${esc(r)}" ${hidden ? '' : 'checked'} aria-label="Show ${esc(r)}" /></label>
          <label class="toggle" title="${hidden ? 'Hidden regions are not checked' : ''}"><input type="checkbox" data-cov-toggle="${esc(r)}" ${alertsOn(r) ? 'checked' : ''} ${hidden ? 'disabled' : ''} aria-label="Gap alerts for ${esc(r)}" /></label>
        </div>`;
      }).join('');
  }

  // ---------- Admin → Holidays ----------
  function renderHolidays() {
    const year = S.holYear || (S.holYear = new Date().getFullYear());
    $('#hol-year-label').textContent = year;
    const rows = (S.data.settings.holidays || [])
      .map((h) => ({ h, date: holidayDate(h, year) }))
      .filter((x) => x.date)
      .sort((a, b) => a.date.localeCompare(b.date));
    const today = ymd(new Date());
    $('#hol-list').innerHTML = rows.length
      ? rows
          .map(
            ({ h, date }) => `<div class="hol-row ${date < today ? 'past' : ''}">
              <div class="hol-date"><b>${fmtDate(date, { month: 'short', day: 'numeric' })}</b><span>${fmtDate(date, { weekday: 'short' })}</span></div>
              <div class="hol-main"><div class="hol-name">${esc(h.name)}</div><div class="hol-rule-text">${esc(ruleLabel(h.rule))}</div></div>
              <span class="tag ${h.kind === 'half' ? 'pending' : 'denied'}">${h.kind === 'half' ? `Half day · closes ${fmtTime(h.closesAt || '12:00')}` : 'Full day'}</span>
              <div class="req-actions">${isAdmin() ? `<button class="btn ghost xs" data-edit-hol="${esc(h.id)}">Edit</button>` : ''}</div>
            </div>`
          )
          .join('')
      : `<div class="empty-big">No holidays in ${year}.</div>`;
  }

  function openHolidayDialog(id = null) {
    const h = id ? S.data.settings.holidays.find((x) => x.id === id) : null;
    S.holEditing = h ? h.id : null;
    const f = $('#hol-form').elements;
    $('#hol-title').textContent = h ? 'Edit holiday' : 'Add holiday';
    const monthOpts = MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('');
    f.fixMonth.innerHTML = monthOpts;
    f.nthMonth.innerHTML = monthOpts;
    f.nthWeekday.innerHTML = DAY_NAMES.map((d, i) => `<option value="${i}">${d}</option>`).join('');
    const r = h?.rule || { type: 'fixed', month: 1, day: 1, observe: true };
    f.holName.value = h?.name || '';
    f.holType.value = r.type;
    f.fixMonth.value = String(r.type === 'fixed' ? r.month : 1);
    f.fixDay.value = String(r.type === 'fixed' ? r.day : 1);
    f.fixObserve.checked = r.type === 'fixed' ? !!r.observe : true;
    f.nthN.value = String(r.type === 'nth' ? r.n : 1);
    f.nthWeekday.value = String(r.type === 'nth' ? r.weekday : 1);
    f.nthMonth.value = String(r.type === 'nth' ? r.month : 1);
    f.oneDate.value = r.type === 'date' ? r.date : '';
    f.holClose.value = h?.closesAt || '12:00';
    setHolKind(h?.kind || 'full');
    $('#hol-delete').hidden = !h;
    updateHolForm();
    $('#hol-dialog').showModal();
    f.holName.focus();
  }
  function setHolKind(kind) {
    S.holKind = kind;
    $$('#hol-kind [data-kind]').forEach((b) => b.classList.toggle('on', b.dataset.kind === kind));
    $('#hol-close-wrap').hidden = kind !== 'half';
    updateHolForm();
  }
  function readHolRule() {
    const f = $('#hol-form').elements;
    const type = f.holType.value;
    if (type === 'fixed') return { type, month: Number(f.fixMonth.value), day: Number(f.fixDay.value), observe: f.fixObserve.checked };
    if (type === 'nth') return { type, month: Number(f.nthMonth.value), weekday: Number(f.nthWeekday.value), n: Number(f.nthN.value) };
    return { type, date: f.oneDate.value };
  }
  // Show only the fields for the chosen rule, and preview the next date.
  function updateHolForm() {
    const f = $('#hol-form').elements;
    $$('#hol-form .hol-rule').forEach((el) => (el.hidden = el.dataset.for !== f.holType.value));
    const rule = readHolRule();
    const y = S.holYear || new Date().getFullYear();
    const dates = [y, y + 1].map((yr) => holidayDate({ rule }, yr)).filter(Boolean);
    $('#hol-preview').textContent = dates.length
      ? `Closed ${dates.map((d) => fmtDate(d, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })).join(' and ')}${S.holKind === 'half' ? ` from ${fmtTime(f.holClose.value || '12:00')}` : ''}`
      : rule.type === 'date' ? 'Pick a date' : '';
  }
  function cleanHoliday() {
    const f = $('#hol-form').elements;
    const name = str(f.holName.value, 'Name', 60);
    const rule = readHolRule();
    if (rule.type === 'fixed') {
      const max = new Date(2024, rule.month, 0).getDate(); // leap year allows Feb 29
      if (!(rule.day >= 1 && rule.day <= max)) throw new Error(`${MONTHS[rule.month - 1]} only has ${max} days`);
    }
    if (rule.type === 'date' && !DATE_RE.test(rule.date)) throw new Error('Please pick a date');
    if (rule.type === 'nth' && rule.n !== -1 && !holidayDate({ rule }, S.holYear || new Date().getFullYear()))
      throw new Error("That month doesn't have that many of that weekday");
    const kind = S.holKind === 'half' ? 'half' : 'full';
    if (kind === 'half' && !TIME_RE.test(f.holClose.value)) throw new Error('Please enter a closing time');
    return { name, rule, kind, ...(kind === 'half' ? { closesAt: f.holClose.value } : {}) };
  }

  // Admin → Coverage hours: one row per shown region with a start/end time
  // and the weekdays it applies.
  function renderCoverageEditor() {
    const order = [1, 2, 3, 4, 5]; // coverage is weekdays only
    $('#cov-editor').innerHTML = REGIONS.filter((r) => !isHidden(r))
      .map((r) => {
        const c = regionCoverage(r);
        const off = !alertsOn(r);
        return `<div class="rc-row" data-region="${esc(r)}">
          <div class="rc-name"><i style="--c:${REGION_COLORS[r]}"></i>${esc(r)}${off ? '<span class="muted small">alerts off</span>' : ''}</div>
          <div class="rc-times">
            <input type="time" class="rc-start" value="${c.start}" step="900" aria-label="${esc(r)} coverage start" />
            <span class="muted">to</span>
            <input type="time" class="rc-end" value="${c.end}" step="900" aria-label="${esc(r)} coverage end" />
          </div>
          <div class="rc-days">${order
            .map((i) => `<button type="button" data-dow="${i}" class="${c.days.includes(i) ? 'on' : ''}" title="${DAY_NAMES[i]}">${DAY_SHORT[i][0]}</button>`)
            .join('')}</div>
        </div>`;
      })
      .join('');
  }
  function readCoverageEditor() {
    const out = {};
    for (const row of $$('#cov-editor .rc-row')) {
      const r = row.dataset.region;
      const start = $('.rc-start', row).value;
      const end = $('.rc-end', row).value;
      if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw new Error(`${r}: please enter a start and end time`);
      if (start === end) throw new Error(`${r}: start and end times can't match`);
      out[r] = { start, end, days: $$('.rc-days .on', row).map((b) => Number(b.dataset.dow)).sort() };
    }
    return out;
  }

  // Schedule cell: a Mon–Sun strip of the days worked, then the hours. Days
  // that share the same hours are grouped onto one line.
  function scheduleCell(e) {
    const order = [1, 2, 3, 4, 5, 6, 0];
    const s = e.schedule;
    const strip = order
      .map((i) => {
        const d = s[i];
        const tip = `${DAY_NAMES[i]}: ${d.on ? `${fmtTime(d.start)} – ${fmtTime(d.end)}` : 'Off'}`;
        return `<span class="wd ${d.on ? 'on' : ''}" title="${tip}">${DAY_SHORT[i][0]}</span>`;
      })
      .join('');
    const groups = new Map();
    order.forEach((i, pos) => {
      if (!s[i].on) return;
      const key = `${s[i].start}-${s[i].end}`;
      if (!groups.has(key)) groups.set(key, { start: s[i].start, end: s[i].end, pos: [] });
      groups.get(key).pos.push(pos);
    });
    const dayLabel = (positions) => {
      const runs = [];
      for (const p of positions) {
        const last = runs[runs.length - 1];
        if (last && last[1] === p - 1) last[1] = p;
        else runs.push([p, p]);
      }
      return runs
        .map(([a, b]) => (a === b ? DAY_SHORT[order[a]] : `${DAY_SHORT[order[a]]}${b - a > 1 ? '–' : ', '}${DAY_SHORT[order[b]]}`))
        .join(', ');
    };
    let hours;
    if (!groups.size) hours = `<div class="tt-sub">No scheduled days</div>`;
    else if (groups.size === 1) {
      const g = [...groups.values()][0];
      hours = `<div class="sched-hours">${fmtTime(g.start)} – ${fmtTime(g.end)}</div>`;
    } else {
      hours = [...groups.values()]
        .map((g) => `<div class="sched-hours"><span class="sched-days">${dayLabel(g.pos)}</span>${fmtTime(g.start)} – ${fmtTime(g.end)}</div>`)
        .join('');
    }
    const bl = breakList(e).sort((a, b) => toMin(a.start) - toMin(b.start));
    const brkLine = bl.length
      ? `<div class="tt-sub">${bl.map((b) => `${b.label} ${fmtTime(b.start)}`).join(' · ')}</div>`
      : '';
    return `<div class="tt-cell tt-sched" data-label="Schedule" style="--c:${e.color}"><div class="week-strip">${strip}</div>${hours}${brkLine}</div>`;
  }

  // One row of the Admin → Team table. Each cell has a main line and a smaller
  // second line; on narrow screens the cells stack with their own labels.
  function teamRow(e) {
    const none = `<span class="tt-none">—</span>`;
    const cell = (label, main, sub = '') => `<div class="tt-cell" data-label="${label}"><div class="tt-main">${main || none}</div>${sub ? `<div class="tt-sub">${sub}</div>` : ''}</div>`;
    const t = e.startDate ? tenure(e.startDate) : '';
    return `<div class="tt-row">
      <div class="tt-cell tt-emp">
        ${avatar(e)}
        <div class="tt-emp-text">
          <div class="tt-main tt-name">${esc(e.name)}${e.supervisor ? ` <span class="tag sup">Supervisor</span>` : ''}</div>
          <div class="tt-sub">${esc(e.role || '')}</div>
        </div>
      </div>
      ${scheduleCell(e)}
      ${(() => {
        const num = e.staffNumber && e.staffNumber !== e.staffId ? esc(e.staffNumber) : '';
        return e.staffId ? cell('Employee ID', esc(e.staffId), num) : cell('Employee ID', num);
      })()}
      ${(() => {
        const mail = e.email ? `<a href="mailto:${esc(e.email)}" title="${esc(e.email)}">${esc(e.email)}</a>` : '';
        const tel = e.phone ? `<a href="tel:${esc(e.phone.replace(/[^\d+]/g, ''))}">${esc(e.phone)}</a>` : '';
        return mail ? cell('Contact', mail, tel) : cell('Contact', tel);
      })()}
      ${cell('Start date', e.startDate ? esc(fmtDate(e.startDate, { month: 'short', day: 'numeric', year: 'numeric' })) : '', esc(t))}
      <div class="tt-actions">${
        // Admins and supervisors can edit; only the admin can remove a supervisor.
        S.admin
          ? `<button class="btn ghost xs" data-edit="${e.id}">Edit</button>` +
            (isAdmin() || !e.supervisor ? `<button class="btn ghost xs" data-del-emp="${e.id}">Remove</button>` : '')
          : ''
      }</div>
    </div>`;
  }

  // ---------- employee dialog ----------
  function openEmployeeDialog(e) {
    S.editingId = e ? e.id : null;
    const f = $('#emp-form');
    $('#emp-dialog-title').textContent = e ? 'Edit employee' : 'Add employee';
    f.name.value = e ? e.name : '';
    const legacyRole = e && e.role && !ROLES.includes(e.role) ? e.role : null;
    f.role.innerHTML =
      `<option value="" disabled>Choose a role…</option>` +
      ROLES.map((r) => `<option value="${r}">${r}</option>`).join('') +
      (legacyRole ? `<option value="${esc(legacyRole)}">${esc(legacyRole)} (old)</option>` : '');
    f.role.value = e && e.role ? e.role : '';
    // Hidden regions aren't offered, unless this person is already in one.
    const choices = REGIONS.filter((r) => !isHidden(r) || (e && regionOf(e) === r));
    f.region.innerHTML =
      `<option value="" disabled>Choose a region…</option>` +
      choices.map((r) => `<option value="${r}">${r}${isHidden(r) ? ' (hidden)' : ''}</option>`).join('');
    f.region.value = e ? regionOf(e) : S.region !== 'all' && REGIONS.includes(S.region) ? S.region : '';
    const used = new Set(S.employees.map((x) => x.color));
    S.editColor = e ? e.color : COLORS.find((c) => !used.has(c)) || COLORS[0];
    renderSwatches();
    const startSched = e ? e.schedule : DAY_NAMES.map((_, i) => ({ on: i > 0 && i < 6, start: '08:00', end: '17:00' }));
    loadEmpSchedule(startSched);
    loadBreaks(e, startSched);
    const el = f.elements;
    for (const k of ['staffId', 'staffNumber', 'email', 'phone', 'startDate']) el[k].value = e?.[k] || '';
    // Supervisor access: the PIN box starts empty; leaving it empty keeps the current PIN.
    el.supervisor.checked = !!e?.supervisor;
    el.supPin.value = '';
    el.supPin.type = 'password';
    el.supPin.placeholder = e?.supPin ? '•••••• (unchanged)' : 'Set a PIN, at least 4 characters';
    $('#sup-show').textContent = 'Show';
    $('#sup-show').hidden = !e?.supPin;
    $('#sup-pin').hidden = !el.supervisor.checked;
    $('#emp-dialog').showModal();
    f.name.focus();
  }

  function renderSwatches() {
    $('#swatches').innerHTML = COLORS.map(
      (c) => `<button type="button" class="swatch ${c === S.editColor ? 'on' : ''}" style="--c:${c}" data-color="${c}" aria-label="Color ${c}"></button>`
    ).join('');
  }

  // ---------- breaks & lunch editor ----------
  // Rows: b0 = Break 1, lunch, b1 = Break 2. Defaults are suggested from the
  // shift: a break ~2 hours in, lunch around the middle, a break ~2 hours before the end.
  function loadBreaks(e, sched) {
    const base = sched.find((d) => d.on) || { start: '08:00', end: '17:00' };
    const s = toMin(base.start), en = shiftEndMin(base);
    const hhmm = (m) => minToHHMM(Math.round(m / 15) * 15);
    const defaults = { b0: hhmm(s + 120), lunch: hhmm((s + en) / 2 - 15), b1: hhmm(en - 120) };
    const cur = { b0: e?.breaks?.[0], lunch: e?.lunch, b1: e?.breaks?.[1] };
    for (const row of $$('#brk-box .brk-row')) {
      const k = row.dataset.k, v = cur[k];
      $('.b-on', row).checked = !!v;
      $('.b-start', row).value = v ? v.start : defaults[k];
      $('.b-mins', row).value = String(v ? v.mins : k === 'lunch' ? 30 : 15);
      row.classList.toggle('off', !v);
    }
  }
  function readBreaks() {
    const get = (k) => {
      const row = $(`#brk-box .brk-row[data-k="${k}"]`);
      return $('.b-on', row).checked ? { start: $('.b-start', row).value, mins: Number($('.b-mins', row).value) } : null;
    };
    return { breaks: [get('b0'), get('b1')], lunch: get('lunch') };
  }
  function minToHHMM(min) {
    const v = ((min % 1440) + 1440) % 1440;
    return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  }

  // ---------- employee weekly schedule (two modes) ----------
  // "simple": one start/end time + the days they work. "advanced": each day
  // has its own hours. Both produce the same 7-day schedule when saved.
  function readSimpleSchedule() {
    const start = $('#ss-start').value || '08:00';
    const end = $('#ss-end').value || '17:00';
    const on = new Set($$('#ss-days .on').map((b) => Number(b.dataset.dow)));
    return DAY_NAMES.map((_, i) => ({ on: on.has(i), start, end }));
  }
  // The hours used on the most working days (Monday-first on a tie).
  function commonHours(sched) {
    const counts = new Map();
    for (const i of [1, 2, 3, 4, 5, 6, 0]) {
      const d = sched[i];
      if (!d.on) continue;
      const k = `${d.start}|${d.end}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let best = null, n = 0;
    for (const [k, c] of counts) if (c > n) [best, n] = [k, c];
    if (!best) return { start: '08:00', end: '17:00' };
    const [start, end] = best.split('|');
    return { start, end };
  }
  function fillSimpleSchedule(sched) {
    const h = commonHours(sched);
    $('#ss-start').value = h.start;
    $('#ss-end').value = h.end;
    $$('#ss-days [data-dow]').forEach((b) => b.classList.toggle('on', !!sched[Number(b.dataset.dow)].on));
  }
  function showSchedMode(mode) {
    S.schedMode = mode;
    $$('#sched-mode [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#sched-simple').hidden = mode !== 'simple';
    $('#sched-advanced').hidden = mode !== 'advanced';
  }
  // Open in "simple" when every working day has the same hours.
  function loadEmpSchedule(sched) {
    const on = sched.filter((d) => d.on);
    const uniform = on.every((d) => d.start === on[0].start && d.end === on[0].end);
    fillSimpleSchedule(sched);
    renderSchedEditor(sched);
    S.simpleDirty = uniform; // a uniform schedule can be rebuilt from "Same hours" safely
    showSchedMode(uniform ? 'simple' : 'advanced');
  }
  // Switching carries the current choices across.
  function setSchedMode(mode) {
    if (mode === S.schedMode) return;
    if (mode === 'advanced') {
      // Only rebuild the per-day rows if something was changed in "Same hours";
      // otherwise flipping back and forth keeps each day's own hours.
      if (S.simpleDirty) renderSchedEditor(readSimpleSchedule());
    } else {
      const sched = readSchedEditor();
      const on = sched.filter((d) => d.on);
      if (on.some((d) => d.start !== on[0].start || d.end !== on[0].end)) {
        const h = commonHours(sched);
        toast(`All selected days will use ${fmtTime(h.start)} – ${fmtTime(h.end)}. Switch back before saving to keep the different hours.`);
      }
      fillSimpleSchedule(sched);
    }
    S.simpleDirty = false;
    showSchedMode(mode);
  }
  function readEmpSchedule() {
    return S.schedMode === 'simple' ? readSimpleSchedule() : readSchedEditor();
  }

  function renderSchedEditor(sched, target = '#sched-editor') {
    const order = [1, 2, 3, 4, 5, 6, 0]; // Monday first
    $(target).innerHTML = order
      .map((i) => {
        const d = sched[i];
        return `<div class="sched-row ${d.on ? '' : 'off'}" data-dow="${i}">
          <label class="toggle"><input type="checkbox" ${d.on ? 'checked' : ''} /> ${DAY_SHORT[i]}</label>
          <div class="times">
            <input type="time" class="t-start" value="${d.start}" step="900" />
            <span class="muted">to</span>
            <input type="time" class="t-end" value="${d.end}" step="900" />
          </div>
        </div>`;
      })
      .join('');
  }

  function readSchedEditor(target = '#sched-editor') {
    const out = Array(7);
    $$(`${target} .sched-row`).forEach((row) => {
      out[Number(row.dataset.dow)] = {
        on: $('input[type=checkbox]', row).checked,
        start: $('.t-start', row).value || '08:00',
        end: $('.t-end', row).value || '17:00',
      };
    });
    return out;
  }

  // ---------- bar menu + meeting blocks ----------
  function openBarMenu(x, y, empId, at) {
    const e = emp(empId);
    const menu = $('#bar-menu');
    S.menu = { emp: empId, at };
    $('#bar-menu-head').textContent = e.name;
    $('[data-act="adjust"]', menu).hidden = !S.admin;
    $('[data-act="split"]', menu).hidden = !S.admin || !splitsEnabled();
    menu.hidden = false;
    const w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
    menu.style.top = (y + 10 + h > window.innerHeight ? y - h - 10 : y + 10) + 'px';
  }
  function closeBarMenu() {
    const menu = $('#bar-menu');
    if (menu && !menu.hidden) menu.hidden = true;
  }

  function openMeetingDialog(empId, dateStr, { id = null, at = null } = {}) {
    const e = emp(empId);
    if (!e) return;
    const shift = effectiveShift(e, dateStr);
    const m = id ? S.meetings.find((x) => x.id === id) : null;
    S.mtg = { empId, date: dateStr, id: m ? m.id : null };
    const f = $('#mtg-form').elements;
    $('#mtg-title').textContent = m ? 'Edit meeting block' : 'Add meeting block';
    $('#mtg-sub').textContent = `${e.name} · ${fmtDate(dateStr, { weekday: 'short', month: 'short', day: 'numeric' })} · on shift ${fmtTime(shift.start)} – ${fmtTime(shift.end)}`;
    const hhmm = (min) => {
      const v = ((min % 1440) + 1440) % 1440;
      return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
    };
    const start = at ?? toMin(shift.start);
    f.mtgName.value = m ? m.title : '';
    f.mtgStart.value = m ? m.startTime : hhmm(start);
    f.mtgEnd.value = m ? m.endTime : hhmm(Math.min(start + 60, shiftEndMin(shift)));
    // Repeat options are worded from the series' first day (or this day for a new one).
    const seriesStart = m ? m.date : dateStr;
    f.mtgRepeat.innerHTML = REPEAT_KINDS.map((k) => `<option value="${k}">${esc(repeatLabel(k, seriesStart))}</option>`).join('');
    f.mtgRepeat.value = m?.repeat || 'none';
    f.mtgUntil.value = m?.until || '';
    f.mtgUntil.min = seriesStart;
    const recurring = !!m && (m.repeat || 'none') !== 'none';
    $('#mtg-scope').hidden = !recurring;
    setMtgScope('one');
    updateMtgRepeatUI();
    $('#mtg-delete').hidden = !m;
    $('#mtg-dialog').showModal();
    f.mtgName.focus();
  }
  function updateMtgRepeatUI() {
    $('#mtg-until-wrap').style.visibility = $('#mtg-form').elements.mtgRepeat.value === 'none' ? 'hidden' : 'visible';
  }
  // "This day only" vs "Every day in the series" when editing a repeating meeting.
  function setMtgScope(scope) {
    S.mtgScope = scope;
    $$('#mtg-scope-seg [data-scope]').forEach((b) => b.classList.toggle('on', b.dataset.scope === scope));
    const f = $('#mtg-form').elements;
    const m = S.mtg?.id && S.meetings.find((x) => x.id === S.mtg.id);
    // A single day can't change how the series repeats.
    const lock = !!m && (m.repeat || 'none') !== 'none' && scope === 'one';
    f.mtgRepeat.disabled = lock;
    f.mtgUntil.disabled = lock;
    if (lock) {
      f.mtgRepeat.value = m.repeat;
      f.mtgUntil.value = m.until || '';
    }
  }

  // ---------- adjust hours (overrides) ----------
  function openOverrideDialog(empId, dateStr, { mode = 'hours', splitId = null } = {}) {
    const e = emp(empId);
    if (!e) return;
    S.ovrDate = dateStr;
    const base = e.schedule[parseYmd(dateStr).getDay()];
    const shift = effectiveShift(e, dateStr);
    const o = shift.override || null;
    const dayName = fmtDate(dateStr, { weekday: 'long' });
    S.ovrEmp = e.id;
    S.ovrExisting = o ? o.id : null;
    const f = $('#ovr-form');
    S.ovrTitleBase = base.on ? 'Adjust hours' : 'Add shift';
    $('#ovr-title').textContent = `${S.ovrTitleBase}: ${e.name}`;
    $('#ovr-usual').textContent = base.on
      ? `Usual hours on ${dayName}s: ${fmtTime(base.start)} – ${fmtTime(base.end)}`
      : `${firstName(e.name)} is normally off on ${dayName}s.`;
    f.start.value = dateStr;
    f.end.value = dateStr;
    f.end.min = dateStr;
    const hours = shift.on ? shift : typicalHours(e);
    f.startTime.value = hours.start;
    f.endTime.value = hours.end;
    f.note.value = '';
    // On a day off the shift must include days off, so the box is ticked and locked.
    f.allDays.checked = !base.on || !!o?.allDays;
    f.allDays.disabled = !base.on;
    updateOvrHint();
    $('#ovr-existing').hidden = !o;
    if (o) $('#ovr-existing-text').textContent = `This day already has an adjustment (${fmtRange(o.start, o.end)}, ${fmtTime(o.startTime)} – ${fmtTime(o.endTime)}${o.note ? ', ' + o.note : ''}).`;
    fillSplitFields(e, dateStr, shift, splitId);
    $('#ovr-mode').hidden = !splitsEnabled();
    setOvrMode(splitsEnabled() && (mode === 'split' || splitId) ? 'split' : 'hours');
    $('#ovr-dialog').showModal();
    (S.ovrMode === 'split' ? f.elements.splitRegion : f.startTime).focus();
  }

  // ---------- split shift fields (inside the Adjust hours window) ----------
  function fillSplitFields(e, dateStr, shift, splitId) {
    const f = $('#ovr-form').elements;
    const sp = splitId ? S.splits.find((x) => x.id === splitId) : null;
    S.splitEditing = sp ? sp.id : null;
    const others = REGIONS.filter((r) => r !== regionOf(e) && !isHidden(r));
    f.splitRegion.innerHTML = others.map((r) => `<option value="${r}">${r}</option>`).join('');
    f.splitRegion.value = sp?.region || others[0] || '';
    const seriesStart = sp ? sp.date : dateStr;
    f.splitDate.value = seriesStart;
    // Suggest the middle two hours of their shift.
    const s = shift.on ? toMin(shift.start) : 9 * 60, en = shift.on ? shiftEndMin(shift) : 17 * 60;
    const mid = Math.round((s + en) / 2 / 30) * 30;
    f.splitStart.value = sp ? sp.startTime : minToHHMM(Math.max(s, mid - 60));
    f.splitEnd.value = sp ? sp.endTime : minToHHMM(Math.min(en, mid + 60));
    const label = (k) => ({ none: "Doesn't repeat", daily: 'Every day', weekly: `Every week on ${DAY_NAMES[parseYmd(seriesStart).getDay()]}` }[k]);
    f.splitRepeat.innerHTML = ['none', 'daily', 'weekly'].map((k) => `<option value="${k}">${label(k)}</option>`).join('');
    f.splitRepeat.value = sp?.repeat || 'none';
    f.splitUntil.value = sp?.until || '';
    f.splitUntil.min = seriesStart;
    $('#split-intro').textContent = `${firstName(e.name)} (${regionLabel(regionOf(e))}) works part of the shift for another region. That time counts toward the other region's coverage, not ${regionLabel(regionOf(e))}'s.`;
    $('#split-scope').hidden = !(sp && sp.repeat !== 'none');
    $('#split-delete').hidden = !sp;
    setSplitScope('one');
    updateSplitUI();
  }
  function setOvrMode(mode) {
    S.ovrMode = mode;
    $$('#ovr-mode [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#ovr-hours').hidden = mode !== 'hours';
    $('#ovr-split').hidden = mode !== 'split';
    $('#ovr-save').textContent = mode === 'split' ? 'Save split' : 'Save hours';
    $('#split-delete').hidden = mode !== 'split' || !S.splitEditing;
    const e = emp(S.ovrEmp);
    if (e) $('#ovr-title').textContent = `${mode === 'split' ? 'Split shift' : S.ovrTitleBase}: ${e.name}`;
  }
  function updateSplitUI() {
    $('#split-until-wrap').style.visibility = $('#ovr-form').elements.splitRepeat.value === 'none' ? 'hidden' : 'visible';
  }
  function setSplitScope(scope) {
    S.splitScope = scope;
    $$('#split-scope-seg [data-scope]').forEach((b) => b.classList.toggle('on', b.dataset.scope === scope));
    const f = $('#ovr-form').elements;
    const sp = S.splitEditing && S.splits.find((x) => x.id === S.splitEditing);
    const lock = !!sp && sp.repeat !== 'none' && scope === 'one';
    f.splitRepeat.disabled = lock;
    f.splitUntil.disabled = lock;
    f.splitDate.disabled = !!sp; // a series keeps its first day
  }
  function cleanSplit() {
    const f = $('#ovr-form').elements;
    const e = emp(S.ovrEmp);
    const region = f.splitRegion.value;
    if (!REGIONS.includes(region) || region === regionOf(e)) throw new Error('Choose the region they will cover');
    const date = S.splitEditing ? S.splits.find((x) => x.id === S.splitEditing).date : f.splitDate.value;
    if (!DATE_RE.test(date)) throw new Error('Choose a starting date');
    const startTime = f.splitStart.value, endTime = f.splitEnd.value;
    if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) throw new Error('Enter the hours they will cover');
    if (startTime === endTime) throw new Error("Start and end times can't match");
    const repeat = ['none', 'daily', 'weekly'].includes(f.splitRepeat.value) ? f.splitRepeat.value : 'none';
    const until = repeat === 'none' ? '' : f.splitUntil.value;
    if (until && until < date) throw new Error('"Until" is before the split starts');
    // It has to overlap their shift on the day it starts (or the day being edited).
    const day = S.splitEditing ? S.ovrDate : date;
    const shift = effectiveShift(e, day);
    const probe = { id: '_', employeeId: e.id, region, date: day, startTime, endTime, repeat: 'none' };
    const saved = S.splits;
    S.splits = [probe];
    const inside = splitSpans(e, day, shift).length > 0;
    S.splits = saved;
    if (!inside) throw new Error(shift.on ? `That's outside ${firstName(e.name)}'s hours (${fmtTime(shift.start)} – ${fmtTime(shift.end)})` : `${firstName(e.name)} isn't working on ${fmtDate(day)}`);
    return { region, date, startTime, endTime, repeat, until };
  }

  function updateOvrHint() {
    const f = $('#ovr-form');
    $('#ovr-hint').textContent = f.allDays.checked
      ? 'Applies to every day in the range, including their regular days off. Their weekly schedule isn’t changed.'
      : 'Only changes days this person normally works. Their weekly schedule isn’t changed.';
  }

  function cleanOverride(f) {
    const start = f.start.value, end = f.end.value, startTime = f.startTime.value, endTime = f.endTime.value;
    if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw new Error('Please enter valid dates');
    if (end < start) throw new Error('End date is before start date');
    if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) throw new Error('Please enter a start and end time');
    if (startTime === endTime) throw new Error("Start and end times can't match");
    return { start, end, startTime, endTime, allDays: !!f.allDays.checked, note: str(f.note.value, 'Note', 120, false) };
  }

  // ---------- data changes ----------
  function findIn(list, id, label) {
    const item = list.find((x) => x.id === id);
    if (!item) throw new Error(`That ${label} no longer exists (someone may have just removed it)`);
    return item;
  }
  const setStatus = async (id, status, msg) => {
    const ok = await mutate((d) => {
      const p = findIn(d.pto, id, 'request');
      p.status = status;
      p.decidedAt = status === 'pending' ? null : new Date().toISOString();
    }, msg);
    const p = S.pto.find((x) => x.id === id);
    if (ok && status === 'approved' && p) warnGaps(p.start, p.end, regionOf(emp(p.employeeId) || {}));
    return ok;
  };

  function prefillPto(dateStr) {
    const f = $('#pto-form');
    f.start.value = f.end.value = dateStr;
    f.end.min = dateStr;
    updatePtoHint();
  }

  // ---------- events ----------
  function bind() {
    window.addEventListener('hashchange', showTab);

    // connect screen
    $('#connect-body').addEventListener('click', async (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.id === 'btn-pick') pickFolder();
      if (b.id === 'btn-reconnect') {
        try {
          const dir = await idbGet('dir');
          if ((await dir.requestPermission({ mode: 'readwrite' })) === 'granted') await connect(dir);
          else toast('Access was not allowed', true);
        } catch (e) {
          toast(friendly(e), true);
        }
      }
      if (b.id === 'btn-create') {
        try {
          await connect(S.pendingDir, { create: true, samples: $('#chk-sample').checked });
          toast(`Created ${DATA_FILE}. The admin PIN is ${DEFAULT_PIN}; change it in Admin.`);
        } catch (e) {
          toast(friendly(e), true);
        }
      }
    });

    // Home: day navigation + region
    const goDay = (n) => { S.homeDate = n === 0 ? ymd(new Date()) : addDays(S.homeDate, n); renderHome(); };
    $('#day-prev').onclick = () => goDay(-1);
    $('#day-next').onclick = () => goDay(1);
    $('#day-today').onclick = () => goDay(0);
    $('#day-pick').onchange = (ev) => { if (DATE_RE.test(ev.target.value)) { S.homeDate = ev.target.value; renderHome(); } };
    $('#day-pick-btn').onclick = (ev) => {
      ev.stopPropagation();
      const p = $('#day-pick');
      p.value = S.homeDate;
      openDatePicker(p, ev.currentTarget);
    };
    bindPickers();
    $('#region-tabs').onclick = (ev) => {
      const b = ev.target.closest('[data-region]');
      if (!b) return;
      S.region = b.dataset.region;
      localStorage.setItem('sdh-region', S.region);
      renderHome();
    };
    $('#timeline').addEventListener('click', (ev) => {
      const bar = ev.target.closest('.tl-bar[data-emp]');
      if (!bar) return;
      ev.stopPropagation();
      const block = ev.target.closest('.mtg[data-mtg]');
      if (block) return openMeetingDialog(bar.dataset.emp, S.homeDate, { id: block.dataset.mtg });
      const split = ev.target.closest('.split[data-split]');
      if (split && S.admin) return openOverrideDialog(bar.dataset.emp, S.homeDate, { splitId: split.dataset.split });
      // Turn the click position into a time, to suggest a meeting start.
      const e = emp(bar.dataset.emp);
      const shift = effectiveShift(e, S.homeDate);
      const r = bar.getBoundingClientRect();
      const s = toMin(shift.start), end = shiftEndMin(shift);
      const at = Math.floor((s + ((ev.clientX - r.left) / r.width) * (end - s)) / 15) * 15;
      openBarMenu(ev.clientX, ev.clientY, e.id, Math.min(Math.max(at, s), end - 15));
    });
    $('#bar-menu').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-act]');
      if (!b) return;
      const { emp: empId, at } = S.menu;
      closeBarMenu();
      if (b.dataset.act === 'meeting') openMeetingDialog(empId, S.homeDate, { at });
      if (b.dataset.act === 'adjust') openOverrideDialog(empId, S.homeDate);
      if (b.dataset.act === 'split') openOverrideDialog(empId, S.homeDate, { mode: 'split' });
    });
    document.addEventListener('click', (ev) => {
      if (!ev.target.closest('#bar-menu')) closeBarMenu();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') closeBarMenu();
    });
    window.addEventListener('scroll', closeBarMenu, { passive: true });

    $$('#mtg-dialog [data-close]').forEach((b) => (b.onclick = () => $('#mtg-dialog').close()));
    $('#mtg-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target.elements;
      const { empId, date, id } = S.mtg;
      let clean;
      try {
        const title = str(f.mtgName.value, 'Meeting name', 60);
        const startTime = f.mtgStart.value, endTime = f.mtgEnd.value;
        if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) throw new Error('Please enter a start and end time');
        if (startTime === endTime) throw new Error("Start and end times can't match");
        const e = emp(empId);
        const shift = effectiveShift(e, date);
        const probe = { id: '_', employeeId: empId, date, startTime, endTime, title };
        const saved = S.meetings;
        S.meetings = [probe];
        const inside = meetingSpans(e, date, shift).length > 0;
        S.meetings = saved;
        if (!inside) throw new Error(`That's outside ${firstName(e.name)}'s hours (${fmtTime(shift.start)} – ${fmtTime(shift.end)})`);
        const repeat = REPEAT_KINDS.includes(f.mtgRepeat.value) ? f.mtgRepeat.value : 'none';
        const until = repeat === 'none' ? '' : f.mtgUntil.value;
        const series = id ? S.meetings.find((x) => x.id === id) : null;
        if (until && until < (series ? series.date : date)) throw new Error('"Until" is before the meeting starts');
        clean = { title, startTime, endTime, repeat, until };
      } catch (e) {
        return toast(e.message, true);
      }
      const series = id ? S.meetings.find((x) => x.id === id) : null;
      const recurring = !!series && (series.repeat || 'none') !== 'none';
      const oneDay = recurring && S.mtgScope === 'one';
      const ok = await mutate((d) => {
        findIn(d.employees, empId, 'employee');
        if (!id) {
          d.meetings.push({ id: uid(), employeeId: empId, date, ...clean, createdAt: new Date().toISOString() });
        } else if (oneDay) {
          // Change just this day: skip it in the series and add a one-off copy.
          const s = findIn(d.meetings, id, 'meeting');
          s.skip = [...new Set([...(s.skip || []), date])];
          d.meetings.push({ id: uid(), employeeId: empId, date, ...clean, repeat: 'none', until: '', createdAt: new Date().toISOString() });
        } else {
          Object.assign(findIn(d.meetings, id, 'meeting'), clean); // whole series keeps its first day
        }
      }, !id ? (clean.repeat !== 'none' ? 'Repeating meeting added' : 'Meeting block added') : oneDay ? 'Meeting updated for this day' : 'Meeting updated');
      if (ok) {
        $('#mtg-dialog').close();
        // For repeating meetings, check the next two weeks of occurrences.
        const horizon = clean.repeat !== 'none' && !oneDay ? addDays(date, 13) : date;
        warnGaps(date, clean.until && clean.until < horizon ? clean.until : horizon, regionOf(emp(empId) || {}));
      }
    };
    $('#mtg-delete').onclick = async () => {
      const id = S.mtg?.id;
      if (!id) return;
      const series = S.meetings.find((x) => x.id === id);
      const oneDay = !!series && (series.repeat || 'none') !== 'none' && S.mtgScope === 'one';
      const date = S.mtg.date;
      const ok = await mutate((d) => {
        const s = findIn(d.meetings, id, 'meeting');
        if (oneDay) s.skip = [...new Set([...(s.skip || []), date])];
        else d.meetings = d.meetings.filter((m) => m.id !== id);
      }, oneDay ? 'Meeting removed for this day' : series?.repeat && series.repeat !== 'none' ? 'Repeating meeting deleted' : 'Meeting block removed');
      if (ok) $('#mtg-dialog').close();
    };
    $('#mtg-form').elements.mtgRepeat.addEventListener('change', updateMtgRepeatUI);
    $('#mtg-scope-seg').onclick = (ev) => {
      const b = ev.target.closest('[data-scope]');
      if (b) setMtgScope(b.dataset.scope);
    };
    $$('#ovr-dialog [data-close]').forEach((b) => (b.onclick = () => $('#ovr-dialog').close()));
    $('#ovr-form').allDays.addEventListener('change', updateOvrHint);
    $('#ovr-form').start.addEventListener('change', (ev) => {
      const f = $('#ovr-form');
      if (!f.end.value || f.end.value < ev.target.value) f.end.value = ev.target.value;
      f.end.min = ev.target.value;
    });
    $('#ovr-mode').onclick = (ev) => {
      const b = ev.target.closest('[data-mode]');
      if (b) setOvrMode(b.dataset.mode);
    };
    $('#ovr-form').elements.splitRepeat.addEventListener('change', updateSplitUI);
    $('#split-scope-seg').onclick = (ev) => {
      const b = ev.target.closest('[data-scope]');
      if (b) setSplitScope(b.dataset.scope);
    };
    $('#split-delete').onclick = async () => {
      const id = S.splitEditing;
      const sp = id && S.splits.find((x) => x.id === id);
      if (!sp) return;
      const oneDay = sp.repeat !== 'none' && S.splitScope === 'one';
      const day = S.ovrDate;
      const ok = await mutate((d) => {
        const s = findIn(d.splits, id, 'split');
        if (oneDay) s.skip = [...new Set([...(s.skip || []), day])];
        else d.splits = d.splits.filter((x) => x.id !== id);
      }, oneDay ? 'Split removed for this day' : 'Split shift removed');
      if (ok) {
        $('#ovr-dialog').close();
        warnGaps(day, day, regionOf(emp(sp.employeeId) || {}));
      }
    };
    $('#ovr-form').onsubmit = async (ev) => {
      ev.preventDefault();
      if (S.ovrMode === 'split') {
        let clean;
        try {
          clean = cleanSplit();
        } catch (e) {
          return toast(e.message, true);
        }
        const empId = S.ovrEmp, id = S.splitEditing, day = S.ovrDate;
        const sp = id && S.splits.find((x) => x.id === id);
        const oneDay = !!sp && sp.repeat !== 'none' && S.splitScope === 'one';
        const ok = await mutate((d) => {
          d.splits = d.splits || [];
          findIn(d.employees, empId, 'employee');
          if (!id) d.splits.push({ id: uid(), employeeId: empId, ...clean, createdAt: new Date().toISOString() });
          else if (oneDay) {
            // Change just this day: skip it in the series, add a one-off.
            const s = findIn(d.splits, id, 'split');
            s.skip = [...new Set([...(s.skip || []), day])];
            d.splits.push({ id: uid(), employeeId: empId, ...clean, date: day, repeat: 'none', until: '', createdAt: new Date().toISOString() });
          } else Object.assign(findIn(d.splits, id, 'split'), clean);
        }, !id ? `${firstName(emp(empId).name)} covers ${clean.region}${clean.repeat !== 'none' ? ' (repeating)' : ''}` : oneDay ? 'Split updated for this day' : 'Split shift updated');
        if (ok) {
          $('#ovr-dialog').close();
          // Check both the home region (losing them) and the region they cover.
          const end = clean.repeat !== 'none' ? addDays(day, 13) : day;
          warnGaps(day, clean.until && clean.until < end ? clean.until : end, regionOf(emp(empId) || {}));
        }
        return;
      }
      let clean;
      try {
        clean = cleanOverride(ev.target);
      } catch (e) {
        return toast(e.message, true);
      }
      const empId = S.ovrEmp;
      const ok = await mutate((d) => {
        findIn(d.employees, empId, 'employee');
        // Older adjustments that fall entirely inside the new range are replaced by it.
        d.overrides = d.overrides.filter((o) => !(o.employeeId === empId && o.start >= clean.start && o.end <= clean.end));
        d.overrides.push({ id: uid(), employeeId: empId, ...clean, createdAt: new Date().toISOString() });
      }, 'Hours adjusted');
      if (ok) {
        $('#ovr-dialog').close();
        warnGaps(clean.start, clean.end, regionOf(emp(empId) || {}));
      }
    };
    $('#ovr-remove').onclick = async () => {
      const id = S.ovrExisting;
      if (!id) return;
      const ok = await mutate((d) => {
        findIn(d.overrides, id, 'adjustment');
        d.overrides = d.overrides.filter((o) => o.id !== id);
      }, 'Adjustment removed');
      if (ok) $('#ovr-dialog').close();
    };

    $('#time-off').addEventListener('click', (ev) => {
      const a = ev.target.closest('[data-request]');
      if (a) prefillPto(a.dataset.request);
    });

    // PTO calendar
    $('#cal-prev').onclick = () => { S.view = new Date(S.view.getFullYear(), S.view.getMonth() - 1, 1); renderCalendar(); };
    $('#cal-next').onclick = () => { S.view = new Date(S.view.getFullYear(), S.view.getMonth() + 1, 1); renderCalendar(); };
    $('#cal-today').onclick = () => {
      const now = new Date();
      S.view = new Date(now.getFullYear(), now.getMonth(), 1);
      renderCalendar();
    };
    $('#pto-region').onchange = (ev) => { S.ptoRegion = ev.target.value; renderPtoFilters(); renderCalendar(); renderPtoList(); };
    $('#cal-employee').onchange = (ev) => { S.calFilter = ev.target.value; renderCalendar(); renderPtoList(); };
    $('#cal-grid').onclick = (ev) => {
      // A bar sits on top of the days; clicking it picks the day underneath.
      const day = ev.target.closest('.day') || document.elementsFromPoint(ev.clientX, ev.clientY).find((el) => el.classList.contains('day'));
      if (!day) return;
      S.selected = day.dataset.date;
      const d = parseYmd(S.selected);
      if (d.getMonth() !== S.view.getMonth()) S.view = new Date(d.getFullYear(), d.getMonth(), 1);
      renderCalendar();
      prefillPto(S.selected);
    };

    document.addEventListener('keydown', (ev) => {
      if (document.body.classList.contains('disconnected') || ev.target.closest?.('input, select, textarea, dialog') || P.el) return;
      const tab = currentTab();
      if (tab === 'home') {
        if (ev.key === 'ArrowLeft') goDay(-1);
        if (ev.key === 'ArrowRight') goDay(1);
      } else if (tab === 'pto') {
        if (ev.key === 'ArrowLeft') $('#cal-prev').click();
        if (ev.key === 'ArrowRight') $('#cal-next').click();
      }
    });

    // PTO form
    const pf = $('#pto-form');
    pf.start.addEventListener('change', () => {
      if (!pf.end.value || pf.end.value < pf.start.value) pf.end.value = pf.start.value;
      pf.end.min = pf.start.value;
      updatePtoHint();
    });
    pf.end.addEventListener('change', updatePtoHint);
    pf.onsubmit = async (ev) => {
      ev.preventDefault();
      const body = Object.fromEntries(new FormData(pf));
      const ok = await mutate((d) => {
        d.pto.push({ id: uid(), ...cleanPto(body, d), status: 'pending', createdAt: new Date().toISOString(), decidedAt: null });
      }, 'Request submitted');
      if (ok) {
        pf.reset();
        S.selected = null;
        renderCalendar();
        updatePtoHint();
      }
    };
    $('#pto-filter').onclick = (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      S.ptoFilter = b.dataset.f;
      renderPtoList();
    };

    // buttons in lists
    document.addEventListener('click', async (ev) => {
      const t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.approve) setStatus(t.dataset.approve, 'approved', 'Request approved');
      if (t.dataset.deny) setStatus(t.dataset.deny, 'denied', 'Request denied');
      if (t.dataset.reset) setStatus(t.dataset.reset, 'pending', 'Moved back to pending');
      if (t.dataset.delPto && (await confirmBox('Delete request?', 'This removes the request from the shared file.', 'Delete')))
        mutate((d) => { findIn(d.pto, t.dataset.delPto, 'request'); d.pto = d.pto.filter((p) => p.id !== t.dataset.delPto); }, 'Request deleted');
      if (t.dataset.addShift) openOverrideDialog(t.dataset.addShift, S.homeDate);
      if (t.dataset.gotoDay) {
        S.homeDate = t.dataset.gotoDay;
        // Open Home on the affected region (or All regions if several have gaps).
        if (t.dataset.gotoRegion) {
          S.region = t.dataset.gotoRegion;
          localStorage.setItem('sdh-region', S.region);
        }
        location.hash = '#home';
        renderHome();
        window.scrollTo(0, 0);
      }
      if (t.dataset.delOvr)
        mutate((d) => { findIn(d.overrides, t.dataset.delOvr, 'adjustment'); d.overrides = d.overrides.filter((o) => o.id !== t.dataset.delOvr); }, 'Adjustment removed');
      if (t.dataset.edit) openEmployeeDialog(emp(t.dataset.edit));
      if (t.dataset.delEmp) {
        const e = emp(t.dataset.delEmp);
        if (e?.supervisor && !isAdmin()) return toast('Only the admin can remove a supervisor', true);
        if (e && (await confirmBox(`Remove ${e.name}?`, 'Their schedule and all of their PTO requests will be removed from the shared file.', 'Remove')))
          mutate((d) => {
            d.employees = d.employees.filter((x) => x.id !== e.id);
            d.pto = d.pto.filter((p) => p.employeeId !== e.id);
            d.overrides = d.overrides.filter((o) => o.employeeId !== e.id);
            d.meetings = d.meetings.filter((m) => m.employeeId !== e.id);
            d.splits = (d.splits || []).filter((x) => x.employeeId !== e.id);
          }, `${e.name} removed`);
      }
      if (t.id === 'logout') {
        setRole(null);
        renderAll();
        toast('Signed out');
      }
      if (t.id === 'switch-folder') pickFolder();
      if (t.id === 'recheck-conflicts') {
        await scanConflicts();
        renderAdmin();
        toast(S.conflicts.length ? 'Conflict copies still present' : 'No conflict copies found');
      }
    });

    // sign in: the admin PIN, or any supervisor's own PIN
    $('#login-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const pin = f.pin.value;
      const btn = $('button[type=submit]', f);
      btn.disabled = true;
      try {
        if (await isAdminPin(pin)) {
          setRole('admin');
          S.adminKey = await adminKeyFrom(pin, await ensureKeySalt());
          f.reset();
          renderAll();
          return toast('Signed in as admin');
        }
        for (const e of S.employees) {
          if (e.supervisor && (await checkPin(pin, e.supPin))) {
            setRole('supervisor', e.id);
            f.reset();
            renderAll();
            return toast(`Signed in as supervisor: ${e.name}`);
          }
        }
        toast('Incorrect PIN', true);
        f.pin.select();
      } finally {
        btn.disabled = false;
      }
    };

    // coverage hours
    $('#cov-editor').addEventListener('change', () => (S.covDirty = true));
    $('#cov-editor').addEventListener('click', (ev) => {
      const b = ev.target.closest('.rc-days [data-dow]');
      if (!b) return;
      b.classList.toggle('on');
      S.covDirty = true;
    });
    $('#cov-form').onsubmit = async (ev) => {
      ev.preventDefault();
      let rc;
      try {
        rc = readCoverageEditor();
      } catch (e) {
        return toast(e.message, true);
      }
      S.covDirty = false;
      const ok = await mutate((d) => {
        d.settings.regionCoverage = { ...(d.settings.regionCoverage || {}), ...rc };
      }, 'Coverage hours saved');
      if (!ok) S.covDirty = true;
    };

    // split shifts on/off
    $('#split-toggle').addEventListener('change', (ev) => {
      const on = ev.target.checked;
      mutate((d) => { d.settings.splitShifts = on; }, `Split shifts ${on ? 'on' : 'off'}`).then((ok) => {
        if (!ok) ev.target.checked = !on;
      });
    });

    // holidays
    $('#hol-prev').onclick = () => { S.holYear = (S.holYear || new Date().getFullYear()) - 1; renderHolidays(); };
    $('#hol-next').onclick = () => { S.holYear = (S.holYear || new Date().getFullYear()) + 1; renderHolidays(); };
    $('#add-holiday').onclick = () => openHolidayDialog(null);
    $('#hol-list').addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-edit-hol]');
      if (b) openHolidayDialog(b.dataset.editHol);
    });
    $$('#hol-dialog [data-close]').forEach((b) => (b.onclick = () => $('#hol-dialog').close()));
    $('#hol-kind').onclick = (ev) => {
      const b = ev.target.closest('[data-kind]');
      if (b) setHolKind(b.dataset.kind);
    };
    $('#hol-form').addEventListener('change', updateHolForm);
    $('#hol-form').addEventListener('input', updateHolForm);
    $('#hol-form').onsubmit = async (ev) => {
      ev.preventDefault();
      let clean;
      try {
        clean = cleanHoliday();
      } catch (e) {
        return toast(e.message, true);
      }
      const id = S.holEditing;
      const ok = await mutate((d) => {
        if (id) Object.assign(findIn(d.settings.holidays, id, 'holiday'), clean);
        else d.settings.holidays.push({ id: 'h-' + uid(), ...clean });
      }, id ? 'Holiday updated' : `${clean.name} added`);
      if (ok) $('#hol-dialog').close();
    };
    $('#hol-delete').onclick = async () => {
      const id = S.holEditing;
      const h = S.data.settings.holidays.find((x) => x.id === id);
      if (!h || !(await confirmBox(`Remove ${h.name}?`, 'It will no longer appear on the calendar in any year.', 'Remove'))) return;
      const ok = await mutate((d) => {
        findIn(d.settings.holidays, id, 'holiday');
        d.settings.holidays = d.settings.holidays.filter((x) => x.id !== id);
      }, `${h.name} removed`);
      if (ok) $('#hol-dialog').close();
    };

    // show / hide regions
    // per-region coverage gap alerts on/off
    $('#region-toggles').addEventListener('change', (ev) => {
      const r = ev.target.dataset.covToggle;
      if (!r) return;
      const on = ev.target.checked;
      mutate((d) => {
        const off = new Set(d.settings.coverageOff || []);
        if (on) off.delete(r);
        else off.add(r);
        d.settings.coverageOff = REGIONS.filter((x) => off.has(x));
      }, `Gap alerts ${on ? 'on' : 'off'} for ${r}`).then((ok) => {
        if (!ok) ev.target.checked = !on;
      });
    });
    $('#region-toggles').addEventListener('change', (ev) => {
      const r = ev.target.dataset.regionToggle;
      if (!r) return;
      const show = ev.target.checked;
      mutate((d) => {
        const hidden = new Set(d.settings.hiddenRegions);
        if (show) hidden.delete(r);
        else hidden.add(r);
        d.settings.hiddenRegions = REGIONS.filter((x) => hidden.has(x));
      }, `${r} is now ${show ? 'shown' : 'hidden'}`).then((ok) => {
        if (!ok) ev.target.checked = !show;
      });
    });

    // change PIN
    $('#pin-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const pin = f.newpin.value.trim();
      if (pin.length < 4) return toast('Use at least 4 characters', true);
      if (pin !== f.confirmpin.value.trim()) return toast("PINs don't match", true);
      for (const e of S.employees) {
        if (e.supervisor && (await checkPin(pin, e.supPin))) return toast(`That PIN is already ${e.name}'s supervisor PIN`, true);
      }
      // Supervisor PINs are encrypted with the admin PIN, so re-encrypt them
      // with the new one.
      const sups = S.employees.filter((e) => e.supervisor && e.supPin?.enc);
      const reenc = {};
      if (sups.length) {
        const oldKey = await ensureAdminKey();
        if (!oldKey) return;
        const newKey = await adminKeyFrom(pin, await ensureKeySalt());
        try {
          for (const e of sups) reenc[e.id] = await encryptPin(await decryptPin(e.supPin.enc, oldKey), newKey);
        } catch {
          return toast("Couldn't unlock the saved supervisor PINs. Nothing was changed.", true);
        }
        S.pendingKey = newKey;
      }
      const hash = await sha256(pin);
      const ok = await mutate((d) => {
        d.settings.adminPinHash = hash;
        for (const e of d.employees) if (reenc[e.id] && e.supPin) e.supPin.enc = reenc[e.id];
      }, 'Admin PIN changed');
      if (ok) {
        if (S.pendingKey) S.adminKey = S.pendingKey;
        else S.adminKey = await adminKeyFrom(pin, await ensureKeySalt());
        f.reset();
      }
      S.pendingKey = null;
    };

    // employee dialog
    $('#add-employee').onclick = () => openEmployeeDialog(null);
    $$('#emp-dialog [data-close]').forEach((b) => (b.onclick = () => $('#emp-dialog').close()));
    $('#swatches').onclick = (ev) => {
      const s = ev.target.closest('.swatch');
      if (!s) return;
      S.editColor = s.dataset.color;
      renderSwatches();
    };
    $('#sched-editor').addEventListener('change', (ev) => {
      if (ev.target.type === 'checkbox') ev.target.closest('.sched-row').classList.toggle('off', !ev.target.checked);
    });
    // Weekly schedule: Same hours (simple) vs. Different hours per day (advanced)
    $('#sched-mode').onclick = (ev) => {
      const b = ev.target.closest('[data-mode]');
      if (b) setSchedMode(b.dataset.mode);
    };
    $('#ss-days').onclick = (ev) => {
      const b = ev.target.closest('[data-dow]');
      if (!b) return;
      b.classList.toggle('on');
      S.simpleDirty = true;
    };
    $('#sched-simple').addEventListener('change', () => (S.simpleDirty = true));
    $('.ss-quick').onclick = (ev) => {
      const b = ev.target.closest('[data-days]');
      if (!b) return;
      S.simpleDirty = true;
      const want = new Set(b.dataset.days.split(','));
      $$('#ss-days [data-dow]').forEach((d) => d.classList.toggle('on', want.has(d.dataset.dow)));
    };
    $('#emp-form').onsubmit = async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      let clean;
      try {
        const prev = S.editingId ? emp(S.editingId) : null;
        const el = f.elements;
        clean = cleanEmployee(
          {
            name: el.name.value, role: el.role.value, region: el.region.value, color: S.editColor, schedule: readEmpSchedule(), ...readBreaks(),
            staffId: el.staffId.value, staffNumber: el.staffNumber.value, email: el.email.value, phone: el.phone.value, startDate: el.startDate.value,
          },
          prev?.role
        );
        const dupe = clean.staffId && S.employees.find((o) => o.id !== S.editingId && (o.staffId || '').toLowerCase() === clean.staffId.toLowerCase());
        if (dupe) throw new Error(`Employee ID ${clean.staffId} is already used by ${dupe.name}`);
      } catch (e) {
        return toast(e.message, true);
      }
      const editing = S.editingId;
      const prev = editing ? emp(editing) : null;
      // Supervisors can edit employees but never supervisor access or PINs:
      // for them, whatever the person already had is kept as-is.
      const isSup = isAdmin() ? f.elements.supervisor.checked : !!prev?.supervisor;
      const newPin = isAdmin() ? f.elements.supPin.value.trim() : '';
      let supPin = null; // null = keep whatever is there
      if (isSup) {
        if (newPin) {
          if (newPin.length < 4 || newPin.length > 20) return toast('Supervisor PIN must be 4–20 characters', true);
          if (await isAdminPin(newPin)) return toast("That's the admin PIN. Choose a different one.", true);
          for (const o of S.employees) {
            if (o.id !== editing && o.supervisor && (await checkPin(newPin, o.supPin))) return toast(`That PIN is already ${o.name}'s. Choose a different one.`, true);
          }
          const key = await ensureAdminKey();
          if (!key) return;
          supPin = { ...(await hashPin(newPin)), enc: await encryptPin(newPin, key) };
        } else if (!prev?.supPin) {
          return toast('Set a PIN for this supervisor', true);
        }
      }
      const ok = await mutate(
        (d) => {
          const target = editing ? Object.assign(findIn(d.employees, editing, 'employee'), clean) : { id: uid(), ...clean };
          if (!editing) d.employees.push(target);
          target.supervisor = isSup;
          if (!isSup) delete target.supPin;
          else if (supPin) target.supPin = supPin;
        },
        editing ? 'Employee updated' : `${clean.name} added`
      );
      if (ok) $('#emp-dialog').close();
    };

    // breaks & lunch rows dim when switched off
    $('#brk-box').addEventListener('change', (ev) => {
      if (ev.target.classList.contains('b-on')) ev.target.closest('.brk-row').classList.toggle('off', !ev.target.checked);
    });

    // tidy phone numbers as you leave the field
    $('#emp-form').elements.phone.addEventListener('blur', (ev) => { ev.target.value = formatPhone(ev.target.value); });

    // supervisor PIN box
    {
      const el = $('#emp-form').elements;
      el.supervisor.addEventListener('change', () => {
        $('#sup-pin').hidden = !el.supervisor.checked;
        if (el.supervisor.checked && !el.supPin.placeholder.includes('unchanged')) el.supPin.focus();
      });
      $('#sup-gen').onclick = () => {
        el.supPin.value = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
        el.supPin.type = 'text';
        $('#sup-show').hidden = false;
        $('#sup-show').textContent = 'Hide';
      };
      $('#sup-show').onclick = async () => {
        if (el.supPin.type === 'text') {
          el.supPin.type = 'password';
          $('#sup-show').textContent = 'Show';
          return;
        }
        // Nothing typed yet: decrypt and show the saved PIN (admin only).
        if (!el.supPin.value) {
          const e = emp(S.editingId);
          if (!e?.supPin?.enc) return;
          const key = await ensureAdminKey();
          if (!key) return;
          try {
            el.supPin.value = await decryptPin(e.supPin.enc, key);
          } catch {
            return toast("Couldn't unlock this PIN. Set a new one instead.", true);
          }
        }
        el.supPin.type = 'text';
        $('#sup-show').textContent = 'Hide';
      };
    }

    // pick up other people's changes as OneDrive syncs them in
    const poll = () => {
      if (S.fileHandle && !S.saving && !document.hidden) reload().catch(() => {});
    };
    setInterval(poll, POLL_MS);
    window.addEventListener('focus', poll);
    // keep the "Now" line moving
    // Keep the "Now" line and the Events feed current. Skips while a dialog or
    // picker is open so nothing jumps under the user.
    setInterval(() => {
      if (S.data && currentTab() === 'home' && S.homeDate === ymd(new Date()) && !document.querySelector('dialog[open]') && !P.el && $('#bar-menu').hidden) renderHome();
    }, 30000);
  }

  // ---------- time & date pickers ----------
  // The browser's own pickers follow the Windows theme and can't be styled, so
  // time and date fields get site-styled dropdowns instead. Typing still works.
  // The dropdown uses the Popover API so it shows above open dialogs too.
  const P = { el: null, input: null };

  function closePicker() {
    if (!P.el) return;
    try { P.el.hidePopover(); } catch { /* already hidden */ }
    P.el.remove();
    P.el = P.input = null;
  }

  function showPicker(pop, input, anchor) {
    closePicker();
    pop.popover = 'manual';
    // Inside an open dialog the rest of the page can't be clicked, so the
    // picker has to live inside that dialog.
    (anchor.closest('dialog[open]') || document.body).append(pop);
    pop.showPopover();
    P.el = pop;
    P.input = input;
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.top = top + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
  }

  function setValue(input, v) {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function openTimePicker(input) {
    const pop = document.createElement('div');
    pop.className = 'picker time-picker';
    let html = '';
    for (let m = 0; m < 1440; m += 15) {
      const v = `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      html += `<button type="button" data-v="${v}" class="${v === input.value ? 'on' : ''}">${fmtTime(v)}</button>`;
    }
    pop.innerHTML = `<div class="tp-list">${html}</div>`;
    pop.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-v]');
      if (!b) return;
      setValue(input, b.dataset.v);
      closePicker();
    });
    showPicker(pop, input, input);
    pop.style.minWidth = input.getBoundingClientRect().width + 'px';
    // Scroll so the current value (or the nearest 15-minute slot) is centered.
    const list = $('.tp-list', pop);
    const cur = TIME_RE.test(input.value) ? toMin(input.value) : 8 * 60;
    const target = list.children[Math.min(95, Math.round(cur / 15))];
    list.scrollTop = target.offsetTop - list.clientHeight / 2 + target.offsetHeight / 2;
  }

  function openDatePicker(input, anchor = input) {
    const pop = document.createElement('div');
    pop.className = 'picker date-picker';
    const today = ymd(new Date());
    const sel = DATE_RE.test(input.value) ? input.value : null;
    let view = parseYmd(sel || today);
    view = new Date(view.getFullYear(), view.getMonth(), 1);

    const render = () => {
      const y = view.getFullYear(), m = view.getMonth();
      const start = new Date(y, m, 1 - view.getDay());
      let days = '';
      for (let i = 0; i < 42; i++) {
        const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
        const ds = ymd(d);
        const cls = [d.getMonth() !== m && 'other', ds === today && 'today', ds === sel && 'on'].filter(Boolean).join(' ');
        const disabled = input.min && ds < input.min;
        days += `<button type="button" data-d="${ds}" class="${cls}" ${disabled ? 'disabled' : ''}>${d.getDate()}</button>`;
      }
      pop.innerHTML = `
        <div class="dp-head">
          <button type="button" class="dp-nav" data-nav="-1" aria-label="Previous month"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 6l-6 6 6 6"/></svg></button>
          <span>${view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
          <button type="button" class="dp-nav" data-nav="1" aria-label="Next month"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg></button>
        </div>
        <div class="dp-dow">${DAY_SHORT.map((d) => `<span>${d.slice(0, 2)}</span>`).join('')}</div>
        <div class="dp-grid">${days}</div>
        <div class="dp-foot"><button type="button" data-d="${today}" ${input.min && today < input.min ? 'disabled' : ''}>Today</button></div>`;
    };
    render();
    pop.addEventListener('click', (ev) => {
      const nav = ev.target.closest('[data-nav]');
      if (nav) {
        view = new Date(view.getFullYear(), view.getMonth() + Number(nav.dataset.nav), 1);
        return render();
      }
      const b = ev.target.closest('[data-d]');
      if (!b || b.disabled) return;
      setValue(input, b.dataset.d);
      closePicker();
    });
    showPicker(pop, input, anchor);
  }

  function bindPickers() {
    document.addEventListener('click', (ev) => {
      const input = ev.target.closest('input[type=time], input[type=date]');
      if (input && !input.disabled && input.id !== 'day-pick') {
        if (P.input === input) return; // already open for this field
        return input.type === 'time' ? openTimePicker(input) : openDatePicker(input);
      }
      // composedPath() is captured when the click happens, so it still includes
      // the picker even if the click re-rendered it (e.g. the month arrows).
      if (P.el && !ev.composedPath().includes(P.el)) closePicker();
    });
    // Typing a value directly closes the list.
    document.addEventListener(
      'keydown',
      (ev) => {
        if (!P.el) return;
        if (ev.key === 'Escape') ev.preventDefault(); // close just the list, not the dialog behind it
        if (ev.key === 'Escape' || ev.key === 'Tab' || ev.target === P.input) closePicker();
      },
      true
    );
    window.addEventListener('resize', closePicker);
    document.addEventListener('scroll', (ev) => { if (P.el && !P.el.contains(ev.target)) closePicker(); }, true);
    $$('dialog').forEach((d) => d.addEventListener('close', closePicker));
  }

  // ---------- boot ----------
  // When served from a web address (e.g. GitHub Pages), register the service
  // worker so Edge/Chrome can install the site as an app. Installed apps keep
  // folder access permanently, so people aren't asked again every visit.
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    // updateViaCache: 'none' = always check GitHub for a newer sw.js too.
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
  }

  async function boot() {
    try {
      const saved = JSON.parse(sessionStorage.getItem('sdh-role') || 'null');
      if (saved?.role === 'admin' || saved?.role === 'supervisor') setRole(saved.role, saved.supId);
    } catch {
      /* no saved sign-in */
    }
    bind();
    showTab();
    if (!('showDirectoryPicker' in window)) return showConnect('unsupported');
    let dir = null;
    try {
      dir = await idbGet('dir');
    } catch {
      /* no remembered folder */
    }
    if (!dir) return showConnect('first');
    try {
      if ((await dir.queryPermission({ mode: 'readwrite' })) === 'granted') return await connect(dir);
    } catch {
      /* fall through to reconnect */
    }
    showConnect('reconnect', dir);
  }

  boot();
})();
