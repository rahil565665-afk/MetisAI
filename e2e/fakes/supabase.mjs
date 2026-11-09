// PostgREST stand-in for ONE clinic's Supabase project, used only by the local end-to-end test.
// usage: node supabase.mjs <port> <secret-key> [--no-tables | --legacy]
// --no-tables: the project has no tables yet. --legacy: tables point at a `companies` table (an older schema).
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const [port, expectedKey, flag] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const hasTables = flag !== '--no-tables';
const legacy = flag === '--legacy';
const tables = { call_logs: [], receptionist_appointments: [], ...(legacy ? { companies: [] } : {}) };

// Like PostgREST: only the selected columns come back, and `alias:column->>key` / `alias:column->key` read inside a JSON column.
const project = (rows, select) => {
  if (!select || select === '*') return rows;
  const items = select.split(',').map((item) => item.trim()).filter(Boolean);
  return rows.map((row) => {
    const out = {};
    for (const item of items) {
      const aliased = /^(\w+):(\w+)(->>?)(\w+)$/.exec(item);
      if (aliased) { const [, alias, column, arrow, key] = aliased; const value = row[column]?.[key]; out[alias] = arrow === '->>' ? (value === undefined || value === null ? null : typeof value === 'string' ? value : JSON.stringify(value)) : (value ?? null); }
      else out[item] = row[item];
    }
    return out;
  });
};
const filterRows = (rows, params) => rows.filter((row) => [...params.entries()].every(([key, value]) => !value.startsWith('eq.') || String(row[key]) === value.slice(3)));

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/__dump') return res.end(JSON.stringify(tables));
  if (req.headers.apikey !== expectedKey) { res.statusCode = 401; return res.end(JSON.stringify({ message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' })); }
  const match = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
  if (!match) { res.statusCode = 404; return res.end('{}'); }
  if (!hasTables || !(match[1] in tables)) { res.statusCode = 404; return res.end(JSON.stringify({ code: 'PGRST205', message: `Could not find the table 'public.${match[1]}' in the schema cache` })); }
  const table = tables[match[1]];
  const wantsObject = (req.headers.accept ?? '').includes('application/vnd.pgrst.object+json');
  const prefer = req.headers.prefer ?? '';
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    const select = url.searchParams.get('select');
    const filters = new URLSearchParams(url.search);
    for (const reserved of ['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']) filters.delete(reserved);
    const send = (status, payload, extra = {}) => {
      res.statusCode = status;
      for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
      if (payload === undefined) return res.end();
      if (wantsObject) {
        const list = Array.isArray(payload) ? payload : [payload];
        if (list.length !== 1) { res.statusCode = 406; return res.end(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })); }
        return res.end(JSON.stringify(list[0]));
      }
      return res.end(JSON.stringify(payload));
    };
    if (req.method === 'HEAD') { const n = filterRows(table, filters).length; return send(200, undefined, { 'content-range': `*/${n}` }); }
    if (req.method === 'GET') {
      let rows = filterRows(table, filters);
      const order = url.searchParams.get('order');
      if (order) { const [col, dir] = order.split('.'); rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === 'desc' ? -1 : 1)); }
      const limit = Number(url.searchParams.get('limit'));
      if (limit) rows = rows.slice(0, limit);
      return send(200, project(rows, select), { 'content-range': `0-0/${filterRows(table, filters).length}` });
    }
    if (req.method === 'POST') {
      const rows = (Array.isArray(body) ? body : [body]).map((row) => ({ id: randomUUID(), status: 'active', started_at: new Date().toISOString(), created_at: new Date().toISOString(), transfer_requested: false, ...row }));
      const onConflict = url.searchParams.get('on_conflict');
      if (legacy && match[1] !== 'companies' && rows.some((row) => !tables.companies.some((company) => company.id === row.tenant_id))) {
        const bad = rows.find((row) => !tables.companies.some((company) => company.id === row.tenant_id));
        return send(409, { code: '23503', message: `insert or update on table "${match[1]}" violates foreign key constraint "${match[1]}_tenant_id_fkey"`, details: `Key (tenant_id)=(${bad.tenant_id}) is not present in table "companies".`, hint: null });
      }
      for (const row of rows) {
        const keys = onConflict ? onConflict.split(',') : null;
        const existing = keys ? table.find((item) => keys.every((k) => item[k] === row[k])) : undefined;
        if (existing) Object.assign(existing, row, { id: existing.id }); else table.push(row);
      }
      return prefer.includes('return=representation') ? send(201, project(rows, select)) : send(201, undefined);
    }
    if (req.method === 'PATCH') {
      const rows = filterRows(table, filters);
      rows.forEach((row) => Object.assign(row, body));
      return prefer.includes('return=representation') ? send(200, project(rows, select)) : send(204, undefined);
    }
    if (req.method === 'DELETE') {
      for (const row of filterRows(table, filters)) table.splice(table.indexOf(row), 1);
      return send(204, undefined);
    }
    return send(405, { message: 'unsupported' });
  });
}).listen(port, '127.0.0.1', () => console.log(`clinic db on ${port}`));
