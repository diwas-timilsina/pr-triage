// ==UserScript==
// @name         pr-triage overlay
// @namespace    pr-triage
// @version      2.14
// @description  Adds a "Triage" tab to GitHub PR pages: a priority-ordered, GitHub-native diff view with what/why/verdict notes, per-diff deep review (drafted comments and thread replies), and a file sidebar. Reads data from a local `pr-triage serve` daemon.
// @match        https://github.com/*/pull/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  var BASE = "http://127.0.0.1:8642";
  var POLL_MS = 2000;
  var data = null;
  var threads = [];
  var dataPr = null;
  var fetching = false;
  var serverState = "offline";
  var viewEl = null;
  var detailIdx = null;
  var collapsed = {};
  var reviewCache = {};   // hunk id -> {status, comments, replies, error}
  var reviewBoxes = {};   // hunk id -> live results container in the current render
  var chatState = {};     // "pr" | "h:<id>" -> {messages: [{role,text}], pending}
  var listFilter = "all"; // all | 70 | 40 — priority filter for the list view
  var lastRendered = "";

  function prPath() {
    var m = location.pathname.match(/^(\/[^/]+\/[^/]+\/pull\/\d+)/);
    return m ? m[1] : null;
  }

  function onDiffTab() {
    var p = prPath();
    if (p === null) return false;
    var rest = location.pathname.slice(p.length);
    return rest.indexOf("/files") === 0 || rest.indexOf("/changes") === 0;
  }

  function isDark() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  }

  var GH_FONT = '-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif';
  var GH_MONO = 'ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace';

  function theme() {
    var d = isDark();
    return {
      fg: d ? "#e6edf3" : "#1f2328",
      muted: d ? "#9198a1" : "#59636e",
      border: d ? "#3d444d" : "#d1d9e0",
      canvas: d ? "#0d1117" : "#ffffff",
      subtle: d ? "#151b23" : "#f6f8fa",
      accent: d ? "#4493f8" : "#0969da",
      addBg: d ? "rgba(46,160,67,.15)" : "#dafbe1",
      addGutter: d ? "rgba(46,160,67,.30)" : "#aceebb",
      delBg: d ? "rgba(248,81,73,.12)" : "#ffebe9",
      delGutter: d ? "rgba(248,81,73,.30)" : "#ffcecb",
      hunkBg: d ? "rgba(56,139,253,.15)" : "#ddf4ff",
      // syntax (Primer)
      kw: d ? "#ff7b72" : "#cf222e",
      str: d ? "#a5d6ff" : "#0a3069",
      com: d ? "#8b949e" : "#6e7781",
      num: d ? "#79c0ff" : "#0550ae",
      fn: d ? "#d2a8ff" : "#8250df",
      blocker: "#d1242f",
      question: d ? "#4493f8" : "#0969da",
      suggestion: d ? "#7ee787" : "#1a7f37",
    };
  }

  function scoreColor(s) {
    if (s === null || s < 0) return "#8b949e";
    if (s >= 80) return "#d1242f";
    if (s >= 60) return "#bc4c00";
    if (s >= 40) return "#0969da";
    return "#8b949e";
  }

  function scoreStyle(s) {
    var d = isDark();
    if (s >= 80) return { fg: d ? "#ff7b72" : "#cf222e", bg: "rgba(209,36,47,.12)" };
    if (s >= 60) return { fg: d ? "#ffa657" : "#bc4c00", bg: "rgba(188,76,0,.12)" };
    if (s >= 40) return { fg: d ? "#79c0ff" : "#0969da", bg: "rgba(9,105,218,.12)" };
    return { fg: d ? "#9198a1" : "#59636e", bg: "rgba(140,149,159,.12)" };
  }

  function scorePill(s, small) {
    var st = scoreStyle(s === null ? -1 : s);
    return el("span",
      "display:inline-block;border-radius:2em;font-weight:700;font-variant-numeric:tabular-nums;" +
      (small ? "font-size:11px;padding:0 8px;min-width:34px;" : "font-size:12px;padding:2px 10px;min-width:44px;") +
      "text-align:center;color:" + st.fg + ";background:" + st.bg + ";",
      (s === null || s < 0) ? "??" : s + "%");
  }

  function filePathEl(file, lines, t) {
    var wrap = el("span", "font-family:" + GH_MONO + ";font-size:13px;word-break:break-all;min-width:0;");
    var ix = file.lastIndexOf("/");
    if (ix > 0) wrap.appendChild(el("span", "color:" + t.muted + ";", file.slice(0, ix + 1)));
    wrap.appendChild(el("span", "font-weight:600;color:" + t.fg + ";", file.slice(ix + 1)));
    if (lines) wrap.appendChild(el("span", "color:" + t.muted + ";", ":" + lines));
    return wrap;
  }

  function signalDot(kind, text) {
    var x = String(text).toLowerCase();
    if (kind === "tests") {
      if (/no test|not covered|untested|uncovered/.test(x)) return "#bc4c00";
      if (/covered|is test|test code/.test(x)) return "#1a7f37";
      return "#8b949e";
    }
    if (/\ball\b|\bevery\b|wide|fleet|global|entire/.test(x)) return "#d1242f";
    return "#8b949e";
  }

  function signalChip(label, text, dotColor, t) {
    var chip = el("span",
      "display:inline-flex;gap:9px;align-items:baseline;max-width:100%;border:1px solid " +
      t.border + ";border-radius:8px;padding:5px 13px;font-size:13px;line-height:1.55;" +
      "background:" + t.canvas + ";");
    chip.appendChild(el("span", "flex:none;color:" + dotColor + ";font-size:10px;", "●"));
    chip.appendChild(el("span",
      "flex:none;font-weight:700;letter-spacing:.05em;font-size:10.5px;text-transform:uppercase;" +
      "color:" + t.muted + ";padding-top:1px;", label));
    chip.appendChild(el("span", "color:" + t.fg + ";min-width:0;", text.replace(/\n/g, " · ")));
    return chip;
  }

  function el(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
  }

  // --------------------------------------------------------- syntax coloring

  var KEYWORDS = {
    go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota error string int int64 int32 uint byte bool float64 append len cap make new",
    py: "def class return if elif else for while import from as with try except finally raise pass lambda None True False and or not in is yield global nonlocal async await assert del self",
    js: "function var let const return if else for while do switch case break continue new delete typeof instanceof in of class extends super this null undefined true false async await yield import export from default try catch finally throw void",
    java: "public private protected static final void class interface extends implements return if else for while do switch case break continue new this null true false try catch finally throw throws import package abstract",
    rb: "def end class module return if elsif else unless case when while until for in do yield begin rescue ensure raise nil true false self require and or not",
    sh: "if then else elif fi for while do done case esac function return exit local export echo set unset shift source true false in",
    yml: "true false null yes no on off",
    tf: "resource variable output module provider data locals terraform true false null for_each count depends_on",
    sql: "select from where insert into update delete set values create table alter drop join left right inner outer on group by order having limit as and or not null distinct union all",
    c: "int char long short unsigned signed void float double struct union enum typedef static extern const volatile return if else for while do switch case break continue sizeof NULL true false include define",
    rs: "fn let mut const static struct enum impl trait for while loop if else match return pub use mod crate self super as in ref move async await dyn where Some None Ok Err true false",
    json: "true false null",
  };
  var COMMENT_MARK = { go: "//", js: "//", java: "//", c: "//", rs: "//",
                       py: "#", rb: "#", sh: "#", yml: "#", tf: "#", sql: "--" };

  function langOf(file) {
    var base = file.split(" -> ").pop().split("/").pop().toLowerCase();
    if (base === "makefile") return "sh";
    var m = base.match(/\.([a-z0-9]+)$/);
    var ext = m ? m[1] : "";
    return ({ go: "go", py: "py", js: "js", jsx: "js", ts: "js", tsx: "js", mjs: "js",
              java: "java", kt: "java", rb: "rb", sh: "sh", bash: "sh", zsh: "sh",
              yaml: "yml", yml: "yml", tf: "tf", sql: "sql", c: "c", h: "c", cc: "c",
              cpp: "c", hpp: "c", rs: "rs", json: "json" })[ext] || null;
  }

  function highlightInto(parent, code, lang, t) {
    if (!lang) { parent.appendChild(document.createTextNode(code)); return; }
    var kws = " " + (KEYWORDS[lang] || "") + " ";
    var cm = COMMENT_MARK[lang];
    var i = 0, n = code.length, plain = "";
    function flush() {
      if (plain) { parent.appendChild(document.createTextNode(plain)); plain = ""; }
    }
    function colored(text, color) {
      flush();
      var s = document.createElement("span");
      s.textContent = text;
      s.style.color = color;
      parent.appendChild(s);
    }
    while (i < n) {
      var ch = code[i];
      if (cm && code.startsWith(cm, i) && (i === 0 || code[i - 1] !== ":")) {
        colored(code.slice(i), t.com);
        flush();
        return;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        var j = i + 1;
        while (j < n && code[j] !== ch) { if (code[j] === "\\") j++; j++; }
        colored(code.slice(i, Math.min(j + 1, n)), t.str);
        i = j + 1;
        continue;
      }
      if (/[0-9]/.test(ch) && !/[A-Za-z0-9_]/.test(code[i - 1] || "")) {
        var j2 = i;
        while (j2 < n && /[0-9a-fA-Fx._]/.test(code[j2])) j2++;
        colored(code.slice(i, j2), t.num);
        i = j2;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        var j3 = i;
        while (j3 < n && /[A-Za-z0-9_]/.test(code[j3])) j3++;
        var word = code.slice(i, j3);
        if (kws.indexOf(" " + word + " ") !== -1) colored(word, t.kw);
        else if (code[j3] === "(") colored(word, t.fn);
        else plain += word;
        i = j3;
        continue;
      }
      plain += ch;
      i++;
    }
    flush();
  }

  // ------------------------------------------------- GitHub-native diff table

  function renderDiffTable(h, t, capLines) {
    var lines = String(h.diff).split("\n");
    var lang = langOf(h.file);
    var container = el("div", "border-top:1px solid " + t.border + ";overflow-x:auto;");
    var table = el("table", "border-collapse:collapse;min-width:100%;font:12px/21px " + GH_MONO + ";");
    container.appendChild(table);
    var oldLn = 0, newLn = 0;

    function gutterTd(text, bg) {
      var td = el("td", "width:1%;min-width:40px;text-align:right;padding:0 10px;" +
        "color:" + t.muted + ";user-select:none;vertical-align:top;" +
        (bg ? "background:" + bg + ";" : ""), text);
      return td;
    }

    function addRow(ln) {
      var tr = document.createElement("tr");
      var m = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldLn = +m[1]; newLn = +m[2];
        var td = el("td", "padding:2px 16px;color:" + t.muted + ";background:" + t.hunkBg + ";" +
          "font-size:12px;white-space:pre;", ln);
        td.colSpan = 3;
        tr.appendChild(td);
        table.appendChild(tr);
        return;
      }
      var kind = ln[0] === "+" ? "add" : ln[0] === "-" ? "del" : ln[0] === "\\" ? "meta" : "ctx";
      var codeBg = kind === "add" ? t.addBg : kind === "del" ? t.delBg : "";
      var gutBg = kind === "add" ? t.addGutter : kind === "del" ? t.delGutter : t.subtle;
      var o = "", nn = "";
      if (kind === "add") { nn = String(newLn++); }
      else if (kind === "del") { o = String(oldLn++); }
      else if (kind === "ctx") { o = String(oldLn++); nn = String(newLn++); }
      if (kind === "ctx") gutBg = "";
      var oldTd = gutterTd(o, gutBg);
      var newTd = gutterTd(nn, gutBg);
      tr.appendChild(oldTd);
      tr.appendChild(newTd);
      if (nn && h.id) {
        // GitHub-native manual commenting: hover shows +, click opens a composer
        newTd.style.cursor = "pointer";
        newTd.title = "Comment on line " + nn;
        (function (lineNo, rowEl, cell) {
          rowEl.addEventListener("mouseenter", function () {
            cell.dataset.orig = cell.textContent;
            cell.textContent = "+";
            cell.style.color = t.accent;
            cell.style.fontWeight = "700";
          });
          rowEl.addEventListener("mouseleave", function () {
            if (cell.dataset.orig) cell.textContent = cell.dataset.orig;
            cell.style.color = t.muted;
            cell.style.fontWeight = "";
          });
          ["click", "dblclick"].forEach(function (ev) {
            cell.addEventListener(ev, function (e) {
              e.stopPropagation();
              if (ev === "click") openComposer(rowEl, h, lineNo, t);
            });
          });
        })(+nn, tr, newTd);
      }
      var code = el("td", "white-space:pre;padding:0 10px;width:100%;vertical-align:top;" +
        (codeBg ? "background:" + codeBg + ";" : "") +
        (kind === "meta" ? "color:" + t.muted + ";" : ""));
      if (nn) tr.dataset.nl = nn;
      var sign = el("span", "display:inline-block;width:12px;color:" +
        (kind === "add" ? t.suggestion : kind === "del" ? t.blocker : t.muted) + ";",
        kind === "add" ? "+" : kind === "del" ? "-" : " ");
      code.appendChild(sign);
      var body = kind === "meta" ? ln : ln.slice(1);
      if (kind === "meta") code.appendChild(document.createTextNode(body));
      else highlightInto(code, body, lang, t);
      tr.appendChild(code);
      table.appendChild(tr);
    }

    var shown = (capLines && lines.length > capLines + 20) ? capLines : lines.length;
    for (var idx = 0; idx < shown; idx++) addRow(lines[idx]);
    if (shown < lines.length) {
      var more = el("div", "padding:5px 16px;cursor:pointer;color:" + t.accent + ";" +
        "font-size:12px;background:" + t.subtle + ";border-top:1px solid " + t.border + ";",
        "↕ Show all " + lines.length + " lines");
      more.addEventListener("click", function (e) {
        e.stopPropagation();
        for (var k = shown; k < lines.length; k++) addRow(lines[k]);
        more.remove();
      });
      container.appendChild(more);
    }
    return container;
  }

  function openComposer(tr, h, line, t) {
    var table = tr.parentElement;
    var existing = table.querySelector('tr[data-composer-line="' + line + '"]');
    if (existing) {
      var eta = existing.querySelector("textarea");
      if (eta) eta.focus();
      return;
    }
    var row = document.createElement("tr");
    row.dataset.triageComposer = "1";
    row.dataset.composerLine = line;
    var td = document.createElement("td");
    td.colSpan = 3;
    td.style.cssText = "padding:8px 14px;background:" + t.subtle + ";white-space:normal;" +
      "border-top:1px solid " + t.border + ";border-bottom:1px solid " + t.border + ";" +
      "font-family:" + GH_FONT + ";";
    var head = el("div", "display:flex;gap:10px;align-items:baseline;");
    head.appendChild(el("span", "font-size:12px;font-weight:600;", "New comment on line " + line));
    head.appendChild(el("span", "flex:1;"));
    head.appendChild(linkish("Cancel", t, function () { row.remove(); }));
    td.appendChild(head);
    td.appendChild(editorWidget(t, "", function (text, cb) { postComment(h, line, text, cb); }));
    row.appendChild(td);
    tr.after(row);
    var ta = td.querySelector("textarea");
    if (ta) ta.focus();
  }

  function flashLine(card, newLine, t) {
    var tr = card.querySelector('tr[data-nl="' + newLine + '"]');
    if (!tr) return;
    tr.scrollIntoView({ block: "center", behavior: "smooth" });
    var prev = tr.style.outline;
    tr.style.outline = "2px solid " + t.accent;
    setTimeout(function () { tr.style.outline = prev; }, 2000);
  }

  // ------------------------------------------------------------------ badges

  function badge(text, color, title, anchor) {
    var b = document.createElement("span");
    b.className = "pr-triage-badge";
    b.textContent = text;
    b.title = (title ? title + "\n\n" : "") + "click to open the Triage view";
    b.style.cssText =
      "display:inline-block;margin-left:8px;padding:0 7px;border-radius:10px;" +
      "font:600 11px/18px " + GH_FONT + ";color:#fff;vertical-align:middle;cursor:pointer;" +
      "background:" + color + ";";
    b.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      openViewAt(anchor);
    });
    return b;
  }

  function fileStats() {
    var stats = {};
    data.hunks.forEach(function (h) {
      var st = stats[h.anchor] || (stats[h.anchor] = { max: -1, hunks: [] });
      st.hunks.push(h);
      var s = h.importance === null ? -1 : h.importance;
      if (s > st.max) st.max = s;
    });
    return stats;
  }

  function annotateFiles() {
    var stats = fileStats();
    Object.keys(stats).forEach(function (anchor) {
      var target = document.getElementById(anchor);
      if (!target || target.querySelector(":scope .pr-triage-badge")) return;
      var st = stats[anchor];
      var label = st.max >= 0 ? st.max + "%" : "??";
      var tips = st.hunks
        .filter(function (h) { return h.verdict || h.reason; })
        .slice(0, 4)
        .map(function (h) { return (h.importance === null ? "??" : h.importance + "%") + " " + (h.verdict || h.reason); })
        .join("\n");
      var header =
        target.querySelector("summary") ||
        target.querySelector('[class*="DiffFileHeader"] h3, [class*="file-header"] a, .file-info') ||
        target.firstElementChild;
      (header || target).appendChild(badge(label, scoreColor(st.max), tips, anchor));
    });
  }

  function removeBadges() {
    document.querySelectorAll(".pr-triage-badge").forEach(function (b) { b.remove(); });
  }

  // ----------------------------------------------------------- payload guard

  function validHunk(h) {
    return h && typeof h === "object" &&
      typeof h.anchor === "string" && /^diff-[0-9a-f]{40,64}$/.test(h.anchor) &&
      (h.importance === null ||
        (typeof h.importance === "number" && h.importance >= 0 && h.importance <= 100)) &&
      typeof h.heuristic === "boolean" &&
      typeof h.file === "string" && h.file.length > 0 && h.file.length <= 300;
  }

  function slimComment(c) {
    if (!c || typeof c !== "object") return null;
    if (typeof c.path !== "string" || !c.path || c.path.length > 300) return null;
    if (typeof c.body !== "string") return null;
    var line = (typeof c.line === "number" && c.line >= 0 && c.line <= 1000000) ? c.line : null;
    return {
      id: typeof c.id === "number" ? c.id : null,
      reply_to: typeof c.reply_to === "number" ? c.reply_to : null,
      path: c.path,
      line: line,
      user: (typeof c.user === "string" ? c.user : "").slice(0, 60),
      body: c.body.slice(0, 2000),
      created_at: (typeof c.created_at === "string" ? c.created_at : "").slice(0, 25),
    };
  }

  function buildThreads(list) {
    var roots = {}, out = [];
    list.forEach(function (c) {
      if (c.reply_to === null) {
        var th = { root: c, replies: [] };
        if (c.id !== null) roots[c.id] = th;
        out.push(th);
      }
    });
    list.forEach(function (c) {
      if (c.reply_to !== null) {
        if (roots[c.reply_to]) roots[c.reply_to].replies.push(c);
        else out.push({ root: c, replies: [] });
      }
    });
    return out;
  }

  function acceptData(d) {
    var p = prPath();
    if (!d || !d.pr || typeof d.pr.url !== "string" || !p) return;
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(d.pr.url)) return;
    var served;
    try { served = new URL(d.pr.url).pathname.replace(/\/+$/, ""); } catch (e) { return; }
    if (served.toLowerCase() !== p.toLowerCase()) {
      console.info("[pr-triage] served data is for", d.pr.url, "— not this PR; ignoring");
      return;
    }
    if (!Array.isArray(d.hunks)) return;
    var hunks = d.hunks.filter(validHunk).map(function (h) {
      return {
        id: (typeof h.id === "string" && /^H\d+n?$/.test(h.id)) ? h.id : "",
        anchor: h.anchor,
        file: h.file,
        lines: String(h.lines == null ? "" : h.lines).slice(0, 40),
        importance: h.importance,
        heuristic: h.heuristic,
        category: (typeof h.category === "string" ? h.category : "").slice(0, 32),
        reason: (typeof h.reason === "string" ? h.reason : "").slice(0, 400),
        what: (typeof h.what === "string" ? h.what : "").slice(0, 400),
        why: (typeof h.why === "string" ? h.why : "").slice(0, 400),
        tests: (typeof h.tests === "string" ? h.tests : "").slice(0, 400),
        blast: (typeof h.blast === "string" ? h.blast : "").slice(0, 400),
        verdict: (typeof h.verdict === "string" ? h.verdict : "").slice(0, 400),
        diff: (typeof h.diff === "string" ? h.diff : "").slice(0, 20000),
      };
    });
    if (!hunks.length) return;
    threads = buildThreads((Array.isArray(d.comments) ? d.comments : [])
      .map(slimComment).filter(Boolean).slice(0, 300));
    hydrateReviews(d.reviews, hunks);
    var appr = (typeof d.approvability === "number" && d.approvability >= 0 && d.approvability <= 100)
      ? Math.round(d.approvability) : null;
    data = {
      pr: d.pr,
      hunks: hunks,
      tldr: (typeof d.tldr === "string" ? d.tldr : "").slice(0, 900),
      impression: (typeof d.impression === "string" ? d.impression : "").slice(0, 900),
      approvability: appr,
      approveSignal: (typeof d.approve_signal === "string" ? d.approve_signal : "").slice(0, 300),
    };
    dataPr = p;
    serverState = "ready";
  }

  // -------------------------------------------------------------- transport

  function request(method, url, headers, body, cb, timeoutMs) {
    var gmXhr = (typeof GM_xmlhttpRequest !== "undefined" && GM_xmlhttpRequest) ||
                (typeof GM !== "undefined" && GM && GM.xmlHttpRequest);
    if (gmXhr) {
      gmXhr({
        method: method, url: url, headers: headers || {}, data: body || undefined,
        timeout: timeoutMs || 20000,
        onload: function (r) { cb(r.status, r.responseText); },
        onerror: function () { cb(0, ""); },
        ontimeout: function () { cb(0, ""); },
      });
    } else {
      fetch(url, { method: method, headers: headers || {}, body: body || undefined, cache: "no-store" })
        .then(function (r) { return r.text().then(function (t) { cb(r.status, t); }); })
        .catch(function () { cb(0, ""); });
    }
  }

  function loadData() {
    if (fetching || data) return;
    var p = prPath();
    if (!p) return;
    fetching = true;
    request("GET", BASE + "/triage.json?pr=" + encodeURIComponent(p), null, null,
      function (status, text) {
        fetching = false;
        if (status === 200) {
          try { acceptData(JSON.parse(text)); } catch (e) {}
          if (!data) serverState = "empty";
          return;
        }
        if (status === 404) {
          var st = "";
          try { st = (JSON.parse(text) || {}).status || ""; } catch (e) {}
          serverState = (st === "queued" || st === "running") ? st
            : (st === "error" ? "error" : "absent");
          return;
        }
        serverState = "offline";
      });
  }

  function postTriage() {
    var p = prPath();
    if (!p) return;
    serverState = "queued";
    if (viewEl) renderViewContent();
    request("POST", BASE + "/triage",
      { "Content-Type": "application/json", "X-PR-Triage": "1" },
      JSON.stringify({ pr: p }),
      function (status) {
        serverState = (status === 200 || status === 202) ? "queued" : "error";
        if (viewEl) renderViewContent();
      });
  }

  // -------------------------------------------------------------- deep review

  function slimReview(r) {
    var out = { status: "done", comments: [], replies: [] };
    (Array.isArray(r.comments) ? r.comments : []).slice(0, 10).forEach(function (c) {
      if (!c || typeof c !== "object" || typeof c.comment !== "string") return;
      var sev = ["blocker", "question", "suggestion", "nit"].indexOf(c.severity) !== -1
        ? c.severity : "suggestion";
      out.comments.push({
        line: (typeof c.line === "number" && c.line > 0) ? Math.floor(c.line) : 0,
        severity: sev,
        comment: c.comment.slice(0, 1000),
      });
    });
    (Array.isArray(r.replies) ? r.replies : []).slice(0, 10).forEach(function (p) {
      if (!p || typeof p !== "object" || typeof p.reply !== "string") return;
      out.replies.push({
        reply_to_id: (typeof p.reply_to_id === "number") ? p.reply_to_id : null,
        reply: p.reply.slice(0, 1000),
      });
    });
    return out;
  }

  function hydrateReviews(revs, hunks) {
    if (!revs || typeof revs !== "object") return;
    Object.keys(revs).forEach(function (hid) {
      if (!/^H\d+n?$/.test(hid)) return;
      var r = revs[hid];
      if (!r || typeof r !== "object") return;
      var local = reviewCache[hid];
      if (r.status === "done" && (!local || local.status !== "done")) {
        reviewCache[hid] = slimReview(r);
      } else if (r.status === "running" && !local) {
        reviewCache[hid] = { status: "running" };
        var h = hunks.filter(function (x) { return x.id === hid; })[0];
        if (h) setTimeout(function () { pollReview(h); }, 1500);
      }
    });
  }

  function startReview(h) {
    if (!h.id) return;
    var cur = reviewCache[h.id];
    if (cur && (cur.status === "running" || cur.status === "done")) return;
    reviewCache[h.id] = { status: "running" };
    paintReview(h);
    request("POST", BASE + "/review",
      { "Content-Type": "application/json", "X-PR-Triage": "1" },
      JSON.stringify({ pr: prPath(), id: h.id }),
      function (status) {
        if (status === 200 || status === 202) pollReview(h);
        else {
          reviewCache[h.id] = { status: "error", error: "request failed (server terminal?)" };
          paintReview(h);
        }
      });
  }

  function pollReview(h) {
    request("GET", BASE + "/review?pr=" + encodeURIComponent(prPath()) +
      "&id=" + encodeURIComponent(h.id), null, null,
      function (status, text) {
        if (!data || !reviewCache[h.id]) return; // navigated away
        var r = null;
        try { r = JSON.parse(text); } catch (e) {}
        if (status === 200 && r && r.status === "done") {
          reviewCache[h.id] = slimReview(r);
          paintReview(h);
          return;
        }
        if (status === 200 && r && r.status === "error") {
          reviewCache[h.id] = { status: "error", error: String(r.error || "review failed").slice(0, 200) };
          paintReview(h);
          return;
        }
        setTimeout(function () { pollReview(h); }, 2500);
      });
  }

  function sevChip(sev, t) {
    var color = sev === "blocker" ? t.blocker : sev === "question" ? t.question :
      sev === "nit" ? t.muted : t.suggestion;
    return el("span", "font-size:11px;font-weight:600;border:1px solid " + color + ";" +
      "border-radius:2em;padding:0 7px;color:" + color + ";white-space:nowrap;", sev);
  }

  function smallBtn(label, t, onClick) {
    var b = el("button", "border:1px solid " + t.border + ";border-radius:6px;background:" +
      t.subtle + ";color:" + t.fg + ";padding:3px 10px;font:600 12px " + GH_FONT + ";cursor:pointer;",
      label);
    b.addEventListener("click", function (e) { e.stopPropagation(); onClick(b); });
    return b;
  }

  // two-click destructive button: first click arms it, second confirms
  function dangerBtn(label, t, onConfirm) {
    var armed = false, timer = null;
    var b = smallBtn(label, t, function () {
      if (!armed) {
        armed = true;
        b.textContent = "Confirm?";
        b.style.color = t.blocker;
        b.style.borderColor = t.blocker;
        timer = setTimeout(function () {
          armed = false;
          b.textContent = label;
          b.style.color = t.fg;
          b.style.borderColor = t.border;
        }, 3000);
        return;
      }
      clearTimeout(timer);
      onConfirm(b);
    });
    return b;
  }

  function deleteComment(cid, cb) {
    request("POST", BASE + "/delete_comment",
      { "Content-Type": "application/json", "X-PR-Triage": "1" },
      JSON.stringify({ pr: prPath(), comment_id: cid }),
      function (status, body) {
        var r = null;
        try { r = JSON.parse(body); } catch (e) {}
        if (status === 200 && r && r.ok) cb(true, "");
        else cb(false, (r && r.error) || ("failed (status " + status + ")"));
      }, 60000);
  }

  function dismissSuggestion(h, kind, idx, cb) {
    request("POST", BASE + "/dismiss_suggestion",
      { "Content-Type": "application/json", "X-PR-Triage": "1" },
      JSON.stringify({ pr: prPath(), id: h.id, kind: kind, index: idx }),
      function (status, body) {
        var r = null;
        try { r = JSON.parse(body); } catch (e) {}
        cb(status === 200 && r && r.ok);
      }, 30000);
  }

  function removeCommentFromThreads(cid) {
    threads = threads.filter(function (th) { return th.root.id !== cid; });
    threads.forEach(function (th) {
      th.replies = th.replies.filter(function (c) { return c.id !== cid; });
    });
  }

  // editable draft with Copy and (when postable) Post-to-GitHub
  function editorWidget(t, initial, onPost) {
    var box = el("div", "border:1px solid " + t.border + ";border-radius:6px;overflow:hidden;" +
      "background:" + t.canvas + ";margin-top:6px;");
    var ta = document.createElement("textarea");
    ta.value = initial;
    // size to the draft: roomy floor, grows with content, still user-resizable
    ta.rows = Math.min(12, Math.max(5,
      Math.ceil(initial.length / 80) + initial.split("\n").length));
    ta.style.cssText = "display:block;width:100%;box-sizing:border-box;border:0;background:transparent;" +
      "color:" + t.fg + ";font:14px/1.6 " + GH_FONT + ";padding:10px 12px;resize:vertical;" +
      "min-height:110px;outline:none;";
    ["click", "dblclick"].forEach(function (ev) {
      ta.addEventListener(ev, function (e) { e.stopPropagation(); });
    });
    box.appendChild(ta);
    var row = el("div", "display:flex;gap:8px;align-items:center;padding:6px 10px;" +
      "border-top:1px solid " + t.border + ";background:" + t.subtle + ";");
    var status = el("span", "font-size:12px;color:" + t.muted + ";flex:1;", "");
    row.appendChild(status);
    row.appendChild(smallBtn("Reword", t, function (btn) {
      var text = ta.value.trim();
      if (!text || ta.disabled || btn.disabled) return;
      btn.disabled = true;
      btn.textContent = "rewording…";
      request("POST", BASE + "/reword",
        { "Content-Type": "application/json", "X-PR-Triage": "1" },
        JSON.stringify({ pr: prPath(), text: text }),
        function (st, respBody) {
          btn.disabled = false;
          btn.textContent = "Reword";
          var r = null;
          try { r = JSON.parse(respBody); } catch (e) {}
          if (st === 200 && r && typeof r.reword === "string" && r.reword.trim()) {
            ta.value = r.reword.trim();
          } else {
            status.textContent = "⚠ reword failed" +
              ((r && r.error) ? ": " + r.error.slice(0, 80) : "");
          }
        }, 120000);
    }));
    row.appendChild(smallBtn("Copy", t, function (btn) {
      try { navigator.clipboard.writeText(ta.value); btn.textContent = "Copied ✓"; }
      catch (e) { btn.textContent = "copy failed"; }
      setTimeout(function () { btn.textContent = "Copy"; }, 1400);
    }));
    if (onPost) {
      row.appendChild(smallBtn("Post to GitHub", t, function (btn) {
        var text = ta.value.trim();
        if (!text) return;
        btn.disabled = true;
        btn.style.opacity = ".6";
        status.textContent = "posting…";
        onPost(text, function (ok, info) {
          if (ok) {
            ta.disabled = true;
            btn.textContent = "Posted ✓";
            status.textContent = "";
            if (info.url) {
              var a = document.createElement("a");
              a.href = info.url;
              a.target = "_blank";
              a.rel = "noopener";
              a.textContent = "view on GitHub ↗";
              a.style.cssText = "color:" + t.accent + ";font-size:12px;";
              status.appendChild(a);
            }
            if (info.id) {
              // the posted comment can be deleted right from here
              row.appendChild(dangerBtn("Delete", t, function (db) {
                db.disabled = true;
                status.textContent = "deleting…";
                deleteComment(info.id, function (dok, derr) {
                  if (dok) {
                    while (box.firstChild) box.removeChild(box.firstChild);
                    box.appendChild(el("div",
                      "padding:8px 12px;font-size:12px;color:" + t.muted + ";",
                      "comment deleted ✓"));
                  } else {
                    db.disabled = false;
                    status.textContent = "⚠ " + derr;
                  }
                });
              }));
            }
          } else {
            btn.disabled = false;
            btn.style.opacity = "";
            status.textContent = "⚠ " + info;
          }
        });
      }));
    }
    box.appendChild(row);
    return box;
  }

  function postComment(h, line, text, cb) {
    request("POST", BASE + "/post_comment",
      { "Content-Type": "application/json", "X-PR-Triage": "1" },
      JSON.stringify({ pr: prPath(), id: h.id, line: line, body: text }),
      function (status, body) {
        var r = null;
        try { r = JSON.parse(body); } catch (e) {}
        if (status === 200 && r && r.ok) cb(true, { url: r.url || "", id: r.comment_id });
        else cb(false, (r && r.error) || ("failed (status " + status + ")"));
      }, 60000);
  }

  function postReply(rid, text, cb) {
    request("POST", BASE + "/post_reply",
      { "Content-Type": "application/json", "X-PR-Triage": "1" },
      JSON.stringify({ pr: prPath(), reply_to_id: rid, body: text }),
      function (status, body) {
        var r = null;
        try { r = JSON.parse(body); } catch (e) {}
        if (status === 200 && r && r.ok) cb(true, { url: r.url || "", id: r.comment_id });
        else cb(false, (r && r.error) || ("failed (status " + status + ")"));
      }, 60000);
  }

  function suggestionWidget(h, c, t, card, idx) {
    var w = el("div", "font-family:" + GH_FONT + ";");
    var head = el("div", "display:flex;gap:10px;align-items:baseline;");
    head.appendChild(sevChip(c.severity, t));
    if (c.line) {
      head.appendChild(linkish("line " + c.line, t, function () {
        if (card) flashLine(card, c.line, t);
      }));
    }
    head.appendChild(el("span", "font-size:11px;color:" + t.muted + ";",
      "suggested by claude — edit before posting"));
    head.appendChild(el("span", "flex:1;"));
    head.appendChild(linkish("Dismiss ✕", t, function () {
      dismissSuggestion(h, "comment", idx, function (ok) {
        if (ok && reviewCache[h.id] && reviewCache[h.id].comments) {
          reviewCache[h.id].comments.splice(idx, 1);
        }
        paintReview(h);
      });
    }));
    w.appendChild(head);
    w.appendChild(editorWidget(t, c.comment,
      c.line ? function (text, cb) { postComment(h, c.line, text, cb); } : null));
    return w;
  }

  function paintReview(h) {
    var box = reviewBoxes[h.id];
    if (!box || !box.isConnected) return;
    var t = theme();
    var card = box.closest("[data-card]");
    if (card) {
      card.querySelectorAll("tr[data-triage-inline]").forEach(function (r) { r.remove(); });
    }
    while (box.firstChild) box.removeChild(box.firstChild);
    var r = reviewCache[h.id];
    if (!r) return;
    box.style.borderTop = "1px solid " + t.border;
    if (r.status === "running") {
      box.appendChild(el("div", "padding:10px 16px;color:" + t.muted + ";font-size:13px;",
        "✦ reviewing this diff with claude…"));
      return;
    }
    if (r.status === "error") {
      var eRow = el("div", "padding:10px 16px;font-size:13px;color:" + t.blocker + ";",
        "✦ deep review failed: " + (r.error || "") + "  ");
      eRow.appendChild(linkish("retry", t, function () { delete reviewCache[h.id]; startReview(h); }));
      box.appendChild(eRow);
      return;
    }
    var pad = "padding:8px 16px;";
    if (!r.comments.length && !r.replies.length) {
      box.appendChild(el("div", pad + "font-size:13px;color:" + t.suggestion + ";",
        "✦ Nothing worth raising on this diff."));
      return;
    }
    var placed = 0;
    var overflow = [];
    r.comments.forEach(function (c, idx) {
      var w = suggestionWidget(h, c, t, card, idx);
      var tr = (card && c.line) ? card.querySelector('tr[data-nl="' + c.line + '"]') : null;
      if (tr) {
        // GitHub-style inline comment row right under the code line
        var row = document.createElement("tr");
        row.dataset.triageInline = "1";
        var td = document.createElement("td");
        td.colSpan = 3;
        td.style.cssText = "padding:8px 14px;background:" + t.subtle + ";white-space:normal;" +
          "border-top:1px solid " + t.border + ";border-bottom:1px solid " + t.border + ";";
        td.appendChild(w);
        row.appendChild(td);
        tr.after(row);
        placed++;
      } else {
        overflow.push(w);
      }
    });
    if (r.comments.length) {
      box.appendChild(el("div", pad + "font-weight:600;font-size:13px;",
        "✦ " + r.comments.length + " suggested comment(s)" +
        (placed ? " — shown inline at their lines" : "")));
    }
    overflow.forEach(function (w) {
      var holder = el("div", "padding:4px 16px 8px;");
      holder.appendChild(w);
      box.appendChild(holder);
    });
    if (r.replies.length) {
      box.appendChild(el("div", pad + "font-weight:600;font-size:13px;",
        "✦ Suggested replies (" + r.replies.length + ")"));
      r.replies.forEach(function (rep, ridx) {
        var th = threads.filter(function (x) { return x.root.id === rep.reply_to_id; })[0];
        var row = el("div", "padding:4px 16px 10px;font-size:13px;");
        var rhead = el("div", "display:flex;gap:10px;align-items:baseline;");
        if (th) {
          rhead.appendChild(el("div", "color:" + t.muted + ";border-left:3px solid " + t.border + ";" +
            "padding-left:8px;flex:1;min-width:0;",
            th.root.user + ": " + th.root.body.slice(0, 140) + (th.root.body.length > 140 ? "…" : "")));
        } else {
          rhead.appendChild(el("span", "flex:1;"));
        }
        rhead.appendChild(linkish("Dismiss ✕", t, function () {
          dismissSuggestion(h, "reply", ridx, function (ok) {
            if (ok && reviewCache[h.id] && reviewCache[h.id].replies) {
              reviewCache[h.id].replies.splice(ridx, 1);
            }
            paintReview(h);
          });
        }));
        row.appendChild(rhead);
        row.appendChild(editorWidget(t, rep.reply,
          rep.reply_to_id ? function (text, cb) { postReply(rep.reply_to_id, text, cb); } : null));
        box.appendChild(row);
      });
    }
  }

  // -------------------------------------------------------------------- chat

  function chatKeyFor(ctxHunk) { return ctxHunk ? "h:" + ctxHunk.id : "pr"; }

  function paintChat(key, t) {
    var msgs = document.getElementById("pr-triage-chat-msgs");
    if (!msgs) return;
    while (msgs.firstChild) msgs.removeChild(msgs.firstChild);
    var st = chatState[key];
    if (!st) return;
    if (!st.messages.length && !st.pending) {
      msgs.appendChild(el("div", "color:" + t.muted + ";font-size:12px;",
        "answers use the triage context; chatting never posts anything to GitHub"));
    }
    st.messages.forEach(function (m) {
      var mine = m.role === "user";
      msgs.appendChild(el("div",
        "max-width:92%;padding:6px 10px;border-radius:10px;font-size:13px;" +
        "white-space:pre-wrap;word-break:break-word;" +
        (mine ? "align-self:flex-end;background:" + t.accent + ";color:#fff;"
              : "align-self:flex-start;background:" + t.subtle + ";color:" + t.fg +
                ";border:1px solid " + t.border + ";"), m.text));
    });
    if (st.pending) {
      msgs.appendChild(el("div", "align-self:flex-start;color:" + t.muted + ";font-size:12px;",
        "thinking…"));
    }
    msgs.scrollTop = msgs.scrollHeight;
  }

  function sendChat(key, ctxHunk, ta) {
    var st = chatState[key];
    var text = ta.value.trim();
    if (!text || st.pending) return;
    ta.value = "";
    st.messages.push({ role: "user", text: text });
    st.pending = true;
    paintChat(key, theme());
    request("POST", BASE + "/chat",
      { "Content-Type": "application/json", "X-PR-Triage": "1" },
      JSON.stringify({ pr: prPath(), id: ctxHunk ? ctxHunk.id : undefined,
                       messages: st.messages.slice(-20) }),
      function (status, body) {
        st.pending = false;
        var r = null;
        try { r = JSON.parse(body); } catch (e) {}
        if (status === 200 && r && typeof r.reply === "string") {
          st.messages.push({ role: "assistant", text: r.reply.slice(0, 8000) });
        } else {
          st.messages.push({ role: "assistant",
            text: "⚠ " + ((r && r.error) || ("chat failed (status " + status + ")")) });
        }
        paintChat(key, theme());
      }, 300000);
  }

  function chatColumn(t, ctxHunk) {
    var key = chatKeyFor(ctxHunk);
    if (!chatState[key]) chatState[key] = { messages: [], pending: false };
    var col = el("div", "width:320px;flex:none;position:sticky;top:0;display:flex;" +
      "flex-direction:column;max-height:calc(100vh - 170px);min-height:220px;" +
      "border:1px solid " + t.border + ";border-radius:6px;overflow:hidden;background:" + t.canvas + ";");
    col.appendChild(el("div", "padding:8px 12px;font-weight:600;font-size:12px;background:" +
      t.subtle + ";border-bottom:1px solid " + t.border + ";",
      ctxHunk ? "💬 Ask about this diff" : "💬 Ask about this PR"));
    var msgs = el("div", "flex:1;overflow-y:auto;padding:10px 12px;display:flex;" +
      "flex-direction:column;gap:8px;min-height:120px;");
    msgs.id = "pr-triage-chat-msgs";
    col.appendChild(msgs);
    var inputWrap = el("div", "border-top:1px solid " + t.border + ";padding:8px;" +
      "display:flex;gap:6px;align-items:flex-end;");
    var ta = document.createElement("textarea");
    ta.placeholder = ctxHunk ? "e.g. is removing this safe?" : "e.g. what's the riskiest part of this PR?";
    ta.rows = 1;
    ta.style.cssText = "flex:1;resize:none;border:1px solid " + t.border + ";border-radius:6px;" +
      "background:" + t.canvas + ";color:" + t.fg + ";font:13px/1.4 " + GH_FONT + ";" +
      "padding:6px 8px;min-height:34px;max-height:120px;outline:none;";
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChat(key, ctxHunk, ta);
      }
    });
    var send = el("button", "border:0;border-radius:6px;background:" + t.accent + ";color:#fff;" +
      "padding:8px 12px;font:600 12px " + GH_FONT + ";cursor:pointer;", "Send");
    send.addEventListener("click", function () { sendChat(key, ctxHunk, ta); });
    inputWrap.appendChild(ta);
    inputWrap.appendChild(send);
    col.appendChild(inputWrap);
    return col;
  }

  function floatingChat(t, ctxHunk) {
    var pill = el("button", "position:fixed;right:16px;bottom:16px;z-index:9999;" +
      "border:1px solid " + t.border + ";border-radius:2em;background:" + t.subtle + ";" +
      "color:" + t.fg + ";padding:8px 14px;font:600 13px " + GH_FONT + ";cursor:pointer;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.18);", "💬 Chat");
    var holder = null;
    pill.addEventListener("click", function () {
      if (holder) { holder.remove(); holder = null; return; }
      holder = chatColumn(t, ctxHunk);
      holder.style.position = "fixed";
      holder.style.right = "16px";
      holder.style.bottom = "64px";
      holder.style.width = "340px";
      holder.style.height = "55vh";
      holder.style.zIndex = "9999";
      viewEl.appendChild(holder);
      paintChat(chatKeyFor(ctxHunk), t);
    });
    viewEl.appendChild(pill);
  }

  // ---------------------------------------------------------------- the tab

  function tabCountText() {
    if (serverState === "ready" && data) {
      return String(data.hunks.filter(function (h) { return !h.heuristic; }).length);
    }
    if (serverState === "queued" || serverState === "running") return "…";
    if (serverState === "error") return "!";
    return "+";
  }

  function ensureTab() {
    var p = prPath();
    if (serverState === "offline") {
      var stale = document.getElementById("pr-triage-tab");
      if (stale) stale.remove();
      return;
    }
    var tab = document.getElementById("pr-triage-tab");
    if (tab && tab.dataset.pr !== p) { tab.remove(); tab = null; }
    if (!tab) {
      var commits = document.querySelector('a[href$="' + p + '/commits"]');
      if (!commits || !commits.parentElement) return;
      tab = commits.cloneNode(false);
      tab.id = "pr-triage-tab";
      tab.dataset.pr = p;
      tab.removeAttribute("href");
      tab.removeAttribute("aria-current");
      tab.classList.remove("selected");
      tab.style.cursor = "pointer";
      tab.appendChild(document.createTextNode("Triage"));
      var cnt = document.createElement("span");
      cnt.id = "pr-triage-tab-count";
      var counter = commits.querySelector('[class*="ounter"]');
      if (counter) cnt.className = counter.className;
      else cnt.style.cssText = "margin-left:6px;color:#8b949e;";
      tab.appendChild(cnt);
      tab.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleView();
      });
      commits.parentElement.appendChild(tab);
      if (!commits.parentElement.dataset.prTriageHook) {
        commits.parentElement.dataset.prTriageHook = "1";
        commits.parentElement.addEventListener("click", function (ev) {
          var a = ev.target && ev.target.closest && ev.target.closest("a");
          if (a && a.id !== "pr-triage-tab") closeView();
        }, true);
      }
    }
    var cntEl = document.getElementById("pr-triage-tab-count");
    if (cntEl) cntEl.textContent = tabCountText();
    styleTabSelected(!!viewEl);
  }

  function styleTabSelected(on) {
    var tab = document.getElementById("pr-triage-tab");
    if (!tab) return;
    tab.style.boxShadow = on ? "inset 0 -2px 0 #fd8c73" : "";
    tab.style.fontWeight = on ? "600" : "";
  }

  // --------------------------------------------------------------- the view

  var savedOverflow = null;
  function lockScroll() {
    if (savedOverflow !== null) return;
    savedOverflow = [document.documentElement.style.overflow, document.body.style.overflow];
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
  }
  function unlockScroll() {
    if (savedOverflow === null) return;
    document.documentElement.style.overflow = savedOverflow[0];
    document.body.style.overflow = savedOverflow[1];
    savedOverflow = null;
  }

  function closeView() {
    if (viewEl) { viewEl.remove(); viewEl = null; detailIdx = null; lastRendered = ""; }
    reviewBoxes = {};
    unlockScroll();
    styleTabSelected(false);
  }

  function openView() {
    if (viewEl) return;
    var t = theme();
    var tab = document.getElementById("pr-triage-tab");
    var top = tab ? Math.max(0, Math.round(tab.getBoundingClientRect().bottom) + 1) : 100;
    viewEl = document.createElement("div");
    viewEl.id = "pr-triage-view";
    viewEl.style.cssText =
      "position:fixed;left:0;right:0;bottom:0;top:" + top + "px;z-index:9998;" +
      "overflow-y:auto;overscroll-behavior:contain;padding:20px 32px 64px;" +
      "font:14px/1.5 " + GH_FONT + ";" +
      "background:" + t.canvas + ";color:" + t.fg + ";";
    document.body.appendChild(viewEl);
    lockScroll();
    renderViewContent();
    styleTabSelected(true);
  }

  function toggleView() {
    if (viewEl) { closeView(); return; }
    openView();
  }

  function openViewAt(anchor) {
    detailIdx = null;
    openView();
    renderViewContent();
    var card = viewEl && viewEl.querySelector('[data-anchor="' + anchor + '"]');
    if (card) {
      card.scrollIntoView({ block: "start" });
      card.style.boxShadow = "0 0 0 2px " + theme().accent;
      setTimeout(function () { if (card.isConnected) card.style.boxShadow = ""; }, 1800);
    }
  }

  function jumpToDiff(h) {
    var s = h.importance === null ? -1 : h.importance;
    var target = document.getElementById(h.anchor);
    if (onDiffTab() && target) {
      closeView();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      target.style.outline = "2px solid " + scoreColor(s);
      setTimeout(function () { target.style.outline = ""; }, 2500);
    } else {
      closeView();
      location.assign(prPath() + "/files#" + h.anchor);
    }
  }

  // ------------------------------------------------------------ view pieces

  function linkish(text, t, onClick) {
    var a = el("span", "font-size:12px;color:" + t.accent + ";cursor:pointer;white-space:nowrap;", text);
    a.addEventListener("click", function (e) { e.stopPropagation(); onClick(e); });
    a.addEventListener("mouseenter", function () { a.style.textDecoration = "underline"; });
    a.addEventListener("mouseleave", function () { a.style.textDecoration = ""; });
    return a;
  }

  // renders text with `inline code` styled GitHub-style (textContent only — safe)
  function richText(parent, text, t) {
    var parts = String(text).split("`");
    parts.forEach(function (seg, i) {
      if (!seg && i !== 0) return;
      if (i % 2 === 1 && i !== parts.length - 1) {
        parent.appendChild(el("code",
          "font-family:" + GH_MONO + ";font-size:.92em;padding:1.5px 5px;border-radius:4px;" +
          "background:" + (isDark() ? "rgba(110,118,129,.28)" : "rgba(175,184,193,.22)") + ";",
          seg));
      } else if (seg) {
        parent.appendChild(document.createTextNode((i % 2 === 1 ? "`" : "") + seg));
      }
    });
  }

  function sectionHeading(text, t) {
    return el("div",
      "font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;" +
      "color:" + t.muted + ";margin-bottom:5px;", text);
  }

  function bulletText(text, t, size) {
    var body = el("div", "font-size:" + (size || 14) + "px;line-height:1.6;color:" + t.fg + ";min-width:0;");
    var vals = String(text).split("\n").filter(function (x) { return x.trim(); });
    vals.forEach(function (x) {
      var line = el("div",
        vals.length > 1 ? "padding-left:16px;text-indent:-16px;margin-top:2px;" : "");
      if (vals.length > 1) line.appendChild(document.createTextNode("•  "));
      richText(line, x.trim(), t);
      body.appendChild(line);
    });
    return body;
  }

  function notesBlock(h, t) {
    var wrap = el("div", "padding:18px 20px 20px;display:flex;flex-direction:column;gap:17px;");
    // uniform grid: What | Why on top, Tests | Blast beneath — equal weight, real air
    var cells = [];
    if (h.what) cells.push({ label: "What changed", text: h.what });
    if (h.why) cells.push({ label: "Why", text: h.why });
    if (h.tests) cells.push({ label: "Tests", text: h.tests, dot: signalDot("tests", h.tests) });
    if (h.blast) cells.push({ label: "Blast radius", text: h.blast, dot: signalDot("blast", h.blast) });
    if (cells.length) {
      var twoCol = cells.length > 1 && window.innerWidth >= 980;
      var grid = el("div", "display:grid;grid-template-columns:" +
        (twoCol ? "1fr 1fr" : "1fr") + ";gap:18px 48px;");
      cells.forEach(function (c) {
        var cell = el("div", "min-width:0;");
        var headEl = el("div", "display:flex;gap:7px;align-items:baseline;margin-bottom:5px;");
        if (c.dot) headEl.appendChild(el("span", "font-size:9px;color:" + c.dot + ";", "●"));
        headEl.appendChild(el("div",
          "font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;" +
          "color:" + t.muted + ";", c.label));
        cell.appendChild(headEl);
        cell.appendChild(bulletText(c.text, t));
        grid.appendChild(cell);
      });
      wrap.appendChild(grid);
    }
    if (h.verdict) {
      var s = h.importance === null ? -1 : h.importance;
      var st = scoreStyle(s);
      var call = el("div",
        "padding:10px 16px;border-left:3px solid " + st.fg + ";" +
        "background:" + st.bg + ";border-radius:0 8px 8px 0;");
      call.appendChild(el("div",
        "font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;" +
        "color:" + st.fg + ";margin-bottom:3px;", "Impression"));
      call.appendChild(bulletText(h.verdict, t));
      wrap.appendChild(call);
    }
    if (!(h.what || h.why || h.verdict) && h.reason) {
      var cell2 = el("div", "");
      cell2.appendChild(sectionHeading("Note", t));
      cell2.appendChild(bulletText(h.reason, t));
      wrap.appendChild(cell2);
    }
    return wrap;
  }

  function lineRange(h) {
    var m = String(h.lines).match(/^(\d+)(?:-(\d+))?$/);
    return m ? [+m[1], +(m[2] || m[1])] : null;
  }

  function threadsFor(h) {
    var r = lineRange(h);
    var on = [], elsewhere = [];
    threads.forEach(function (th) {
      if (th.root.path !== h.file) return;
      if (r && th.root.line !== null && th.root.line >= r[0] && th.root.line <= r[1]) on.push(th);
      else elsewhere.push(th);
    });
    return { on: on, elsewhere: elsewhere };
  }

  function pill(text, t, strong) {
    return el("span",
      "font-size:12px;line-height:18px;border:1px solid " + t.border + ";border-radius:2em;" +
      "padding:0 8px;color:" + (strong ? t.fg : t.muted) + ";white-space:nowrap;", text);
  }

  function cardHeader(h, t, cmts, inDetail) {
    var s = h.importance === null ? -1 : h.importance;
    var head = el("div",
      "display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:11px 20px;" +
      "background:" + t.subtle + ";" + (inDetail ? "" : "cursor:pointer;"));
    head.appendChild(scorePill(s));
    head.appendChild(filePathEl(h.file, h.lines, t));
    if (h.category) head.appendChild(pill(h.category, t));
    if (cmts && (cmts.on.length + cmts.elsewhere.length) > 0) {
      head.appendChild(pill("💬 " + (cmts.on.length ? cmts.on.length + " on these lines" :
        cmts.elsewhere.length + " in file"), t, cmts.on.length > 0));
    }
    head.appendChild(el("span", "flex:1;"));
    if (h.id) {
      var rState = reviewCache[h.id] && reviewCache[h.id].status;
      var label = rState === "running" ? "✦ reviewing…"
        : rState === "done" ? "✦ Reviewed" : "✦ Review this diff";
      var reviewBtn = el("span",
        "font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;border-radius:6px;" +
        "padding:3px 10px;border:1px solid " +
        (rState === "done" ? t.border + ";color:" + t.muted
                           : t.accent + "55;color:" + t.accent) + ";");
      reviewBtn.textContent = label;
      reviewBtn.addEventListener("mouseenter", function () { reviewBtn.style.background = t.subtle === "#f6f8fa" ? "#eef1f4" : "#1c2128"; });
      reviewBtn.addEventListener("mouseleave", function () { reviewBtn.style.background = ""; });
      head.appendChild(reviewBtn);
      reviewBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        (function () {
        if (!inDetail) {
          // reviewing always happens in the focus view, with results inline
          openDetail(h);
          startReview(h);
          return;
        }
        startReview(h);
        var box = reviewBoxes[h.id];
        if (box && box.isConnected) box.scrollIntoView({ block: "nearest", behavior: "smooth" });
        })();
      });
    }
    if (!inDetail) {
      head.appendChild(linkish("Focus ⤢", t, function () { openDetail(h); }));
    }
    var gh = linkish("↗", t, function () { jumpToDiff(h); });
    gh.title = "Open in the Files tab";
    gh.style.fontSize = "14px";
    head.appendChild(gh);
    return head;
  }

  function applyCollapseTo(card, h) {
    var hide = !!collapsed[h.anchor + ":" + h.lines];
    [].slice.call(card.children, 1).forEach(function (b) {
      b.style.display = hide ? "none" : "";
    });
  }

  function scoredHunks() {
    return data.hunks.filter(function (h) { return !h.heuristic; });
  }

  function openDetail(h) {
    detailIdx = scoredHunks().indexOf(h);
    if (!viewEl) openView();
    renderViewContent();
    viewEl.scrollTop = 0;
  }

  function buildCard(h, t, inDetail) {
    var cmts = threadsFor(h);
    var card = el("div", "border:1px solid " + t.border + ";border-radius:8px;overflow:hidden;" +
      "margin:16px 0;" + (isDark() ? "" : "box-shadow:0 1px 3px rgba(31,35,40,.05);"));
    card.dataset.anchor = h.anchor;
    card.dataset.card = "1";
    var header = cardHeader(h, t, cmts, inDetail);
    card.appendChild(header);
    card.appendChild(notesBlock(h, t));
    if (h.diff) card.appendChild(renderDiffTable(h, t, inDetail ? 0 : 80));
    var box = el("div", "");
    card.appendChild(box);
    if (h.id) {
      reviewBoxes[h.id] = box;
      // paint after the card lands in the DOM (isConnected guards stale boxes)
      if (reviewCache[h.id]) setTimeout(function () { paintReview(h); }, 0);
    }
    if (!inDetail) {
      applyCollapseTo(card, h);
      header.addEventListener("click", function () {
        collapsed[h.anchor + ":" + h.lines] = !collapsed[h.anchor + ":" + h.lines];
        applyCollapseTo(card, h);
      });
      card.addEventListener("dblclick", function (e) {
        e.preventDefault();
        openDetail(h);
      });
    }
    return card;
  }

  function renderThread(th, t) {
    var box = el("div", "border:1px solid " + t.border + ";border-radius:6px;margin:8px 0;overflow:hidden;");
    [th.root].concat(th.replies).forEach(function (c, i) {
      var item = el("div", (i ? "border-top:1px solid " + t.border + ";" : "") + "padding:8px 12px;");
      var head = el("div", "display:flex;gap:8px;align-items:baseline;margin-bottom:4px;");
      head.appendChild(el("span", "font-weight:600;font-size:13px;", c.user || "unknown"));
      if (c.line !== null && i === 0) head.appendChild(el("span", "font-size:12px;color:" + t.muted + ";", "line " + c.line));
      head.appendChild(el("span", "font-size:12px;color:" + t.muted + ";", (c.created_at || "").slice(0, 10)));
      if (c.id) {
        head.appendChild(el("span", "flex:1;"));
        var delLink = linkish("delete", t, function () {
          if (delLink.dataset.armed !== "1") {
            delLink.dataset.armed = "1";
            delLink.textContent = "confirm delete?";
            delLink.style.color = t.blocker;
            setTimeout(function () {
              delLink.dataset.armed = "";
              delLink.textContent = "delete";
              delLink.style.color = t.muted;
            }, 3000);
            return;
          }
          delLink.textContent = "deleting…";
          deleteComment(c.id, function (ok, err) {
            if (ok) { removeCommentFromThreads(c.id); renderViewContent(); }
            else { delLink.textContent = "⚠ " + err.slice(0, 60); }
          });
        });
        delLink.style.color = t.muted;
        head.appendChild(delLink);
      }
      item.appendChild(head);
      item.appendChild(el("div", "font-size:13px;white-space:pre-wrap;word-break:break-word;color:" + t.fg + ";", c.body));
      box.appendChild(item);
    });
    return box;
  }

  function renderDetail(wrap, t) {
    var scored = scoredHunks();
    var h = scored[detailIdx];
    if (!h) { detailIdx = null; renderViewContent(); return; }

    var outer = el("div", "display:flex;gap:20px;align-items:flex-start;");
    wrap.appendChild(outer);
    var mainCol = el("div", "flex:1;min-width:0;");
    outer.appendChild(mainCol);
    wrap = mainCol; // existing content flows into the main column

    var bar = el("div", "display:flex;gap:14px;align-items:center;margin-bottom:14px;flex-wrap:wrap;");
    bar.appendChild(linkish("← All changes", t, function () { detailIdx = null; renderViewContent(); }));
    bar.appendChild(el("span", "color:" + t.muted + ";font-size:12px;",
      "detailed review " + (detailIdx + 1) + " of " + scored.length + " · Esc to go back"));
    bar.appendChild(el("span", "flex:1;"));
    if (detailIdx > 0) bar.appendChild(smallBtn("← prev", t, function () { detailIdx--; renderViewContent(); viewEl.scrollTop = 0; }));
    if (detailIdx < scored.length - 1) bar.appendChild(smallBtn("next →", t, function () { detailIdx++; renderViewContent(); viewEl.scrollTop = 0; }));
    wrap.appendChild(bar);

    wrap.appendChild(buildCard(h, t, true));

    var cmts = threadsFor(h);
    var sec = el("div", "margin-top:22px;");
    sec.appendChild(el("div", "font-weight:600;margin-bottom:4px;",
      "Comments on these lines (" + cmts.on.length + ")"));
    if (cmts.on.length) cmts.on.forEach(function (th) { sec.appendChild(renderThread(th, t)); });
    else sec.appendChild(el("div", "color:" + t.muted + ";font-size:13px;", "no review threads on these lines yet"));
    if (cmts.elsewhere.length) {
      sec.appendChild(el("div", "font-weight:600;margin:18px 0 4px;",
        "Other threads in this file (" + cmts.elsewhere.length + ")"));
      cmts.elsewhere.forEach(function (th) { sec.appendChild(renderThread(th, t)); });
    }
    var hint = el("div", "margin-top:18px;color:" + t.muted + ";font-size:12px;");
    hint.appendChild(document.createTextNode("you can also open this diff in the "));
    hint.appendChild(linkish("Files tab ↗", t, function () { jumpToDiff(h); }));
    sec.appendChild(hint);
    wrap.appendChild(sec);

    var outerEl = wrap.parentElement;
    if (window.innerWidth >= 1100) {
      var col = chatColumn(t, h);
      outerEl.appendChild(col);
      paintChat(chatKeyFor(h), t);
    } else {
      floatingChat(t, h);
    }
  }

  function renderList(wrap, t) {
    var scored = scoredHunks();
    var noise = data.hunks.length - scored.length;
    var visible = scored.filter(function (h) {
      var s = h.importance === null ? -1 : h.importance;
      return listFilter === "all" || s >= +listFilter;
    });
    var outer = el("div", "display:flex;gap:20px;align-items:flex-start;");
    wrap.appendChild(outer);

    var main = el("div", "flex:1;min-width:0;");
    var sideRows = [];
    var activeIdx = 0;

    if (window.innerWidth >= 1000 && scored.length > 2) {
      var side = el("div", "width:256px;flex:none;position:sticky;top:0;" +
        "max-height:calc(100vh - 160px);overflow-y:auto;border:1px solid " + t.border + ";" +
        "border-radius:8px;background:" + t.canvas + ";padding-bottom:6px;" +
        (isDark() ? "" : "box-shadow:0 1px 3px rgba(31,35,40,.05);"));
      side.appendChild(el("div",
        "padding:12px 14px 8px;font-size:10.5px;font-weight:700;letter-spacing:.06em;" +
        "text-transform:uppercase;color:" + t.muted + ";",
        "Changes by priority · " + visible.length));

      function paintActive() {
        sideRows.forEach(function (r, j) {
          r.style.borderLeftColor = j === activeIdx ? t.accent : "transparent";
          r.style.background = j === activeIdx ? t.subtle : "";
        });
      }

      visible.forEach(function (h, i) {
        var s = h.importance === null ? -1 : h.importance;
        var row = el("div", "display:flex;gap:10px;align-items:center;padding:7px 12px 7px 9px;" +
          "cursor:pointer;border-left:3px solid transparent;");
        row.title = h.file + ":" + h.lines;
        row.appendChild(scorePill(s, true));
        var txt = el("div", "flex:1;min-width:0;");
        var l1 = el("div", "display:flex;gap:7px;align-items:baseline;min-width:0;");
        l1.appendChild(el("span",
          "font-size:12.5px;font-weight:600;color:" + t.fg + ";white-space:nowrap;" +
          "overflow:hidden;text-overflow:ellipsis;min-width:0;",
          h.file.split(" -> ").pop().split("/").pop()));
        var marks = "";
        if (h.id && reviewCache[h.id] && reviewCache[h.id].status === "done") marks += "✦";
        var cm = threadsFor(h);
        if (cm.on.length + cm.elsewhere.length) marks += (marks ? " " : "") + "💬";
        if (marks) l1.appendChild(el("span", "flex:none;font-size:10px;color:" + t.accent + ";", marks));
        txt.appendChild(l1);
        var dir = h.file.indexOf("/") !== -1
          ? h.file.split(" -> ").pop().slice(0, h.file.split(" -> ").pop().lastIndexOf("/")) : "";
        txt.appendChild(el("div",
          "font-size:11px;color:" + t.muted + ";white-space:nowrap;overflow:hidden;" +
          "text-overflow:ellipsis;font-family:" + GH_MONO + ";margin-top:1px;",
          (dir ? dir + " · " : "") + h.lines));
        row.appendChild(txt);
        row.addEventListener("mouseenter", function () {
          if (i !== activeIdx) row.style.background = t.subtle;
        });
        row.addEventListener("mouseleave", function () {
          if (i !== activeIdx) row.style.background = "";
        });
        row.addEventListener("click", function () {
          var card = main.querySelectorAll("[data-card]")[i];
          if (card) {
            activeIdx = i;
            paintActive();
            card.scrollIntoView({ block: "start", behavior: "smooth" });
            card.style.boxShadow = "0 0 0 2px " + t.accent;
            setTimeout(function () { if (card.isConnected) card.style.boxShadow = ""; }, 1500);
          }
        });
        side.appendChild(row);
        sideRows.push(row);
      });
      outer.appendChild(side);

      // scroll spy: highlight the sidebar row for the card currently in view
      var cardEls = null;
      viewEl.onscroll = function () {
        if (!cardEls || !cardEls.length || !cardEls[0].isConnected) {
          cardEls = [].slice.call(main.querySelectorAll("[data-card]"));
        }
        var top = viewEl.scrollTop + 150;
        var idx = 0;
        for (var k = 0; k < cardEls.length; k++) {
          if (cardEls[k].offsetTop <= top) idx = k; else break;
        }
        if (idx !== activeIdx) {
          activeIdx = idx;
          paintActive();
        }
      };
      paintActive();
    } else {
      viewEl.onscroll = null;
    }

    outer.appendChild(main);

    if (data.tldr || data.impression || data.approvability !== null) {
      var box = el("div",
        "margin-bottom:18px;border:1px solid " + t.border + ";border-radius:8px;" +
        "overflow:hidden;background:" + t.canvas + ";" +
        (isDark() ? "" : "box-shadow:0 1px 3px rgba(31,35,40,.05);"));
      if (data.approvability !== null) {
        var a = data.approvability;
        var ac = a >= 80 ? "#1a7f37" : a >= 55 ? "#bc4c00" : "#d1242f";
        var acFg = isDark() ? (a >= 80 ? "#7ee787" : a >= 55 ? "#ffa657" : "#ff7b72") : ac;
        var acBg = a >= 80 ? "rgba(26,127,55,.10)" : a >= 55 ? "rgba(188,76,0,.10)" : "rgba(209,36,47,.10)";
        var verdictWord = a >= 80 ? "Approvable" : a >= 55 ? "Close" : "Needs work";
        var banner = el("div",
          "display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;padding:11px 20px;" +
          "background:" + acBg + ";border-bottom:1px solid " + t.border + ";");
        banner.appendChild(el("span",
          "flex:none;font-weight:800;font-size:14.5px;font-variant-numeric:tabular-nums;" +
          "white-space:nowrap;color:" + acFg + ";",
          verdictWord + " · " + a + "%"));
        if (data.approveSignal) {
          var sigEl = el("span",
            "flex:1;min-width:260px;font-size:13.5px;line-height:1.55;color:" + t.fg + ";");
          richText(sigEl, data.approveSignal.replace(/\n/g, " · "), t);
          banner.appendChild(sigEl);
        }
        box.appendChild(banner);
      }
      if (data.tldr || data.impression) {
        var twoCol = data.tldr && data.impression && window.innerWidth >= 980;
        var grid = el("div",
          "padding:14px 20px 16px;display:grid;grid-template-columns:" +
          (twoCol ? "1fr 1fr" : "1fr") + ";gap:15px 36px;");
        [["TL;DR", data.tldr], ["Impression", data.impression]].forEach(function (p) {
          if (!p[1]) return;
          var cell = el("div", "min-width:0;");
          cell.appendChild(sectionHeading(p[0], t));
          cell.appendChild(bulletText(p[1], t, 13.5));
          grid.appendChild(cell);
        });
        box.appendChild(grid);
      }
      main.appendChild(box);
    }

    var counts = { high: 0, med: 0, low: 0 };
    scored.forEach(function (h) {
      var s = h.importance || 0;
      if (s >= 70) counts.high++; else if (s >= 40) counts.med++; else counts.low++;
    });

    var head = el("div", "display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:6px 0 4px;");
    head.appendChild(el("span", "font-weight:600;font-size:17px;", "Review priority"));
    [["#d1242f", counts.high + " high"], ["#bc4c00", counts.med + " medium"],
     ["#8b949e", counts.low + " low"], [t.muted, noise + " auto-buried"]].forEach(function (p) {
      if (parseInt(p[1]) === 0) return;
      var chip = el("span", "display:inline-flex;gap:6px;align-items:baseline;font-size:12px;color:" + t.muted + ";");
      chip.appendChild(el("span", "color:" + p[0] + ";font-size:10px;", "●"));
      chip.appendChild(el("span", "", p[1]));
      head.appendChild(chip);
    });
    head.appendChild(el("span", "flex:1;"));
    var seg = el("div", "display:inline-flex;border:1px solid " + t.border + ";border-radius:6px;overflow:hidden;");
    [["all", "All"], ["70", "≥ 70%"], ["40", "≥ 40%"]].forEach(function (f, i) {
      var on = listFilter === f[0];
      var b = el("span", "padding:3px 12px;font-size:12px;cursor:pointer;" +
        (i ? "border-left:1px solid " + t.border + ";" : "") +
        (on ? "background:" + t.accent + ";color:#fff;font-weight:600;" : "color:" + t.muted + ";"), f[1]);
      b.addEventListener("click", function () { listFilter = f[0]; renderViewContent(); });
      seg.appendChild(b);
    });
    head.appendChild(seg);
    // fresh scores + fresh deep reviews (e.g. after new commits land on the PR)
    head.appendChild(dangerBtn("↻ Re-triage", t, function (b) {
      b.disabled = true;
      b.textContent = "re-triaging…";
      request("POST", BASE + "/triage",
        { "Content-Type": "application/json", "X-PR-Triage": "1" },
        JSON.stringify({ pr: prPath(), force: true }),
        function (st) {
          if (st === 200 || st === 202) {
            data = null;
            threads = [];
            reviewCache = {};
            detailIdx = null;
            serverState = "queued";
            renderViewContent();
          } else {
            b.disabled = false;
            b.textContent = "↻ Re-triage";
          }
        }, 30000);
    }));
    main.appendChild(head);
    main.appendChild(el("div", "color:" + t.muted + ";font-size:12px;margin:2px 0 6px;",
      "click a header to collapse · double-click (or Focus ⤢) for the detailed review · " +
      "hover a line number to comment"));

    if (!visible.length) {
      main.appendChild(el("div", "color:" + t.muted + ";padding:24px 0;",
        "no hunks at this priority — switch the filter back to All"));
    }
    visible.forEach(function (h) { main.appendChild(buildCard(h, t, false)); });

    if (window.innerWidth >= 1100) {
      var col = chatColumn(t, null);
      outer.appendChild(col);
      paintChat("pr", t);
    } else {
      floatingChat(t, null);
    }
  }

  function bigButton(label, onClick) {
    var b = el("button",
      "border:0;border-radius:6px;background:#1f883d;color:#fff;padding:8px 18px;" +
      "font:600 14px " + GH_FONT + ";cursor:pointer;", label);
    b.addEventListener("click", onClick);
    return b;
  }

  function renderViewContent() {
    if (!viewEl) return;
    while (viewEl.firstChild) viewEl.removeChild(viewEl.firstChild);
    reviewBoxes = {};
    var t = theme();
    var wrap = el("div", "max-width:1440px;margin:0 auto;");
    viewEl.appendChild(wrap);

    if (serverState === "ready" && data) {
      if (detailIdx !== null) renderDetail(wrap, t);
      else renderList(wrap, t);
    } else if (serverState === "queued" || serverState === "running") {
      wrap.appendChild(el("div", "font-size:16px;margin:24px 0 8px;",
        "Scoring with claude… (" + serverState + ")"));
      wrap.appendChild(el("div", "color:" + t.muted + ";",
        "this usually takes under a minute — the view updates by itself"));
    } else if (serverState === "error") {
      wrap.appendChild(el("div", "font-size:16px;margin:24px 0 12px;", "The last triage of this PR failed."));
      wrap.appendChild(el("div", "color:" + t.muted + ";margin-bottom:16px;", "check the `pr-triage serve` terminal for the error, then retry"));
      wrap.appendChild(bigButton("Retry triage", postTriage));
    } else if (serverState === "empty") {
      wrap.appendChild(el("div", "font-size:16px;margin:24px 0;", "Triage finished, but there is nothing to overlay for this PR."));
    } else {
      wrap.appendChild(el("div", "font-size:16px;margin:24px 0 12px;", "This PR hasn't been triaged yet."));
      wrap.appendChild(bigButton("Triage this PR", postTriage));
      wrap.appendChild(el("div", "color:" + t.muted + ";margin-top:14px;",
        "scores every hunk 0–100 with your local claude via `pr-triage serve`"));
    }
    lastRendered = fingerprint();
  }

  function fingerprint() {
    return serverState + ":" + (data ? data.hunks.length : 0) + ":" +
      (detailIdx === null ? "list" : "d" + detailIdx) + ":" + listFilter + ":" +
      (isDark() ? "d" : "l");
  }

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !viewEl) return;
    // don't yank the view away while typing in the chat or a comment editor
    if (e.target && (e.target.tagName === "TEXTAREA" || e.target.tagName === "INPUT")) return;
    if (detailIdx !== null) { detailIdx = null; renderViewContent(); }
    else closeView();
  });

  // -------------------------------------------------------------------- tick

  function cleanupAll() {
    closeView();
    removeBadges();
    var tab = document.getElementById("pr-triage-tab");
    if (tab) tab.remove();
  }

  function tick() {
    var p = prPath();
    if (!p) { cleanupAll(); return; }
    if (viewEl && !viewEl.isConnected) {
      viewEl = null;
      detailIdx = null;
      lastRendered = "";
      unlockScroll();
    }
    if (data && dataPr !== p) {
      data = null;
      threads = [];
      dataPr = null;
      serverState = "offline";
      collapsed = {};
      reviewCache = {};
      chatState = {};
      listFilter = "all";
      cleanupAll();
    }
    if (!data) loadData();
    ensureTab();
    if (data && onDiffTab()) annotateFiles();
    if (viewEl && lastRendered !== fingerprint()) renderViewContent();
  }

  setInterval(tick, POLL_MS);
  tick();
})();
