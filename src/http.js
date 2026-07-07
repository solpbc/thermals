// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function parseLimit(v, def = 50, max = 100) {
  const n = Number.parseInt(v ?? String(def), 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

export function parseCursor(v) {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
