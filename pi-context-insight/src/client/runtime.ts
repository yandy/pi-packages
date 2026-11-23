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
      adaptive: false,
      duration: false
    };

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

    function applyToggles() {
      var buttons = doc.querySelectorAll("[data-toggle]");
      for (var i = 0; i < buttons.length; i++) {
        var button = buttons[i];
        var name = button.getAttribute("data-toggle");
        var value = button.getAttribute("data-value");
        var pressed = (name === "mode" && value === state.mode) || (name === "granularity" && value === state.granularity) || (name !== "mode" && name !== "granularity" && !!state[value]);
        button.setAttribute("aria-pressed", pressed ? "true" : "false");
      }
      doc.body.setAttribute("data-mode", state.mode);
      doc.body.setAttribute("data-dna", state.dna ? "on" : "off");
      doc.body.setAttribute("data-overview", state.overview ? "on" : "off");
      doc.body.setAttribute("data-granularity", state.granularity);
      var dna = doc.querySelector("[data-dna-list]");
      if (dna) setHidden(dna, !state.dna);
      var chart = doc.querySelector("[data-timeline-scroll]");
      if (chart) setHidden(chart, state.overview);
      var overview = doc.querySelector("[data-timeline-overview]");
      if (overview) setHidden(overview, !state.overview);
    }

    function renderCategoryRows(step) {
      var rows = doc.querySelectorAll("[data-cat-row]");
      var sums = step && step.details ? groupSums(step) : (step ? step.sums : {});
      var deltas = groupDeltas(step);
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var group = row.getAttribute("data-cat-row");
        var cells = row.querySelectorAll("td");
        if (cells.length < 5) continue;
        var unknownSystem = group === "systemBase" || group === "toolDefinitions" ? step && !step.systemKnown : false;
        var tokens = sums[group] || 0;
        var delta = deltas[group] || 0;
        cells[1].textContent = unknownSystem ? "—" : step && step.details ? String(countItems(step, group)) : "—";
        cells[2].textContent = unknownSystem ? "—" : state.mode === "delta" ? (delta === 0 ? "—" : (delta > 0 ? "+" : "") + fmtTokens(delta)) : "≈" + fmtTokens(tokens);
        cells[3].textContent = unknownSystem || !step || !step.total || state.mode === "delta" ? "—" : ((tokens / step.total) * 100).toFixed(1) + "%";
        cells[4].textContent = unknownSystem || delta === 0 ? "" : (delta > 0 ? "+" : "") + fmtTokens(delta);
      }
    }

    function countItems(step, group) {
      var count = 0;
      var list = itemsFor(step);
      for (var i = 0; i < list.length; i++) if ((GROUP_OF[list[i].cat] || list[i].cat) === group) count += 1;
      return count;
    }

    function renderPanel(step) {
      var container = doc.querySelector("[data-browser-panels]");
      if (!container || !step) return;
      while (container.firstChild) container.removeChild(container.firstChild);
      var panel = doc.createElement("div");
      panel.setAttribute("data-browser-panel", String(step.i));
      var meta = doc.createElement("p");
      meta.className = "dim";
      meta.textContent = "T" + step.turn + " · S" + step.stepInTurn + " · ≈" + fmtTokens(step.total) + " · " + fmtTokens(step.prompt);
      panel.appendChild(meta);
      if (!step.details) {
        var note = doc.createElement("p");
        note.className = "dim";
        note.setAttribute("data-empty", "browser-window");
        note.textContent = "summary only";
        panel.appendChild(note);
        container.appendChild(panel);
        return;
      }
      var items = itemsFor(step);
      for (var g = 0; g < GROUPS.length; g++) {
        var group = GROUPS[g];
        var groupItems = items.filter(function (item) { return (GROUP_OF[item.cat] || item.cat) === group; });
        if (groupItems.length === 0) continue;
        var heading = doc.createElement("h4");
        heading.textContent = group;
        panel.appendChild(heading);
        for (var i = 0; i < groupItems.length && i < ROW_LIMIT; i++) {
          var item = groupItems[i];
          var row = doc.createElement("details");
          row.className = "row";
          row.setAttribute("data-item", String(item.id));
          row.setAttribute("data-cat", item.cat);
          row.setAttribute("data-call", item.call || "");
          row.setAttribute("data-search", (item.cat + " " + item.tag).toLowerCase());
          var summary = doc.createElement("summary");
          var tag = doc.createElement("span");
          tag.className = "tag";
          tag.textContent = item.cat + " · " + item.tag + " ≈" + fmtTokens(item.tok) + (item.truncated ? " ✂" : "");
          summary.appendChild(tag);
          row.appendChild(summary);
          if (item.body !== null && payload.bodies[item.body] !== undefined) {
            var pre = doc.createElement("pre");
            pre.className = "body";
            pre.textContent = payload.bodies[item.body];
            row.appendChild(pre);
          }
          panel.appendChild(row);
        }
        if (groupItems.length > ROW_LIMIT) {
          var more = doc.createElement("details");
          more.setAttribute("data-more", group);
          var moreSummary = doc.createElement("summary");
          moreSummary.textContent = "+" + (groupItems.length - ROW_LIMIT);
          more.appendChild(moreSummary);
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
        var row = doc.createElement("div");
        row.className = "row";
        row.setAttribute("data-dna-item", String(item.id));
        var tag = doc.createElement("span");
        tag.className = "tag";
        tag.textContent = item.cat;
        row.appendChild(tag);
        row.appendChild(doc.createTextNode(" #" + (i + 1) + " " + item.tag + " ≈" + fmtTokens(item.tok)));
        list.appendChild(row);
      }
    }

    function selectStep(index) {
      state.step = index;
      var step = stepOf(index);
      var strips = doc.querySelectorAll("[data-step-panel]");
      for (var i = 0; i < strips.length; i++) setHidden(strips[i], strips[i].getAttribute("data-step-panel") !== String(index));
      var select = doc.querySelector("[data-browser-step]");
      if (select && select.value !== String(index)) select.value = String(index);
      renderCategoryRows(step);
      renderPanel(step);
      renderDna(step);
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

    function applyLanguage(lang) {
      var dict = (payload.dicts && payload.dicts[lang]) || {};
      var nodes = doc.querySelectorAll("[data-i18n]");
      for (var i = 0; i < nodes.length; i++) {
        var key = nodes[i].getAttribute("data-i18n");
        if (dict[key] !== undefined) nodes[i].textContent = dict[key];
      }
      doc.documentElement.setAttribute("lang", lang);
      var buttons = doc.querySelectorAll("[data-lang-switch]");
      for (var j = 0; j < buttons.length; j++) {
        buttons[j].setAttribute("aria-pressed", buttons[j].getAttribute("data-lang-switch") === lang ? "true" : "false");
      }
      store("insight.lang", lang);
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
        selectStep(state.step);
        return;
      }
      var langButton = target.closest("[data-lang-switch]");
      if (langButton) { applyLanguage(langButton.getAttribute("data-lang-switch")); return; }
      var chip = target.closest("[data-locate-item]");
      if (chip) { locateItem(Number(chip.getAttribute("data-locate-item"))); return; }
      var fileOp = target.closest("[data-locate-tool]");
      if (fileOp) { locateTool(fileOp.getAttribute("data-locate-tool")); return; }
      var column = target.closest("[data-step]");
      if (column) { selectStep(Number(column.getAttribute("data-step"))); return; }
      var flag = target.closest("[data-flag-step]");
      if (flag) { selectStep(Number(flag.getAttribute("data-flag-step"))); return; }
      var filterButton = target.closest("[data-event-filter],[data-file-filter],[data-command-filter]");
      if (filterButton) {
        var group = filterButton.hasAttribute("data-event-filter") ? "events" : filterButton.hasAttribute("data-file-filter") ? "files" : "commands";
        var input = doc.querySelector('[data-filter-group="' + group + '"]');
        if (input) {
          var attr = group === "events" ? "data-event-filter" : group === "files" ? "data-file-filter" : "data-command-filter";
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

    applyToggles();
    applyLanguage(resolveLang(load("insight.lang"), payload.lang));
    selectStep(state.step);
  }

  if (typeof window !== "undefined") {
    window.__insight = { visibleRows: visibleRows, nextIndex: nextIndex, resolveLang: resolveLang };
    if (typeof document !== "undefined" && document.querySelector) {
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { boot(document, window); });
      else boot(document, window);
    }
  }
})();
`;
