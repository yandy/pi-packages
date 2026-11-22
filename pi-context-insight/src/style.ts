export const REPORT_CSS = `
:root { color-scheme: dark; --bg:#0b1020; --panel:#131b2e; --panel2:#182238; --text:#e8edf7; --muted:#9aa8bf; --line:#2a3852; --accent:#79a9ff; --good:#58d39b; --bad:#ff7d92; --warn:#f5bd63; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
a { color:var(--accent); }
header,main,footer { width:min(1440px,calc(100% - 32px)); margin-inline:auto; }
header { padding:36px 0 20px; }
h1 { margin:0 0 8px; font-size:clamp(26px,4vw,42px); letter-spacing:-.03em; }
h2 { margin:0 0 16px; font-size:20px; }
h3 { margin:20px 0 10px; font-size:15px; color:var(--muted); }
p { margin:8px 0; }
code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; overflow-wrap:anywhere; }
section,.subagent-card { margin:16px 0; padding:20px; background:var(--panel); border:1px solid var(--line); border-radius:14px; }
.hero-meta { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:8px 20px; color:var(--muted); }
.hero-meta span { overflow-wrap:anywhere; }
.kpis { display:grid; grid-template-columns:repeat(auto-fit,minmax(145px,1fr)); gap:12px; padding:0; background:none; border:0; }
.kpi { padding:16px; background:linear-gradient(145deg,var(--panel2),var(--panel)); border:1px solid var(--line); border-radius:12px; }
.kpi-label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }
.kpi-value { margin-top:5px; font-size:24px; font-weight:700; font-variant-numeric:tabular-nums; }
.grid-2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; }
.mini-card { padding:14px; background:var(--panel2); border:1px solid var(--line); border-radius:10px; }
.table-wrap,.timeline-scroll { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
th,td { padding:8px 10px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; }
th { color:var(--muted); font-size:12px; font-weight:600; }
td.num,th.num { text-align:right; white-space:nowrap; }
tr:last-child td { border-bottom:0; }
.muted,.note { color:var(--muted); }
.note { font-size:12px; }
.badge { display:inline-block; padding:2px 8px; border:1px solid var(--line); border-radius:999px; color:var(--muted); font-size:12px; }
.badge-ok { color:var(--good); }
.badge-error { color:var(--bad); }
.badge-warn { color:var(--warn); }
.empty { padding:16px; color:var(--muted); text-align:center; border:1px dashed var(--line); border-radius:10px; }
.warnings { border-color:var(--warn); }
.warnings li { margin:5px 0; overflow-wrap:anywhere; }
.composition { display:flex; height:28px; margin:16px 0; overflow:hidden; background:var(--panel2); border-radius:8px; }
.composition-segment { min-width:1px; }
.cat-system { fill:#8b7cf6; background:#8b7cf6; }
.cat-toolDefinitions { fill:#5f8ff0; background:#5f8ff0; }
.cat-user { fill:#4fc3a1; background:#4fc3a1; }
.cat-injected { fill:#d8a24a; background:#d8a24a; }
.cat-compaction { fill:#d876c5; background:#d876c5; }
.cat-reasoning { fill:#b078e0; background:#b078e0; }
.cat-answers { fill:#58b9e8; background:#58b9e8; }
.cat-toolCalls { fill:#e39255; background:#e39255; }
.cat-toolResults { fill:#7fa363; background:#7fa363; }
.series-input { fill:#ef767a; }
.series-cacheWrite { fill:#e6ad58; }
.series-cacheRead { fill:#55c9a5; }
.series-output { fill:#6598ee; }
.legend { display:flex; flex-wrap:wrap; gap:14px; margin:8px 0; color:var(--muted); font-size:12px; }
.legend-swatch { display:inline-block; width:10px; height:10px; margin-right:5px; border-radius:2px; }
.legend-swatch.series-input { background:#ef767a; }
.legend-swatch.series-cacheWrite { background:#e6ad58; }
.legend-swatch.series-cacheRead { background:#55c9a5; }
.legend-swatch.series-output { background:#6598ee; }
.timeline-event { stroke:#f2d46b; stroke-width:1; stroke-dasharray:3 3; }
svg text { fill:var(--muted); font:11px ui-sans-serif,system-ui,sans-serif; }
details > summary { cursor:pointer; font-weight:650; }
details > summary::marker { color:var(--accent); }
.subagent-card { padding:0; overflow:hidden; }
.subagent-card > summary { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:18px 20px; }
.subagent-body { padding:0 14px 14px; }
.activity-details { margin:12px 0; padding:10px 12px; background:var(--panel2); border-radius:8px; }
.activity-details > summary { color:var(--muted); }
footer { padding:16px 0 36px; color:var(--muted); font-size:12px; }
@media (max-width:640px) { header,main,footer { width:min(100% - 18px,1440px); } section { padding:14px; } th,td { padding:7px 6px; } .kpis { grid-template-columns:repeat(2,minmax(0,1fr)); } }
@media print { :root { color-scheme:light; --bg:#fff; --panel:#fff; --panel2:#f4f4f4; --text:#111; --muted:#555; --line:#ccc; } header,main,footer { width:100%; } section,.subagent-card { break-inside:avoid; } details { display:block; } details > summary { list-style:none; } details > * { display:block; } }
`;
