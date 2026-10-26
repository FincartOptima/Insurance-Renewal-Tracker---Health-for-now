/* Static demo for GitHub Pages: answers the tracker's /api calls inside the browser from
   built-in sample data. Every name, email, phone number and policy here is fictional; no
   real client data is stored in this repository. Edits last until the page is reloaded.
   Mirrors queries.py (filters, timelines, overview) and exports.py (columns). */
(() => {
  'use strict';

  const DEMO_COUNT = 120;
  const UNASSIGNED = 'Unassigned';
  const STATUS_VALUES = ['Not Done', 'Done'];
  const BUCKET_LABELS = {
    overdue: 'Overdue', today: 'Due today', tomorrow: 'Today & tomorrow', next2: 'Next 2 days',
    next7: 'Next 7 days', next14: 'Next 14 days', next30: 'Next 30 days', next60: 'Next 60 days',
    next90: 'Next 90 days', upcoming: 'All upcoming', all: 'All policies',
    no_date: 'Missing renewal date', custom: 'Custom date range',
  };

  /* ---- dates (renewal windows follow India time, like the real app) ---- */
  const DAY_MS = 86400000;
  const todayIST = () => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const dayNumber = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / DAY_MS);
  const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
  const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value + 'T00:00:00Z'));

  /* ---- sample portfolio ---- */
  const CLIENTS = ['Aarav Mehta', 'Priya Sharma', 'Rohan Kapoor', 'Neha Gupta', 'Vikram Shah', 'Ananya Rao',
    'Ishaan Verma', 'Kavya Nair', 'Diya Menon', 'Kabir Singh', 'Sara Khan', 'Arnav Joshi', 'Meher Iyer', 'Dev Malhotra'];
  const PLANS = [
    ['Care Health Insurance', 'Care Supreme', 'Health', 24500],
    ['HDFC Life', 'Click 2 Protect', 'Life', 18750],
    ['ICICI Lombard', 'Complete Health', 'Health', 32800],
    ['Star Health', 'Family Health Optima', 'Health', 21900],
    ['Niva Bupa', 'ReAssure 2.0', 'Health', 27400],
    ['Tata AIG', 'Medicare Premier', 'Health', 29900],
  ];
  const RMS = [['Riya Sen', 'East'], ['Arjun Das', 'West'], ['Meera Shah', 'North'], ['Kunal Bose', 'South'], ['Isha Kulkarni', 'West']];
  const OFFSETS = [-21, -9, -3, 0, 0, 1, 2, 3, 5, 7, 9, 12, 15, 19, 24, 28, 33, 41, 55, 70, 86, -14, -6, 4, 11, 22, 47, 63, -1, 6];
  const SUM_ASSURED = [300000, 500000, 1000000, 2500000];
  const BUSINESS = ['New', 'Renewal', 'Port'];

  const today = todayIST();
  const rows = Array.from({ length: DEMO_COUNT }, (_, i) => {
    const [partner, policy, type, base] = PLANS[(i + (i >> 2)) % PLANS.length];
    const unassigned = i % 17 === 0;
    const [rm, team] = unassigned ? ['', UNASSIGNED] : RMS[(i * 3 + (i >> 1)) % RMS.length];
    const offset = OFFSETS[(i * 11 + (i >> 3)) % OFFSETS.length] + (i % 3) - 1;
    return {
      policy_no: 'FC/DEMO/' + String(i + 1).padStart(4, '0'),
      client_name: CLIENTS[i % CLIENTS.length],
      client_email: 'client' + (i + 1) + '@example.com',
      rm_name: rm,
      policy,
      policy_partner: partner,
      insurance_type: type,
      sum_assured: SUM_ASSURED[i % SUM_ASSURED.length],
      premium_amount: base + (i % 5) * 1100,
      next_premium_date: i % 29 === 0 ? null : addDays(today, offset),
      status: i % 7 === 0 ? 'Done' : 'Not Done',
      remarks: i % 11 === 0 ? 'Client asked for a call back after 5 pm.' : '',
      rescheduled: false,
      phone: '98000' + String(i + 1).padStart(5, '0'),
      team,
      business_type: BUSINESS[i % 5 === 0 ? 2 : i % 2],
    };
  });

  /* ---- queries.py ---- */
  class ApiError extends Error {}
  const daysUntil = (row) => (row.next_premium_date ? dayNumber(row.next_premium_date) - dayNumber(today) : null);
  const monthKey = (row) => (row.next_premium_date ? row.next_premium_date.slice(0, 7) : null);
  const teamOf = (row) => row.team || UNASSIGNED;

  function inBucket(days, bucket) {
    if (bucket === 'all') return true;
    if (bucket === 'no_date') return days === null;
    if (days === null) return false;
    if (bucket === 'overdue') return days < 0;
    if (bucket === 'today') return days === 0;
    if (bucket === 'tomorrow') return days >= 0 && days <= 1;
    if (bucket.startsWith('next')) return days >= 0 && days <= Number(bucket.slice(4));
    return days >= 0;
  }

  const unique = (values) => [...new Set(values)].sort();

  function build(q) {
    const bucket = q.get('bucket') || 'next7';
    const search = (q.get('q') || '').trim().toLowerCase();
    const type = q.get('type') || 'all';
    const team = q.get('team') || 'all';
    const rm = q.get('rm') || 'all';
    const status = q.get('status') || 'all';
    const month = q.get('month') || 'all';
    if (!(bucket in BUCKET_LABELS)) throw new ApiError('Choose a valid renewal timeline.');
    if (status !== 'all' && !STATUS_VALUES.includes(status)) throw new ApiError('Choose a valid follow-up status.');
    let start = null, end = null;
    if (bucket === 'custom') {
      start = q.get('start'); end = q.get('end');
      if (!isIsoDate(start) || !isIsoDate(end)) throw new ApiError('Choose a valid start and end date.');
      if (start > end) throw new ApiError('Start date must be on or before end date.');
    }

    const filtered = [];
    for (const r of rows) {
      if (type !== 'all' && r.insurance_type !== type) continue;
      if (team !== 'all' && teamOf(r) !== team) continue;
      if (rm !== 'all' && r.rm_name !== rm) continue;
      if (status !== 'all' && r.status !== status) continue;
      if (month !== 'all' && monthKey(r) !== month) continue;
      if (search && !['client_name', 'client_email', 'phone', 'policy_no']
        .some((k) => String(r[k] || '').toLowerCase().includes(search))) continue;
      filtered.push({ ...r, team: teamOf(r), days_until: daysUntil(r), superseded: false });
    }

    const counts = {};
    for (const b of ['overdue', 'today', 'tomorrow', 'next2', 'next7', 'next30']) {
      counts[b] = filtered.filter((r) => inBucket(r.days_until, b)).length;
    }
    const table = bucket === 'custom'
      ? filtered.filter((r) => r.next_premium_date && r.next_premium_date >= start && r.next_premium_date <= end)
      : filtered.filter((r) => inBucket(r.days_until, bucket));
    table.sort((a, b) =>
      ((a.days_until === null) - (b.days_until === null)) || ((a.days_until || 0) - (b.days_until || 0))
      || a.client_name.toLowerCase().localeCompare(b.client_name.toLowerCase())
      || (a.policy_no < b.policy_no ? -1 : a.policy_no > b.policy_no ? 1 : 0));

    return {
      counts, no_date: filtered.filter((r) => r.days_until === null).length,
      total: rows.length, matching_total: filtered.length, bucket, bucket_label: BUCKET_LABELS[bucket],
      rows: table, as_of: today,
      type_options: unique(rows.map((r) => r.insurance_type).filter(Boolean)), insurance_type: type,
      team_options: unique(rows.map(teamOf)), team,
      rm_options: unique(rows.map((r) => r.rm_name).filter(Boolean)), rm,
      status, search, start, end,
      month_options: unique(rows.map(monthKey).filter(Boolean)), month,
      premium_total: table.reduce((sum, r) => sum + (r.premium_amount || 0), 0),
    };
  }

  function overview() {
    const active = rows.map((r) => ({
      team: teamOf(r), days: daysUntil(r), business_type: r.business_type || 'Unspecified',
      policy_partner: r.policy_partner || 'Unspecified', premium: r.premium_amount || 0,
    }));
    const overdue = active.filter((r) => r.days !== null && r.days < 0);
    const upcoming = active.filter((r) => r.days !== null && r.days >= 0 && r.days <= 30);
    const tally = (list, key) => list.reduce((m, r) => m.set(r[key], (m.get(r[key]) || 0) + 1), new Map());
    const overdueBy = tally(overdue, 'team'), upcomingBy = tally(upcoming, 'team');
    const teams = new Set(active.map((r) => r.team));
    const team_breakdown = [...teams].map((t) => ({ team: t, overdue: overdueBy.get(t) || 0, upcoming: upcomingBy.get(t) || 0 }))
      .sort((a, b) => (b.overdue - a.overdue) || (b.upcoming - a.upcoming) || a.team.localeCompare(b.team));
    const ranked = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
    const premiumBy = active.reduce((m, r) => m.set(r.policy_partner, (m.get(r.policy_partner) || 0) + r.premium), new Map());
    return {
      as_of: today, total_active: active.length, total_overdue: overdue.length, total_upcoming: upcoming.length,
      team_breakdown,
      business_type: ranked(tally(active, 'business_type')).map(([label, count]) => ({ label, count })),
      insurer: ranked(tally(active, 'policy_partner')).map(([label, count]) => ({ label, count, premium: premiumBy.get(label) })),
    };
  }

  function update(policyNo, body) {
    const row = rows.find((r) => r.policy_no === policyNo);
    const fields = body && typeof body.fields === 'object' && body.fields ? body.fields
      : body && body.field ? { [body.field]: body.value } : null;
    if (!fields || !Object.keys(fields).length) throw new ApiError('No changes supplied.');
    const clean = {};
    for (const [field, raw] of Object.entries(fields)) {
      if (field === 'status') {
        if (!STATUS_VALUES.includes(raw)) throw new ApiError("Status must be 'Not Done' or 'Done'");
        clean.status = raw;
      } else if (field === 'remarks') clean.remarks = raw == null ? '' : String(raw).slice(0, 2000);
      else if (field === 'phone') clean.phone = raw == null ? '' : String(raw).trim().slice(0, 40);
      else if (field === 'next_premium_date') {
        if (!isIsoDate(raw)) throw new ApiError('Invalid date');
        clean.next_premium_date = raw;
      } else throw new ApiError("Cannot update field '" + field + "'");
    }
    if (!row) throw new ApiError('Policy not found.');
    Object.assign(row, clean);
    if ('next_premium_date' in clean) row.rescheduled = true;
    return body && body.fields ? { policy_no: policyNo, fields: clean }
      : { policy_no: policyNo, field: body.field, value: clean[body.field] };
  }

  /* ---- exports.py (delivered as CSV, which Excel opens directly) ---- */
  const EXPORT_COLUMNS = [
    ['client_name', 'Client name'], ['client_email', 'Email'], ['phone', 'Phone'], ['rm_name', 'Relationship manager'],
    ['team', 'Team'], ['policy_no', 'Policy number'], ['policy', 'Policy'], ['policy_partner', 'Insurer'],
    ['insurance_type', 'Insurance type'], ['sum_assured', 'Sum insured (INR)'], ['premium_amount', 'Premium (INR)'],
    ['next_premium_date', 'Renewal date'], ['days_until', 'Days to renewal'], ['status', 'Follow-up status'],
    ['remarks', 'Remarks'], ['rescheduled', 'Rescheduled'],
  ];
  const csvCell = (value) => {
    let text = value === null || value === undefined ? '' : String(value);
    if (typeof value === 'string' && /^[=+\-@]/.test(text)) text = "'" + text; // never let text act as a formula
    return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  function exportCsv(data) {
    const lines = [EXPORT_COLUMNS.map(([, label]) => csvCell(label)).join(',')];
    for (const row of data.rows) {
      lines.push(EXPORT_COLUMNS.map(([key]) => csvCell(key === 'rescheduled' ? (row[key] ? 'Yes' : 'No') : row[key])).join(','));
    }
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  /* ---- fetch stand-in ---- */
  const json = (body, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    const route = url.pathname.match(/\/api\/(overview|renewals(?:\/export)?|renewals\/.+)$/);
    if (!route) return nativeFetch(input, init);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    try {
      if (route[1] === 'overview') return json(overview());
      if (route[1] === 'renewals') return json(build(url.searchParams));
      if (route[1] === 'renewals/export') {
        const data = build(url.searchParams);
        return new Response(exportCsv(data), {
          status: 200,
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': 'attachment; filename="renewals-' + data.bucket + '-' + data.as_of + '.csv"',
          },
        });
      }
      if (method === 'PATCH') {
        return json(update(decodeURIComponent(route[1].slice('renewals/'.length)), JSON.parse(init.body || '{}')));
      }
      return json({ error: 'Not available in the demo.' }, 405);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, 400);
      throw error;
    }
  };

  /* Importing needs the real server; say so instead of posting to a page that can't read files. */
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form.matches || !form.matches('form[enctype="multipart/form-data"]')) return;
    event.preventDefault();
    form.querySelector('.demo-import-note')?.remove();
    const note = document.createElement('div');
    note.className = 'notice warn demo-import-note';
    note.setAttribute('role', 'status');
    note.textContent = 'Importing is switched off in this demo. It uses sample data only.';
    form.prepend(note);
  });
})();
