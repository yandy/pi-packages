export const CLIENT_RUNTIME = String.raw`
(function () {
  "use strict";

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

    function store(key, value) {
      try { if (storage) storage.setItem(key, value); } catch (error) { /* ignore */ }
    }

    function load(key) {
      try { return storage ? storage.getItem(key) : null; } catch (error) { return null; }
    }

    var state = {
      step: payload.steps.length > 0 ? payload.steps[payload.steps.length - 1].i : 0,
      mode: load("insight.mode") || "total",
      granularity: "step",
      dna: false,
      overview: false
    };

    function applyToggles() {
      var buttons = doc.querySelectorAll("[data-toggle]");
      for (var index = 0; index < buttons.length; index++) {
        var button = buttons[index];
        var name = button.getAttribute("data-toggle");
        var value = button.getAttribute("data-value");
        var pressed = (name === "mode" && value === state.mode) || (name === "granularity" && value === state.granularity) || (name === value && !!state[value]);
        button.setAttribute("aria-pressed", pressed ? "true" : "false");
      }
      doc.body.setAttribute("data-mode", state.mode);
      doc.body.setAttribute("data-dna", state.dna ? "on" : "off");
    }

    function selectStep(index) {
      state.step = index;
      var panels = doc.querySelectorAll("[data-browser-panel]");
      for (var i = 0; i < panels.length; i++) setHidden(panels[i], panels[i].getAttribute("data-browser-panel") !== String(index));
      var strips = doc.querySelectorAll("[data-step-panel]");
      for (var j = 0; j < strips.length; j++) setHidden(strips[j], strips[j].getAttribute("data-step-panel") !== String(index));
      var select = doc.querySelector("[data-browser-step]");
      if (select && select.value !== String(index)) select.value = String(index);
      renderPanel(index);
    }

    function stepOf(index) {
      for (var i = 0; i < payload.steps.length; i++) if (payload.steps[i].i === index) return payload.steps[i];
      return null;
    }

    function renderPanel(index) {
      var container = doc.querySelector("[data-browser-panels]");
      var step = stepOf(index);
      if (!container || !step) return;
      if (container.querySelector('[data-browser-panel="' + index + '"]')) return;
      var panel = doc.createElement("div");
      panel.setAttribute("data-browser-panel", String(index));
      var meta = doc.createElement("p");
      meta.className = "dim";
      meta.textContent = "T" + step.turn + " · S" + index + " · total " + step.total + " · Δ" + step.deltaTotal;
      panel.appendChild(meta);
      var items = doc.createElement("div");
      panel.appendChild(items);
      for (var i = 0; i < payload.items.length; i++) {
        var item = payload.items[i];
        var row = doc.createElement("details");
        row.className = "row";
        row.setAttribute("data-item", String(item.id));
        row.setAttribute("data-cat", item.cat);
        var summary = doc.createElement("summary");
        var tag = doc.createElement("span");
        tag.className = "tag";
        tag.textContent = item.cat + " · " + item.tag + " ≈" + item.tok;
        summary.appendChild(tag);
        row.appendChild(summary);
        if (item.body !== null && payload.bodies[item.body] !== undefined) {
          var pre = doc.createElement("pre");
          pre.className = "body";
          pre.textContent = payload.bodies[item.body];
          row.appendChild(pre);
        }
        items.appendChild(row);
      }
      container.appendChild(panel);
      selectStep(index);
    }

    function applyFilters() {
      var inputs = doc.querySelectorAll("[data-filter-group]");
      for (var i = 0; i < inputs.length; i++) {
        var input = inputs[i];
        var group = input.getAttribute("data-filter-group");
        var query = String(input.value || "").toLowerCase();
        var rows = doc.querySelectorAll(group === "files" ? "[data-path]" : group === "commands" ? "[data-command]" : group === "events" ? "[data-event]" : "[data-item]");
        for (var j = 0; j < rows.length; j++) {
          var text = (rows[j].getAttribute("data-search") || rows[j].textContent || "").toLowerCase();
          setHidden(rows[j], query !== "" && text.indexOf(query) < 0);
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

    doc.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var toggle = target.closest("[data-toggle]");
      if (toggle) {
        var name = toggle.getAttribute("data-toggle");
        var value = toggle.getAttribute("data-value");
        if (name === "mode") { state.mode = value; store("insight.mode", value); }
        else if (name === "granularity") state.granularity = value;
        else state[value] = !state[value];
        applyToggles();
        return;
      }
      var langButton = target.closest("[data-lang-switch]");
      if (langButton) { applyLanguage(langButton.getAttribute("data-lang-switch")); return; }
      var column = target.closest("[data-step]");
      if (column) { selectStep(Number(column.getAttribute("data-step"))); return; }
    });

    doc.addEventListener("change", function (event) {
      var target = event.target;
      if (!target || !target.getAttribute) return;
      if (target.hasAttribute("data-browser-step")) selectStep(Number(target.value));
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
