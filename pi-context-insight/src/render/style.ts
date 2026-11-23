export const REPORT_CSS = `
:root{--bg:#0f1420;--card:#171d2b;--card2:#1e2637;--line:#2a3448;--text:#e6ecf5;--dim:#93a1b8;--accent:#5aa9ff;
--systemBase:#5b8def;--systemTools:#8f7bf0;--systemProject:#3fb6a8;--systemSkills:#e0a13a;--systemDocs:#7c8698;--systemOther:#55606f;
--toolDefinitions:#4f9d69;--user:#2fa4d8;--injected:#b173d6;--skillInjections:#f0803c;--compaction:#e05c5c;
--reasoning:#9b7bf5;--answers:#e56aa8;--toolCalls:#48b884;--toolResults:#2f7f74;--unattributed:#c9a227;
--ok:#3fb950;--warn:#d0a02a;--err:#e05c5c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:13px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
header.top{position:sticky;top:0;z-index:5;background:rgba(15,20,32,.96);border-bottom:1px solid var(--line);padding:10px 20px}
.top h1{margin:0;font-size:15px;display:inline-block}
.badge{display:inline-block;margin-left:8px;padding:1px 6px;border-radius:10px;font-size:11px;border:1px solid var(--line);color:var(--dim)}
.badge.full{color:var(--warn);border-color:var(--warn)}
nav.anchors{margin-top:6px;display:flex;flex-wrap:wrap;gap:8px;font-size:12px}
nav.anchors a{color:var(--dim);text-decoration:none}
nav.anchors a:hover{color:var(--accent)}
.actions{margin-left:auto;display:flex;gap:6px}
button{background:var(--card2);color:var(--text);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer}
button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
main{padding:16px 20px 40px;max-width:1440px;margin:0 auto}
section.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 16px}
section.card>h2{margin:0 0 10px;font-size:14px}
.banner{background:#3a2a12;border:1px solid var(--warn);color:#f0d9a8;border-radius:8px;padding:8px 12px;margin:0 0 12px}
.warn-panel{background:#2a1f16;border:1px solid #6b4a1f;border-radius:8px;padding:8px 12px;margin:0 0 12px;font-size:12px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.kpi{background:var(--card2);border:1px solid var(--line);border-radius:8px;padding:10px}
.kpi-label{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.kpi-value{font-size:20px;font-weight:600;margin-top:2px}
.kpi-sub{color:var(--dim);font-size:11px;margin-top:2px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);font-size:12px;vertical-align:top}
th{color:var(--dim);font-weight:500}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.dim{color:var(--dim)}
.swatch{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px}
.stack{display:flex;height:16px;border-radius:4px;overflow:hidden;background:var(--card2)}
.stack>i{display:block;height:100%}
.hatch{background-image:repeating-linear-gradient(45deg,rgba(224,92,92,.45) 0 3px,transparent 3px 7px)}
.hatch-out{background-image:repeating-linear-gradient(45deg,rgba(90,169,255,.4) 0 3px,transparent 3px 7px)}
.legend{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--dim);margin-top:8px}
.row{cursor:pointer}
.row:hover{background:var(--card2)}
.hidden{display:none!important}
details>summary{cursor:pointer}
pre.body{white-space:pre-wrap;word-break:break-word;background:var(--card2);border:1px solid var(--line);border-radius:6px;padding:8px;max-height:420px;overflow:auto;margin:6px 0}
.tag{display:inline-block;background:var(--card2);border:1px solid var(--line);border-radius:4px;padding:0 5px;font-size:11px;color:var(--dim);margin-right:4px}
.flag{color:var(--warn);font-size:11px}
.notes{font-size:12px;color:var(--dim)}
footer{color:var(--dim);font-size:11px;text-align:center;padding:0 0 24px}
.timeline-scroll{overflow-x:auto}
`.trim();
