export const CLIENT_RUNTIME = `
(function () {
  "use strict";

  var GROUP_OF = {
    systemBase: "systemBase", systemTools: "systemBase", systemProject: "systemBase",
    systemSkills: "systemBase", systemDocs: "systemBase", systemOther: "systemBase",
    toolDefinitions: "toolDefinitions", user: "user", injected: "injected",
    skillInjections: "skillInjections", compaction: "compaction", reasoning: "answers",
    answers: "answers", toolCalls: "toolCalls", toolResults: "toolResults", unattributed: "unattributed"
  };
  var GROUPS = ["systemBase", "toolDefinitions", "user", "injected", "skillInjections", "compaction", "answers", "toolCalls", "toolResults", "unattributed"];
  var CAT_ORDER = ["systemBase", "systemTools", "systemProject", "systemSkills", "systemDocs", "systemOther", "toolDefinitions", "user", "injected", "skillInjections", "compaction", "reasoning", "answers", "toolCalls", "toolResults"];
  var ROW_LIMIT = 200;

  function visibleRows(rows, query) {
    var needle = String(query || "").toLowerCase();
    return rows
      .filter(function (row) { return needle === "" || String(row.text).toLowerCase().indexOf(needle) >= 0; })
      .map(function (row) { return row.key; });
  }

  function nextIndex(current, delta, max) {
    if (max <= 0) return 0;
    var next = current + delta;
    if (next < 0) return 0;
    if (next > max - 1) return max - 1;
    return next;
  }

  function resolveLang(stored, initial) {
    if (stored === "en" || stored === "zh") return stored;
    return initial === "zh" ? "zh" : "en";
  }

  function inRanges(ranges, id) {
    for (var i = 0; i < (ranges || []).length; i++) {
      if (id >= ranges[i][0] && id <= ranges[i][1]) return true;
    }
    return false;
  }

  function fmtTokens(value) {
    var n = Number(value);
    if (!isFinite(n)) return "—";
    var sign = n < 0 ? "-" : "";
    var abs = Math.abs(n);
    if (abs >= 1000000) return sign + (abs / 1000000).toFixed(1) + "M";
    if (abs >= 1000) return sign + (abs / 1000).toFixed(1) + "k";
    return sign + Math.round(abs);
  }

  function fmtClock(iso) {
    if (!iso) return "—";
    var date = new Date(iso);
    if (!isFinite(date.getTime())) return "—";
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
  }

  function fmtDuration(ms) {
    var value = Number(ms);
    if (!isFinite(value) || value <= 0) return "—";
    if (value < 1000) return Math.round(value) + "ms";
    var seconds = value / 1000;
    if (seconds < 60) return (seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)) + "s";
    var minutes = Math.floor(seconds / 60);
    var rest = Math.round(seconds - minutes * 60);
    return minutes + "m" + (rest < 10 ? "0" : "") + rest + "s";
  }

  function groupLabelFor(dicts, lang, group) {
    var dict = (dicts && dicts[lang]) || {};
    return translate(dict, group === "systemBase" ? "browser.system" : "cat." + group);
  }

  function catLabelFor(dicts, lang, cat) {
    var dict = (dicts && dicts[lang]) || {};
    return translate(dict, GROUP_OF[cat] === "systemBase" ? "browser.system" : "cat." + cat);
  }

  function translate(dict, key, params) {
    var template = dict && dict[key] !== undefined ? dict[key] : key;
    if (!params) return template;
    return String(template).replace(/\\{(\\w+)\\}/g, function (match, name) {
      return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
    });
  }

  /** Groups steps into turns; a turn's delta is the sum of its steps' deltas. */
  function turnBuckets(steps) {
    var buckets = [];
    var index = -1;
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      if (index < 0 || buckets[index].turn !== step.turn) {
        buckets.push({ turn: step.turn, sums: {}, delta: {}, total: 0, activeMs: 0, count: 0, index: step.i });
        index++;
      }
      var bucket = buckets[index];
      for (var key in step.sums) {
        if (Object.prototype.hasOwnProperty.call(step.sums, key)) bucket.sums[key] = step.sums[key];
      }
      for (var deltaKey in step.delta) {
        if (Object.prototype.hasOwnProperty.call(step.delta, deltaKey)) {
          bucket.delta[deltaKey] = (bucket.delta[deltaKey] || 0) + step.delta[deltaKey];
        }
      }
      bucket.total = step.total;
      bucket.activeMs += step.activeMs || 0;
      bucket.count += 1;
    }
    return buckets;
  }

  function bucketsFor(steps, granularity) {
    return granularity === "turn" ? turnBuckets(steps) : steps;
  }

  function maxOf(buckets, mode) {
    var max = 1;
    for (var i = 0; i < buckets.length; i++) {
      var bucket = buckets[i];
      if (mode === "delta") {
        var up = 0, down = 0;
        for (var key in bucket.delta) {
          if (!Object.prototype.hasOwnProperty.call(bucket.delta, key)) continue;
          if (bucket.delta[key] > 0) up += bucket.delta[key]; else down -= bucket.delta[key];
        }
        if (up > max) max = up;
        if (down > max) max = down;
      } else if (bucket.total > max) {
        max = bucket.total;
      }
    }
    return max;
  }

  /**
   * Pure geometry for the timeline: no DOM, so the layout can be asserted in tests.
   * Bars stack upward from the axis; in delta mode reclaimed context stacks downward.
   */
  function buildTimeline(steps, geo, opts) {
    var mode = opts.mode === "delta" ? "delta" : "total";
    var buckets = bucketsFor(steps, opts.granularity);
    var max = opts.max && opts.max > 0 ? opts.max : maxOf(buckets, mode);
    var scale = geo.chartH / max;
    var width = Math.max(320, 20 + buckets.length * (geo.barW + geo.gap));
    var data = { width: width, axisY: geo.axisY, bars: [], flags: [], turns: [], labels: [], line: null, negative: false };
    var index = 0;
    for (var i = 0; i < buckets.length; i++) {
      var bucket = buckets[i];
      var x = 10 + i * (geo.barW + geo.gap);
      var bar = { step: bucket.i !== undefined ? bucket.i : index, x: x, segments: [] };
      if (mode === "delta") {
        var up = 0, down = 0;
        for (var c = 0; c < CAT_ORDER.length; c++) {
          var id = CAT_ORDER[c];
          var delta = bucket.delta[id] || 0;
          if (delta === 0) continue;
          var height = Math.abs(delta) * scale;
          if (height <= 0) continue;
          if (delta > 0) {
            bar.segments.push({ id: id, y: geo.axisY - up - height, h: height, negative: false });
            up += height;
          } else {
            bar.segments.push({ id: id, y: geo.axisY + down, h: height, negative: true });
            down += height;
            data.negative = true;
          }
        }
      } else {
        var cursor = geo.axisY;
        for (var t = 0; t < CAT_ORDER.length; t++) {
          var cat = CAT_ORDER[t];
          var tokens = bucket.sums[cat] || 0;
          var extent = tokens * scale;
          if (extent <= 0) continue;
          cursor -= extent;
          bar.segments.push({ id: cat, y: cursor, h: extent, negative: false });
        }
      }
      data.bars.push(bar);
      index++;
    }
    if (opts.duration) {
      var maxActive = 1;
      for (var d = 0; d < buckets.length; d++) if ((buckets[d].activeMs || 0) > maxActive) maxActive = buckets[d].activeMs;
      data.line = [];
      for (var p = 0; p < buckets.length; p++) {
        var pointX = 10 + p * (geo.barW + geo.gap) + geo.barW / 2;
        data.line.push([pointX, geo.axisY - ((buckets[p].activeMs || 0) / maxActive) * geo.chartH]);
      }
    }
    return data;
  }

  function maxTokensOf(value) {
    var n = Number(value);
    return isFinite(n) ? n : 0;
  }

  function el(doc, name, attrs) {
    var node = doc.createElement(name);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key) && attrs[key] !== null && attrs[key] !== undefined) {
        node.setAttribute(key, String(attrs[key]));
      }
    }
    return node;
  }

  function svgEl(doc, name, attrs) {
    var node = doc.createElementNS("http://www.w3.org/2000/svg", name);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key) && attrs[key] !== null && attrs[key] !== undefined) {
        node.setAttribute(key, String(attrs[key]));
      }
    }
    return node;
  }

  function readPayload(doc) {
    var node = doc.getElementById("insight-payload");
    if (!node) return null;
    try { return JSON.parse(node.textContent || "{}"); } catch (error) { return null; }
  }

  function setHidden(node, hidden) {
    if (!node) return;
    if (hidden) node.setAttribute("hidden", "hidden");
    else node.removeAttribute("hidden");
  }

  /** Resolves every data-i18n node, with params, in place. */
  function applyLanguageFromDoc(doc, lang, dicts) {
    var payload = dicts;
    var dict = (payload && payload[lang]) || {};
    var nodes = doc.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = node.getAttribute("data-i18n");
      var raw = node.getAttribute("data-i18n-params");
      var params = null;
      if (raw) {
        try { params = JSON.parse(decodeEntities(raw)); } catch (error) { params = null; }
      }
      if (dict[key] !== undefined) node.textContent = translate(dict, key, params);
    }
    doc.documentElement.setAttribute("lang", lang);
    var buttons = doc.querySelectorAll("[data-lang-switch]");
    for (var j = 0; j < buttons.length; j++) {
      buttons[j].setAttribute("aria-pressed", buttons[j].getAttribute("data-lang-switch") === lang ? "true" : "false");
    }
  }

  function decodeEntities(value) {
    return String(value)
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function highlightRailFromDoc(doc, activeId) {
    var items = doc.querySelectorAll("[data-rail-item]");
    for (var i = 0; i < items.length; i++) {
      if (items[i].getAttribute("data-rail-item") === activeId) items[i].setAttribute("aria-current", "true");
      else items[i].removeAttribute("aria-current");
    }
  }

  function boot(doc, win) {
    var payload = readPayload(doc);
    if (!payload) return;
    var storage = null;
    try { storage = win.localStorage; } catch (error) { storage = null; }

    function store(key, value) { try { if (storage) storage.setItem(key, value); } catch (error) {} }
    function load(key) { try { return storage ? storage.getItem(key) : null; } catch (error) { return null; } }

    var state = {
      step: payload.steps.length > 0 ? payload.steps[payload.steps.length - 1].i : 0,
      mode: load("insight.mode") || "total",
      granularity: "step",
      dna: false,
      overview: false,
      duration: false,
      lang: resolveLang(load("insight.lang"), payload.lang),
      group: null
    };

    function dict() { return (payload.dicts && payload.dicts[state.lang]) || {}; }
    function say(key, params) { return translate(dict(), key, params); }

    function stepOf(index) {
      for (var i = 0; i < payload.steps.length; i++) if (payload.steps[i].i === index) return payload.steps[i];
      return null;
    }

    function itemsFor(step) {
      var list = [];
      if (!step || !step.details) return list;
      for (var i = 0; i < payload.items.length; i++) {
        if (inRanges(step.ranges, payload.items[i].id)) list.push(payload.items[i]);
      }
      return list;
    }

    function groupSums(step) {
      var sums = {};
      for (var i = 0; i < payload.items.length; i++) {
        var item = payload.items[i];
        if (!inRanges(step.ranges, item.id)) continue;
        var group = GROUP_OF[item.cat] || item.cat;
        sums[group] = (sums[group] || 0) + item.tok;
      }
      return sums;
    }

    function groupDeltas(step) {
      var deltas = {};
      if (!step || !step.delta) return deltas;
      for (var key in step.delta) {
        if (!Object.prototype.hasOwnProperty.call(step.delta, key)) continue;
        var group = GROUP_OF[key] || key;
        deltas[group] = (deltas[group] || 0) + step.delta[key];
      }
      return deltas;
    }

    function redrawTimeline() {
      var svg = doc.querySelector("[data-timeline-svg]");
      if (!svg) return;
      var geo = payload.geo;
      var data = buildTimeline(payload.steps, geo, {
        mode: state.mode,
        granularity: state.granularity,
        duration: state.duration
      });
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      svg.setAttribute("viewBox", "0 0 " + data.width + " " + geo.height);
      svg.setAttribute("width", String(data.width));
      svg.setAttribute("height", String(geo.height));

      var ticks = [1, 0.5, 0];
      var max = 1;
      for (var b = 0; b < payload.steps.length; b++) if (payload.steps[b].total > max) max = payload.steps[b].total;
      for (var t = 0; t < ticks.length; t++) {
        var y = geo.axisY - geo.chartH * ticks[t];
        svg.appendChild(svgEl(doc, "line", { x1: 0, x2: data.width, y1: y, y2: y, stroke: "var(--line)", "stroke-dasharray": "2 4" }));
        svg.appendChild(svgEl(doc, "text", { x: 2, y: y - 4, "font-size": 10, fill: "var(--dim)" })).textContent = fmtTokens(max * ticks[t]);
      }
      if (data.negative) {
        svg.appendChild(svgEl(doc, "line", { x1: 0, x2: data.width, y1: geo.axisY, y2: geo.axisY, stroke: "var(--warn)", "stroke-dasharray": "3 3" }));
      } else {
        svg.appendChild(svgEl(doc, "line", { x1: 0, x2: data.width, y1: geo.axisY, y2: geo.axisY, stroke: "var(--line)" }));
      }

      for (var i = 0; i < data.bars.length; i++) {
        var bar = data.bars[i];
        var group = svgEl(doc, "g", { "data-step": bar.step });
        for (var s = 0; s < bar.segments.length; s++) {
          var segment = bar.segments[s];
          var rect = svgEl(doc, "rect", {
            x: bar.x,
            y: segment.y.toFixed(2),
            width: geo.barW,
            height: Math.max(1, segment.h).toFixed(2),
            fill: "var(--" + segment.id + ")"
          });
          if (segment.negative) rect.setAttribute("data-negative", "1");
          group.appendChild(rect);
        }
        svg.appendChild(group);
      }

      if (data.line && data.line.length > 1) {
        var points = [];
        for (var p = 0; p < data.line.length; p++) points.push(data.line[p][0].toFixed(1) + "," + data.line[p][1].toFixed(1));
        svg.appendChild(svgEl(doc, "polyline", { points: points.join(" "), fill: "none", stroke: "var(--warn)", "stroke-width": 1.5 }));
      }
    }

    function applyToggles() {
      var buttons = doc.querySelectorAll("[data-toggle]");
      for (var i = 0; i < buttons.length; i++) {
        var button = buttons[i];
        var name = button.getAttribute("data-toggle");
        var value = button.getAttribute("data-value");
        var pressed = (name === "mode" && value === state.mode) || (name === "granularity" && value === state.granularity) || (name !== "mode" && name !== "granularity" && !!state[value]);
        button.setAttribute("aria-pressed", pressed ? "true" : "false");
      }
      var dna = doc.querySelector("[data-dna-list]");
      if (dna) setHidden(dna, !state.dna);
      var panels = doc.querySelector("[data-browser-panels]");
      if (panels) setHidden(panels, state.dna);
      var chart = doc.querySelector("[data-timeline-scroll]");
      if (chart) setHidden(chart, state.overview);
      var overview = doc.querySelector("[data-timeline-overview]");
      if (overview) setHidden(overview, !state.overview);
      redrawTimeline();
    }

    function renderCategoryRows(step) {
      var rows = doc.querySelectorAll("[data-cat-index]");
      var sums = step && step.details ? groupSums(step) : (step ? step.sums : {});
      var deltas = groupDeltas(step);
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var group = row.getAttribute("data-cat-index");
        var cells = row.querySelectorAll("span");
        var unknownSystem = group === "systemBase" || group === "toolDefinitions" ? step && !step.systemKnown : false;
        var tokens = sums[group] || 0;
        var delta = deltas[group] || 0;
        var count = step && step.details ? countItems(step, group) : 0;
        var share = !unknownSystem && step && step.total ? (tokens / step.total) * 100 : 0;
        if (cells.length >= 5) {
          cells[2].textContent = unknownSystem ? "—" : state.mode === "delta" ? String(count) : String(count);
          cells[3].textContent = unknownSystem ? "—" : state.mode === "delta" ? (delta === 0 ? "—" : (delta > 0 ? "+" : "") + fmtTokens(delta)) : "≈" + fmtTokens(tokens);
          cells[4].textContent = unknownSystem || !share ? "—" : share.toFixed(1) + "%";
        }
        row.setAttribute("data-count", String(count));
        row.setAttribute("data-tokens", String(Math.round(tokens)));
        row.setAttribute("data-share", share.toFixed(1));
        row.setAttribute("aria-pressed", state.group === group ? "true" : "false");
      }
    }

    function countItems(step, group) {
      var count = 0;
      var list = itemsFor(step);
      for (var i = 0; i < list.length; i++) if ((GROUP_OF[list[i].cat] || list[i].cat) === group) count += 1;
      return count;
    }

    function catLabel(cat) {
      return catLabelFor(payload.dicts, state.lang, cat);
    }

    function groupLabel(group) {
      return groupLabelFor(payload.dicts, state.lang, group);
    }

    function toolOf(name) {
      var list = payload.tools || [];
      for (var i = 0; i < list.length; i++) if (list[i].name === name) return list[i];
      return null;
    }

    function itemRow(item) {
      var row = el(doc, "details", { class: "item-row" + (item.error ? " is-error" : "") });
      row.setAttribute("data-item", String(item.id));
      row.setAttribute("data-cat", item.cat);
      row.setAttribute("data-search", (catLabel(item.cat) + " " + item.tag).toLowerCase());
      if (item.error) row.setAttribute("data-error", "1");
      if (item.call) row.setAttribute("data-call", item.call);
      var summary = el(doc, "summary", {});
      var label = el(doc, "span", { class: "tag" });
      label.textContent = catLabel(item.cat);
      summary.appendChild(label);
      if (item.skill) {
        var skill = el(doc, "span", { class: "tag" });
        skill.textContent = say("browser.skillTag", { name: item.skill });
        summary.appendChild(skill);
      }
      if (item.error) {
        var flag = el(doc, "span", { class: "flag" });
        flag.textContent = "✕";
        summary.appendChild(flag);
      }
      var source = item.kind === "toolDefinition" ? toolOf(item.tag) : null;
      if (source) {
        var chip = el(doc, "span", { class: "tag" });
        chip.setAttribute("data-tool-source", source.source);
        chip.textContent = source.sourceLabel || source.source;
        summary.appendChild(chip);
      }
      var preview = el(doc, "span", { class: "item-preview dim" });
      preview.textContent = item.tag;
      summary.appendChild(preview);
      var meta = el(doc, "span", { class: "item-meta dim" });
      meta.textContent = "≈" + fmtTokens(item.tok) + " · " + fmtClock(item.at);
      summary.appendChild(meta);
      if (item.truncated) {
        var clipped = el(doc, "span", { class: "flag" });
        clipped.textContent = say("browser.truncated", { chars: item.len || 0 });
        summary.appendChild(clipped);
      }
      row.appendChild(summary);
      if (item.body !== null && payload.bodies[item.body] !== undefined) {
        var pre = el(doc, "pre", { class: "body" });
        pre.textContent = payload.bodies[item.body];
        row.appendChild(pre);
      } else if (!payload.bodies.length) {
        var note = el(doc, "p", { class: "dim" });
        note.setAttribute("data-empty", "browser-body");
        note.textContent = say("empty.shortNoBody");
        row.appendChild(note);
      }
      return row;
    }

    function renderPane(step) {
      var container = doc.querySelector("[data-browser-panels]");
      if (!container || !step) return;
      while (container.firstChild) container.removeChild(container.firstChild);
      var panel = el(doc, "div", {});
      panel.setAttribute("data-browser-panel", String(step.i));
      var meta = el(doc, "p", { class: "dim" });
      meta.textContent = say("browser.stepMeta", {
        t: step.turn,
        s: step.stepInTurn,
        total: fmtTokens(step.total),
        actual: fmtTokens(step.prompt)
      });
      panel.appendChild(meta);
      if (!step.details) {
        var note = el(doc, "p", { class: "dim" });
        note.setAttribute("data-empty", "browser-window");
        note.textContent = say("empty.browserWindow");
        panel.appendChild(note);
        container.appendChild(panel);
        return;
      }
      var items = itemsFor(step);
      for (var g = 0; g < GROUPS.length; g++) {
        var group = GROUPS[g];
        var groupItems = [];
        for (var i = 0; i < items.length; i++) if ((GROUP_OF[items[i].cat] || items[i].cat) === group) groupItems.push(items[i]);
        if (groupItems.length === 0) continue;
        var heading = el(doc, "h4", {});
        heading.setAttribute("data-cat-section", group);
        var tokens = 0;
        for (var t = 0; t < groupItems.length; t++) tokens += groupItems[t].tok;
        heading.textContent = groupLabel(group) + " ";
        var count = el(doc, "span", { class: "dim" });
        count.textContent = say("browser.items", { count: groupItems.length }) + " · ≈" + fmtTokens(tokens);
        heading.appendChild(count);
        panel.appendChild(heading);
        for (var r = 0; r < groupItems.length && r < ROW_LIMIT; r++) panel.appendChild(itemRow(groupItems[r]));
        if (groupItems.length > ROW_LIMIT) {
          var more = el(doc, "details", {});
          more.setAttribute("data-more", group);
          var summary = el(doc, "summary", {});
          summary.textContent = say("common.omitted", { count: groupItems.length - ROW_LIMIT });
          more.appendChild(summary);
          for (var rest = ROW_LIMIT; rest < groupItems.length && rest < ROW_LIMIT * 10; rest++) more.appendChild(itemRow(groupItems[rest]));
          panel.appendChild(more);
        }
      }
      container.appendChild(panel);
    }

    function renderDna(step) {
      var list = doc.querySelector("[data-dna-list]");
      if (!list || !step) return;
      while (list.firstChild) list.removeChild(list.firstChild);
      var items = itemsFor(step);
      for (var i = items.length - 1; i >= 0; i--) {
        var item = items[i];
        var row = el(doc, "div", { class: "item-row" });
        row.setAttribute("data-dna-item", String(item.id));
        var tag = el(doc, "span", { class: "tag" });
        tag.textContent = catLabel(item.cat);
        row.appendChild(tag);
        var index = el(doc, "span", { class: "dim" });
        index.setAttribute("data-dna-index", String(items.length - i));
        index.textContent = "#" + (items.length - i);
        row.appendChild(index);
        var text = el(doc, "span", {});
        text.textContent = " " + item.tag + " ≈" + fmtTokens(item.tok);
        row.appendChild(text);
        list.appendChild(row);
      }
    }

    function applyIndexFilter() {
      var sections = doc.querySelectorAll("[data-cat-section]");
      for (var i = 0; i < sections.length; i++) {
        var section = sections[i];
        var group = section.getAttribute("data-cat-section");
        var hide = state.group !== null && group !== state.group;
        setHidden(section, hide);
        var next = section.nextElementSibling;
        while (next && !next.hasAttribute("data-cat-section")) {
          setHidden(next, hide);
          next = next.nextElementSibling;
        }
      }
      var rows = doc.querySelectorAll("[data-cat-index]");
      for (var r = 0; r < rows.length; r++) {
        rows[r].setAttribute("aria-pressed", rows[r].getAttribute("data-cat-index") === state.group ? "true" : "false");
      }
    }

    function selectStep(index) {
      state.step = index;
      state.group = null;
      var step = stepOf(index);
      var panels = doc.querySelectorAll("[data-step-panel]");
      for (var i = 0; i < panels.length; i++) setHidden(panels[i], panels[i].getAttribute("data-step-panel") !== String(index));
      var select = doc.querySelector("[data-browser-step]");
      if (select && select.value !== String(index)) select.value = String(index);
      renderCategoryRows(step);
      renderPane(step);
      renderDna(step);
      applyIndexFilter();
      applyFilters();
    }

    function applyFilters() {
      var inputs = doc.querySelectorAll("[data-filter-group]");
      for (var i = 0; i < inputs.length; i++) {
        var input = inputs[i];
        var group = input.getAttribute("data-filter-group");
        var selector = group === "files" ? "[data-path]" : group === "commands" ? "[data-command]" : group === "events" ? "[data-event]" : "[data-item]";
        var rows = doc.querySelectorAll(selector);
        var active = input.getAttribute("data-active-filter") || "all";
        var query = String(input.value || "").toLowerCase();
        for (var j = 0; j < rows.length; j++) {
          var row = rows[j];
          var text = (row.getAttribute("data-search") || row.textContent || "").toLowerCase();
          var kindOk =
            active === "all" ||
            (group === "files" && row.querySelector('[data-kind="' + active + '"]') !== null) ||
            (group === "commands" && ((active === "failed" && row.getAttribute("data-status") === "error") || (active === "nested" && row.getAttribute("data-nested") === "1") || (active === "slow" && row.getAttribute("data-slow") === "1"))) ||
            (group === "events" && row.getAttribute("data-kind") === active) ||
            (group === "items" && row.getAttribute("data-cat") === active);
          setHidden(row, !kindOk || (query !== "" && text.indexOf(query) < 0));
        }
      }
    }

    function locateItem(itemId) {
      for (var i = 0; i < payload.steps.length; i++) {
        var step = payload.steps[i];
        if (step.details && inRanges(step.ranges, itemId)) { selectStep(step.i); focusItem(itemId); return; }
      }
    }

    function locateTool(toolCallId) {
      if (!toolCallId) return;
      for (var i = 0; i < payload.items.length; i++) {
        if (payload.items[i].call !== toolCallId) continue;
        var target = payload.items[i];
        for (var j = 0; j < payload.steps.length; j++) {
          var step = payload.steps[j];
          if (step.details && inRanges(step.ranges, target.id)) { selectStep(step.i); focusItem(target.id); return; }
        }
      }
    }

    function focusItem(itemId) {
      var row = doc.querySelector('[data-item="' + itemId + '"]');
      if (row && row.setAttribute) row.setAttribute("open", "open");
      if (row && row.scrollIntoView) row.scrollIntoView({ block: "center" });
    }

    function applyLanguage(lang) {
      state.lang = lang;
      applyLanguageFromDoc(doc, lang, payload.dicts);
      store("insight.lang", lang);
      redrawTimeline();
      selectStep(state.step);
    }

    doc.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var toggle = target.closest("[data-toggle]");
      if (toggle) {
        var name = toggle.getAttribute("data-toggle");
        var value = toggle.getAttribute("data-value");
        if (name === "mode") { state.mode = value; store("insight.mode", value); }
        else if (name === "granularity") state.granularity = value;
        else if (state[value] !== undefined) state[value] = !state[value];
        applyToggles();
        return;
      }
      var langButton = target.closest("[data-lang-switch]");
      if (langButton) { applyLanguage(langButton.getAttribute("data-lang-switch")); return; }
      var chip = target.closest("[data-locate-item]");
      if (chip) { locateItem(Number(chip.getAttribute("data-locate-item"))); return; }
      var jump = target.closest("[data-locate-step]");
      if (jump) {
        selectStep(Number(jump.getAttribute("data-locate-step")));
        var panels = doc.querySelector("[data-browser-panels]");
        if (panels && panels.scrollIntoView) panels.scrollIntoView({ block: "start" });
        return;
      }
      var fileOp = target.closest("[data-locate-tool]");
      if (fileOp) { locateTool(fileOp.getAttribute("data-locate-tool")); return; }
      var idx = target.closest("[data-cat-index]");
      if (idx) {
        var group = idx.getAttribute("data-cat-index");
        state.group = state.group === group ? null : group;
        applyIndexFilter();
        return;
      }
      var column = target.closest("[data-step]");
      if (column) { selectStep(Number(column.getAttribute("data-step"))); return; }
      var flag = target.closest("[data-flag-step]");
      if (flag) { selectStep(Number(flag.getAttribute("data-flag-step"))); return; }
      var filterButton = target.closest("[data-event-filter],[data-file-filter],[data-command-filter]");
      if (filterButton) {
        var groupName = filterButton.hasAttribute("data-event-filter") ? "events" : filterButton.hasAttribute("data-file-filter") ? "files" : "commands";
        var input = doc.querySelector('[data-filter-group="' + groupName + '"]');
        if (input) {
          var attr = groupName === "events" ? "data-event-filter" : groupName === "files" ? "data-file-filter" : "data-command-filter";
          input.setAttribute("data-active-filter", filterButton.getAttribute(attr));
          var siblings = filterButton.parentNode.querySelectorAll("button");
          for (var i = 0; i < siblings.length; i++) siblings[i].setAttribute("aria-pressed", siblings[i] === filterButton ? "true" : "false");
          applyFilters();
        }
        return;
      }
    });

    doc.addEventListener("change", function (event) {
      var target = event.target;
      if (target && target.hasAttribute && target.hasAttribute("data-browser-step")) selectStep(Number(target.value));
    });

    doc.addEventListener("input", function (event) {
      var target = event.target;
      if (!target || !target.hasAttribute || !target.hasAttribute("data-filter-group")) return;
      applyFilters();
    });

    if (typeof win.IntersectionObserver === "function") {
      var observer = new win.IntersectionObserver(function (entries) {
        var best = null;
        for (var i = 0; i < entries.length; i++) {
          if (!entries[i].isIntersecting) continue;
          if (!best || entries[i].boundingClientRect.top < best.boundingClientRect.top) best = entries[i];
        }
        if (best && best.target && best.target.id) highlightRailFromDoc(doc, best.target.id);
      }, { rootMargin: "-20% 0px -70% 0px", threshold: 0 });
      var sections = doc.querySelectorAll("[data-card]");
      for (var s = 0; s < sections.length; s++) {
        if (sections[s].id) observer.observe(sections[s]);
      }
    }

    applyToggles();
    applyLanguageFromDoc(doc, state.lang, payload.dicts);
    selectStep(state.step);
    applyLanguage(state.lang);
  }

  if (typeof window !== "undefined") {
    window.__insight = {
      visibleRows: visibleRows,
      nextIndex: nextIndex,
      resolveLang: resolveLang,
      buildTimeline: buildTimeline,
      turnBuckets: turnBuckets,
      translate: translate,
      groupLabelFor: groupLabelFor,
      catLabelFor: catLabelFor,
      applyLanguageFromDoc: applyLanguageFromDoc,
      highlightRailFromDoc: highlightRailFromDoc
    };
    if (typeof document !== "undefined" && document.querySelector) {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { boot(document, window); });
      else boot(document, window);
    }
  }
})();
`;
