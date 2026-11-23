export const REPORT_CSS = `
:root{--bg:#0e1116;--surface:#151a21;--surface-2:#1b212a;--line:#242c37;--text:#e7ecf3;--dim:#8b97a8;--accent:#5aa9ff;
--systemBase:#5b8def;--systemTools:#8f7bf0;--systemProject:#3fb6a8;--systemSkills:#e0a13a;--systemDocs:#7c8698;--systemOther:#55606f;
--toolDefinitions:#4f9d69;--user:#2fa4d8;--injected:#b173d6;--skillInjections:#f0803c;--compaction:#e05c5c;
--reasoning:#9b7bf5;--answers:#e56aa8;--toolCalls:#48b884;--toolResults:#2f7f74;--unattributed:#c9a227;
--timing-model:#5b8def;--timing-tools:#3fb6a8;--timing-other:#6b7688;
--ok:#3fb950;--warn:#d0a02a;--err:#e05c5c;
--r-card:12px;--r-block:8px;--sp:16px}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
a{color:var(--accent)}

/* shell: rail + 12 column card grid */
.shell{display:grid;grid-template-columns:220px minmax(0,1fr);gap:24px;max-width:1400px;margin:0 auto;padding:24px;align-items:start}
.rail{position:sticky;top:24px;align-self:start;max-height:calc(100vh - 48px);overflow:auto;display:flex;flex-direction:column;gap:12px;min-width:0}
.rail-title{font-size:14px;font-weight:600;line-height:1.35}
.rail-meta{font-size:11px;color:var(--dim);display:flex;flex-wrap:wrap;gap:4px 8px}
.rail-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin-top:4px}
.rail-nav{display:flex;flex-direction:column;gap:1px}
.rail-nav a{display:block;padding:4px 8px;border-radius:6px;color:var(--dim);text-decoration:none;font-size:12px;border-left:2px solid transparent}
.rail-nav a:hover{background:var(--surface-2);color:var(--text)}
.rail-nav a[aria-current="true"]{background:var(--surface-2);color:var(--text);border-left-color:var(--accent)}
.rail-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto;padding-top:8px;border-top:1px solid var(--line)}
.main{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:var(--sp);min-width:0}
.card{grid-column:span 12;background:var(--surface);border:1px solid var(--line);border-radius:var(--r-card);padding:var(--sp);min-width:0}
.span-3{grid-column:span 3}.span-4{grid-column:span 4}.span-5{grid-column:span 5}
.span-6{grid-column:span 6}.span-7{grid-column:span 7}.span-8{grid-column:span 8}
.card>h2{margin:0 0 12px;font-size:13.5px;font-weight:600;display:flex;align-items:center;gap:8px;min-height:16px}
.card>h2::before{content:"";flex:0 0 auto;width:3px;height:14px;border-radius:2px;background:var(--accent)}
.card>h3{margin:14px 0 8px;font-size:12px;font-weight:600;color:var(--dim)}
.card-meta{margin-left:auto;display:flex;align-items:center;gap:6px;font-weight:400;font-size:11px;color:var(--dim)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;align-items:start}
.split{display:grid;grid-template-columns:5fr 7fr;gap:20px;margin-top:16px;align-items:start}

/* kpi tiles */
.kpis{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}
.kpi{background:var(--surface-2);border:1px solid var(--line);border-radius:var(--r-block);padding:10px 12px;min-width:0}
.kpi-label{color:var(--dim);font-size:10px;text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:6px}
.kpi-value{font-size:22px;font-weight:600;line-height:1.25;margin-top:2px}
.kpi-sub{color:var(--dim);font-size:11px;margin-top:2px;display:flex;flex-wrap:wrap;gap:4px 8px}

/* donut + legend pairs */
.donut-pair{display:flex;gap:20px;align-items:center;min-width:0}
.donut-pair>.donut{flex:0 0 auto}
.legend-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:2px 18px;flex:1 1 auto;min-width:0}
.legend-grid.legend-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.legend.legend-3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 18px}
.legend-row{display:grid;grid-template-columns:9px minmax(0,1fr) auto auto 64px;gap:8px;align-items:center;font-size:11.5px;padding:2px 0}
.legend-row .dot{width:9px;height:9px;border-radius:2px;display:block}
.legend-label{color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.legend-value{color:var(--text);text-align:right;white-space:nowrap}
.legend-share{color:var(--dim);text-align:right;min-width:44px;white-space:nowrap}
.legend{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:11px;color:var(--dim);margin-top:10px}
.legend>.row{display:inline-flex;align-items:center;gap:6px;padding:1px 2px;border-radius:4px}
.legend>.row .dot{width:9px;height:9px;border-radius:2px;display:inline-block}
.occupancy-row{display:flex;align-items:baseline;gap:12px}
.occupancy{font-size:22px;font-weight:600}
.occupancy-share{margin-left:auto;font-size:26px;font-weight:600;color:var(--accent)}
.strip{display:flex;height:10px;border-radius:3px;overflow:hidden;background:var(--surface-2);border:1px solid var(--line)}
.strip>i{display:block;height:100%;background:var(--timing-model)}
.strip>i:hover{filter:brightness(1.2)}
.timing-facts{display:flex;gap:20px;margin-top:8px;padding-top:8px;border-top:1px solid var(--line)}
.timing-facts .kpi-value{font-size:16px}
.swatch{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}

/* bars and chips */
.bar{display:block;height:6px;border-radius:3px;background:var(--surface-2);border:1px solid var(--line);overflow:hidden}
.bar>b{display:block;height:100%}
.chip{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border-radius:999px;border:1px solid var(--line);background:var(--surface-2);font-size:10.5px;color:var(--dim);white-space:nowrap;line-height:1.7}
.chip.tone-ok{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 45%,var(--line))}
.chip.tone-warn{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 45%,var(--line))}
.chip.tone-err{color:var(--err);border-color:color-mix(in srgb,var(--err) 45%,var(--line))}
.tag{display:inline-block;background:var(--surface-2);border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:10.5px;color:var(--dim);margin-right:4px;white-space:nowrap}
.flag{color:var(--warn);font-size:11px}
.badge{display:inline-block;padding:0 6px;border-radius:999px;font-size:10.5px;border:1px solid var(--line);color:var(--dim)}
.badge.full{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 50%,var(--line))}

/* stacks */
.stack{display:flex;border-radius:4px;overflow:hidden;background:var(--surface-2);min-height:8px}
.stack>i{display:block;height:100%}
.stack>i:hover{filter:brightness(1.15)}
.hatch{background-image:repeating-linear-gradient(45deg,rgba(224,92,92,.45) 0 3px,transparent 3px 7px)}
.hatch-out{background-image:repeating-linear-gradient(45deg,rgba(90,169,255,.4) 0 3px,transparent 3px 7px)}

/* tables and key/value rows */
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);font-size:12px;vertical-align:top}
th{color:var(--dim);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
tbody tr:last-child td,tbody tr:last-child th{border-bottom:none}
td.num,th.num{text-align:right}
.kv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:2px 12px;margin:0;font-size:12px}
.kv dt{color:var(--dim)}
.kv dd{margin:0;min-width:0}

/* rows, details, bodies */
.row{cursor:pointer}
.row:hover{background:var(--surface-2)}
details>summary{cursor:pointer;list-style:none}
details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"▸";color:var(--dim);margin-right:6px;display:inline-block;transition:transform .12s ease}
details[open]>summary::before{transform:rotate(90deg)}
pre.body{white-space:pre-wrap;word-break:break-word;background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:8px;max-height:420px;overflow:auto;margin:6px 0}
.clamp-2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dim{color:var(--dim)}
.hidden{display:none!important}
.notes{font-size:12px;color:var(--dim);padding-left:18px}
.notes li{margin:3px 0}

/* panels */
.banner{background:#3a2a12;border:1px solid var(--warn);color:#f0d9a8;border-radius:var(--r-block);padding:8px 12px}
.warn-panel{background:#2a1f16;border:1px solid #6b4a1f;border-radius:var(--r-block);padding:8px 12px;font-size:12px}
.warn-panel ul{margin:0;padding-left:18px}
.browser{display:grid;grid-template-columns:220px minmax(0,1fr);gap:16px;align-items:start}
.browser-index{display:flex;flex-direction:column;gap:2px;min-width:0}
.idx-row{display:grid;grid-template-columns:9px minmax(0,1fr) auto auto auto;gap:8px;align-items:center;background:none;border:1px solid transparent;border-radius:6px;padding:3px 6px;text-align:left;font-size:11.5px;cursor:pointer;width:100%}
.idx-row:hover{background:var(--surface-2)}
.idx-row[aria-pressed="true"]{border-color:var(--accent);background:var(--surface-2)}
.idx-row .dot{width:9px;height:9px;border-radius:2px;display:block}
.idx-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.idx-value,.idx-share,.idx-count{text-align:right;white-space:nowrap}
.browser-main{min-width:0;display:flex;flex-direction:column;gap:8px}
.browser-scroll{max-height:520px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-block);padding:0 10px}
.item-row{padding:4px 0;border-bottom:1px solid var(--line);font-size:12px}
.item-row:last-child{border-bottom:none}
.item-row.is-error{border-left:2px solid var(--err);padding-left:6px}
.item-preview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
.browser-scroll h4{position:sticky;top:0;background:var(--surface);margin:0;padding:8px 0 6px;font-size:12px;z-index:1;border-bottom:1px solid var(--line)}
.timeline-scroll{overflow-x:auto;overflow-y:hidden}
.timeline-scroll>svg{display:block;margin:0 auto;max-width:none}
.toolbar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.detail-scroll{max-height:300px;overflow:auto}
.event-list{max-height:360px;overflow:auto}
.event-row{display:grid;grid-template-columns:64px 10px minmax(0,1fr) auto auto;gap:10px;align-items:center;padding:5px 2px;border-bottom:1px solid var(--line);font-size:12px}
.event-clock{font-variant-numeric:tabular-nums}
.event-row .dot{width:9px;height:9px;border-radius:50%}
.event-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.delta{text-align:right;min-width:56px;font-variant-numeric:tabular-nums}
.delta-up{color:var(--ok)}
.delta-down{color:var(--err)}
.delta-zero{color:var(--dim)}
.tool-list{display:flex;flex-direction:column;gap:2px}
.tool-row{display:grid;grid-template-columns:120px auto minmax(60px,180px) auto auto auto auto auto;gap:10px;align-items:center;font-size:12px;padding:3px 0;border-bottom:1px solid var(--line)}
.tool-row:last-child{border-bottom:none}
.tool-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tool-spark{white-space:nowrap;line-height:1}
.file-row,.cmd-row{padding:3px 0;border-bottom:1px solid var(--line);font-size:12px}
.file-row:last-child,.cmd-row:last-child{border-bottom:none}
.cmd-row.is-error{border-left:2px solid var(--err);padding-left:6px}
.file-op,.cmd-row p{margin:2px 0 2px 16px}
.split-commands{grid-template-columns:minmax(0,0.8fr) minmax(0,1.2fr);margin-top:0}
.rail-stats{font-size:12px}
.rail-stats ul{margin:2px 0 0;padding-left:16px}
.event-row:last-child{border-bottom:none}
.tool-row .bar{margin:0}

button,select,input[type="search"]{background:var(--surface-2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:11.5px;font-family:inherit;cursor:pointer}
button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
input[type="search"]{cursor:text;min-width:180px}
footer{color:var(--dim);font-size:11px;text-align:center;padding:8px 0 24px}

@media (max-width:1100px){
.kpis{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media (max-width:900px){
.shell{grid-template-columns:minmax(0,1fr);padding:12px}
.rail{position:static;max-height:none}
.main{display:block}
.card{margin-bottom:var(--sp)}
.card,.span-3,.span-4,.span-5,.span-6,.span-7,.span-8{grid-column:auto}
.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}
.donut-pair{flex-direction:column;align-items:flex-start}
.split{grid-template-columns:minmax(0,1fr)}
}
@media print{
.rail,button,select,input[type="search"]{display:none!important}
.shell{display:block;max-width:none;padding:0}
.main{display:block}
.card{break-inside:avoid;border-color:#ccc;margin-bottom:10px;background:#fff;color:#111}
:root{--text:#111;--dim:#555;--line:#ddd;--surface:#fff;--surface-2:#f4f4f4;--bg:#fff}
pre.body{background:#f4f4f4;color:#111}
}
@media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
`.trim();
