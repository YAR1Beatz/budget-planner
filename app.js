(function () {
  "use strict";

  const Calc = window.BudgetCalc;
  const Defaults = window.BudgetDefaults;
  const Profiles = window.BudgetProfiles;
  const Charts = window.BudgetCharts;

  const storage = {
    async load() {
      if (window.budgetAPI && window.budgetAPI.load) return window.budgetAPI.load();
      try {
        const raw = localStorage.getItem("budget-planner-data");
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        return null;
      }
    },
    async save(data) {
      if (window.budgetAPI && window.budgetAPI.save) return window.budgetAPI.save(data);
      localStorage.setItem("budget-planner-data", JSON.stringify(data));
      return { ok: true };
    },
  };

  let state;
  let store;
  let profileMenuOpen = false;
  let saveStatus = "saved";
  let saveTimer = null;
  let modal = null;
  let toastTimer = null;
  let mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  let navOpen = false;
  let authOpen = false;
  let authBusy = false;
  let authDismissed = false;
  let authNotice = "";
  let authError = "";
  let authEmail = "";
  let applyingRemote = false;
  let syncSnapshot = { status: "signed-out", user: null, error: null };

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function money(n) {
    return Calc.formatMoney(n, state.currency);
  }

  function isPhone() {
    return window.matchMedia("(max-width: 720px)").matches;
  }

  function isAmountInput(el) {
    if (!el || el.tagName !== "INPUT") return false;
    if (el.classList.contains("amt-input")) return true;
    if (el.dataset && el.dataset.field === "amount") return true;
    if (el.dataset && (el.dataset.gfield === "target" || el.dataset.gfield === "saved")) return true;
    if (el.dataset && el.dataset.cfield === "amount") return true;
    if (el.readOnly && /amount/i.test(el.getAttribute("aria-label") || "")) return true;
    return false;
  }

  function formatWhole(value) {
    if (value === "" || value == null) return "";
    const parsed = parseWholeInput(value);
    if (parsed === "") return "";
    const n = Number(parsed);
    if (!Number.isFinite(n)) return "";
    const loc = state.currency === "DKK" || state.currency === "SEK" || state.currency === "NOK" ? "da-DK" : "en-GB";
    try {
      return new Intl.NumberFormat(loc, { maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(Math.round(n));
    } catch (err) {
      return String(Math.round(n));
    }
  }

  function parseWholeInput(value) {
    if (value === null || value === undefined) return "";
    let s = String(value).trim().replace(/\s/g, "").replace(/[^\d,.-]/g, "");
    if (!s || s === "-" || s === "." || s === ",") return "";
    const loc = state.currency === "DKK" || state.currency === "SEK" || state.currency === "NOK" ? "da-DK" : "en-GB";
    if (loc === "da-DK") s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
    const n = Number(s);
    if (!Number.isFinite(n)) return "";
    return String(Math.round(n));
  }

  function rawWhole(value) {
    const w = parseWholeInput(value);
    return w;
  }

  function decorateAmountInputs() {
    document.querySelectorAll("input").forEach((el) => {
      if (!isAmountInput(el)) return;
      if (el === document.activeElement) {
        const raw = rawWhole(el.value);
        if (raw !== "" && el.value !== raw) el.value = raw;
        return;
      }
      if (el.value === "") return;
      el.value = formatWhole(el.value);
    });
  }

  function amountValueOf(id) {
    return rawWhole(valueOf(id));
  }

  function resolvedTheme() {
    if (state.theme === "light" || state.theme === "dark" || state.theme === "bright") return state.theme;
    return mediaQuery.matches ? "dark" : "light";
  }

  function applyTheme() {
    const theme = resolvedTheme();
    document.documentElement.setAttribute("data-theme", theme);
    // Match the iPhone status bar to the solid header colour of each theme.
    const meta = document.querySelector('meta[name="theme-color"]');
    const colors = { light: "#F8F1E8", dark: "#1C1814", bright: "#FBF8FF" };
    if (meta && colors[theme] && meta.getAttribute("content") !== colors[theme]) meta.setAttribute("content", colors[theme]);
  }

  function currentMonth() {
    if (!state.months[state.selectedMonth]) {
      state.months[state.selectedMonth] = Defaults.emptyMonth();
    }
    return state.months[state.selectedMonth];
  }

  function totals() {
    const month = currentMonth();
    const incomeTotal = Calc.sumAmounts(month.income);
    const loanPayoff = loanMonthlyTotal();
    const expenseTotal = Calc.roundMoney(Calc.sumAmounts(month.expenses) + loanPayoff);
    const remaining = Calc.leftover(incomeTotal, expenseTotal);
    return { month, incomeTotal, expenseTotal, remaining, loanPayoff };
  }

  function loanMonthlyTotal() {
    return Math.round(
      (state.loans || [])
        .filter((loan) => Calc.currentLoanBalance(loan) > 0)
        .reduce((sum, loan) => sum + Calc.parseMoney(loan.monthlyPayment), 0)
    );
  }

  function previousMonthKey() {
    const keys = Object.keys(state.months).sort();
    const index = keys.indexOf(state.selectedMonth);
    return index > 0 ? keys[index - 1] : null;
  }

  function markDirty() {
    if (state) Calc.roundAllAmounts(state);
    saveStatus = "unsaved";
    refreshSaveChip();
    scheduleSave();
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow(), 500);
  }

  async function saveNow() {
    clearTimeout(saveTimer);
    saveStatus = "saving";
    refreshSaveChip();
    try {
      if (store && Profiles) store = Profiles.withActiveData(store, state);
      if (!applyingRemote && window.BudgetSyncLogic) store = window.BudgetSyncLogic.stamp(store);
      await storage.save(store || state);
      saveStatus = "saved";
      if (!applyingRemote && window.BudgetSync) window.BudgetSync.push(store || state);
    } catch (err) {
      saveStatus = "unsaved";
      showToast("Could not save. Please try again.");
    }
    refreshSaveChip();
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.hidden = false;
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2800);
  }

  function setTab(tab) {
    state.activeTab = tab;
    navOpen = false;
    markDirty();
    renderAll();
  }

  function selectMonth(key) {
    state.selectedMonth = key;
    navOpen = false;
    monthPickerOpen = false;
    markDirty();
    renderAll();
    if (isPhone()) return; // no surprise keyboard on the phone
    const first = document.querySelector(".entry-row input");
    focusInPlace(first);
  }

  /* ——— Rendering ——— */

  // Re-rendering replaces the whole page, which resets every scroll position.
  // Remember where each scroller was and put it back, unless the tab changed.
  let lastRenderedTab = null;
  const SCROLLERS = [".main", ".sidebar", ".goals-sidebar", ".loan-sidebar"];

  function captureScroll() {
    const se = document.scrollingElement || document.documentElement;
    const saved = { tab: lastRenderedTab, win: window.scrollY || (se ? se.scrollTop : 0), els: {} };
    SCROLLERS.forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) saved.els[sel] = el.scrollTop;
    });
    return saved;
  }

  function restoreScroll(saved) {
    if (!saved || saved.tab !== state.activeTab) return;
    SCROLLERS.forEach((sel) => {
      const el = document.querySelector(sel);
      if (el && saved.els[sel] != null && el.scrollTop !== saved.els[sel]) el.scrollTop = saved.els[sel];
    });
    if (Math.abs((window.scrollY || 0) - saved.win) > 1) window.scrollTo(0, saved.win);
  }

  // Focus without the browser jumping; nudge into view only when off screen.
  function focusInPlace(el, opts) {
    if (!el) return;
    try {
      el.focus({ preventScroll: true });
    } catch (err) {
      el.focus();
    }
    if (opts && opts.select && el.select) el.select();
    if (opts && opts.reveal) {
      const rect = el.getBoundingClientRect();
      const top = 90;
      const bottom = window.innerHeight - 110;
      if (rect.top < top || rect.bottom > bottom) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function renderAll() {
    const savedScroll = captureScroll();
    applyTheme();
    const isMac = window.budgetAPI && window.budgetAPI.platform === "darwin";
    document.body.classList.toggle("is-mac", !!isMac);
    document.body.classList.toggle("is-web", !!(window.budgetAPI && window.budgetAPI.isWeb));
    document.body.classList.toggle("nav-open", navOpen);

    const app = document.getElementById("app");
    app.innerHTML = [
      renderTitlebar(),
      renderPhoneHeader(),
      '<div class="shell">',
      state.activeTab === "budget" ? renderSidebar() : "",
      state.activeTab === "goals" ? renderGoalsSidebar() : "",
      state.activeTab === "loans" ? renderLoanSidebar() : "",
      '<main class="main">',
      '<div class="main-inner">',
      state.activeTab === "budget" ? renderBudget() : "",
      state.activeTab === "goals" ? renderGoals() : "",
      state.activeTab === "loans" ? renderLoans() : "",
      "</div></main></div>",
      renderPhoneTabBar(),
      modal ? renderModal() : "",
      authOpen ? renderAuthModal() : "",
      iconPicker ? renderIconPicker() : "",
      monthPickerOpen ? renderMonthPicker() : "",
      navOpen ? '<div class="nav-backdrop" data-action="close-nav"></div>' : "",
    ].join("");
    restoreScroll(savedScroll);
    lastRenderedTab = state.activeTab;
    fitSidebarNumbers();
    decorateAmountInputs();
    const modalInput = document.getElementById("modal-input");
    if (modalInput) {
      focusInPlace(modalInput, { select: true });
    } else if (authOpen) {
      const active = document.activeElement;
      const inAuth = active && (active.id === "sync-email" || active.id === "sync-password");
      const emailInput = document.getElementById("sync-email");
      if (!inAuth && emailInput && !syncSnapshot.user) focusInPlace(emailInput);
    }
  }

  function renderThemeSelect(extraClass) {
    const current = resolvedTheme();
    const themeOptions = [
      ["light", "Warm"],
      ["dark", "Dark"],
      ["bright", "Bright"],
    ]
      .map(([value, label]) => `<option value="${value}"${value === current ? " selected" : ""}>${label}</option>`)
      .join("");
    const cls = extraClass ? "select theme-select " + extraClass : "select theme-select";
    return `<select class="${cls}" data-action="theme" aria-label="Design">${themeOptions}</select>`;
  }

  function renderThemeSegment() {
    const current = resolvedTheme();
    const opts = [
      ["light", "Warm"],
      ["dark", "Dark"],
      ["bright", "Bright"],
    ];
    return [
      '<div class="theme-seg" role="group" aria-label="Design">',
      opts
        .map(
          ([value, label]) =>
            `<button type="button" class="theme-seg-btn${value === current ? " is-on" : ""}" data-action="set-theme" data-theme="${value}" aria-pressed="${
              value === current
            }" title="${label}"><span class="theme-seg-dot theme-dot-${value}" aria-hidden="true"></span><span class="theme-seg-label">${label}</span></button>`
        )
        .join(""),
      "</div>",
    ].join("");
  }

  function renderTitlebar() {
    const TAB_ICONS = { budget: WS_ICON_BUDGET, goals: WS_ICON_GOALS, loans: WS_ICON_LOANS };
    const tabs = [
      { id: "budget", label: "Budget" },
      { id: "goals", label: "Goals" },
      { id: "loans", label: "Loans" },
    ];
    return [
      '<header class="titlebar">',
      '  <button class="btn-icon nav-toggle" type="button" data-action="toggle-nav" aria-label="Open menu">☰</button>',
      '  <div class="titlebar-brand">',
      '    <div class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></div>',
      "    <span>Budget Planner</span>",
      "  </div>",
      '  <nav class="tabs" aria-label="Sections">',
      tabs
        .map(
          (tab) =>
            `<button class="tab" type="button" data-action="tab" data-tab="${tab.id}" aria-selected="${
              state.activeTab === tab.id
            }"><span class="tab-ico" aria-hidden="true">${TAB_ICONS[tab.id] || ""}</span>${tab.label}</button>`
        )
        .join(""),
      "  </nav>",
      '  <div class="titlebar-actions">',
      renderThemeSegment(),
      `    <button class="btn save-chip" type="button" data-action="save" data-status="${saveStatus}">${saveLabel()}</button>`,
      renderSyncChip("titlebar"),
      "  </div>",
      "</header>",
    ].join("");
  }

  function profileName() {
    const active = activeProfile();
    return (active && active.name) || "there";
  }

  function profileInitial() {
    const name = String(profileName() || "").trim();
    return name ? name.charAt(0).toUpperCase() : "M";
  }

  const WS_ICON_BUDGET = '<svg width="22" height="22" viewBox="0 0 26 26" fill="none" aria-hidden="true"><rect x="3.5" y="6.5" width="19" height="15" rx="3" stroke="currentColor" stroke-width="1.7"/><path d="M3.5 11.5h19" stroke="currentColor" stroke-width="1.7"/><path d="M8 16.5h4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  const WS_ICON_GOALS = '<svg width="22" height="22" viewBox="0 0 26 26" fill="none" aria-hidden="true"><circle cx="13" cy="13" r="8.5" stroke="currentColor" stroke-width="1.7"/><circle cx="13" cy="13" r="4.5" stroke="currentColor" stroke-width="1.7"/><circle cx="13" cy="13" r="1.6" fill="currentColor"/></svg>';
  const WS_ICON_LOANS = '<svg width="22" height="22" viewBox="0 0 26 26" fill="none" aria-hidden="true"><path d="M4.5 11 13 5.5 21.5 11" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M7 10.5V19.5h12V10.5" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M4.5 19.5h17" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  function renderPhoneHeader() {
    const kicker = "Hi " + escapeHtml(profileName());
    let title = `<button class="ws-title-btn" type="button" data-action="open-month-picker" aria-haspopup="dialog" aria-label="${escapeHtml(
      Calc.monthTitle(state.selectedMonth)
    )}, choose month">${escapeHtml(Calc.monthTitle(state.selectedMonth))}<span class="ws-title-caret" aria-hidden="true">▾</span></button>`;
    let trailing = `<button class="ws-avatar" type="button" data-action="toggle-nav" aria-label="Open menu and profiles">${escapeHtml(profileInitial())}</button>`;
    if (state.activeTab === "goals") {
      title = "Your goals";
      trailing = '<button class="ws-add" type="button" data-action="scroll-add">+ Add</button>';
    } else if (state.activeTab === "loans") {
      title = "Loans";
      trailing = '<button class="ws-add" type="button" data-action="scroll-add">+ Add</button>';
    }
    return [
      '<header class="ws-header">',
      '  <button class="ws-menu btn-icon nav-toggle" type="button" data-action="toggle-nav" aria-label="Open menu">☰</button>',
      '  <div class="ws-hello">',
      `    <div class="ws-hi">${kicker}</div>`,
      `    <h1 class="ws-title">${title}</h1>`,
      "  </div>",
      "  " + trailing,
      "</header>",
    ].join("");
  }

  function renderPhoneTabBar() {
    const tabs = [
      { id: "budget", label: "Budget", icon: WS_ICON_BUDGET },
      { id: "goals", label: "Goals", icon: WS_ICON_GOALS },
      { id: "loans", label: "Loans", icon: WS_ICON_LOANS },
    ];
    return [
      '<nav class="ws-tabbar" aria-label="Sections">',
      tabs
        .map(
          (tab) =>
            `<button class="ws-tab${state.activeTab === tab.id ? " is-active" : ""}" type="button" data-action="tab" data-tab="${tab.id}" aria-selected="${
              state.activeTab === tab.id
            }">${tab.icon}<span>${tab.label}</span></button>`
        )
        .join(""),
      "</nav>",
    ].join("");
  }

  function categoryEmoji(name, kind) {
    const n = String(name || "").toLowerCase();
    const rules = [
      [/salary|wage|paycheck|take-home|løn/, "💼"],
      [/other income|freelance|bonus/, "💰"],
      [/hous|rent|mortgage|bolig|home/, "🏠"],
      [/groc|food|supermarket|mad|merk/, "🛒"],
      [/util|electric|power|water|internet|energy|el |varme/, "💡"],
      [/transport|transit|bus|train|fuel|petrol|gas|ticket|car fare/, "🚌"],
      [/subscr|stream|netflix|spotify|apple|tv/, "🎬"],
      [/emerg|rainy|buffer|safety/, "☂️"],
      [/leisure|fritid|\bfun\b|hobby|entertainment|other/, "🎲"],
      [/travel|ferie|holiday|trip|vacation/, "✈️"],
      [/loan|debt|payoff/, "🏦"],
      [/insur|forsikr/, "📄"],
      [/health|doctor|medic|apotek|dental/, "💊"],
      [/child|kids|school|børn/, "🧸"],
      [/phone|mobil|cell/, "📱"],
      [/eat|restaurant|cafe|dining|coffee/, "🍽️"],
      [/cloth|shoe|shop|tøj/, "🛍️"],
      [/pet|dog|cat/, "🐾"],
    ];
    for (let i = 0; i < rules.length; i += 1) {
      if (rules[i][0].test(n)) return rules[i][1];
    }
    return kind === "income" ? "💵" : "📦";
  }

  function goalEmoji(name) {
    return categoryEmoji(name, "goal") === "📦" ? "🎯" : categoryEmoji(name, "goal");
  }

  function loanEmoji(name) {
    const n = String(name || "").toLowerCase();
    if (/car|auto|bil/.test(n)) return "🚗";
    if (/house|home|mortgage|bolig/.test(n)) return "🏠";
    if (/student|stud|educ/.test(n)) return "🎓";
    if (/credit|card/.test(n)) return "💳";
    return "🏦";
  }

  const ICON_CHOICES = [
    "💼", "💵", "💰", "🏦", "🏠", "🔑", "🛒", "🍽️", "☕", "🍕",
    "💡", "💧", "📡", "📱", "💻", "🚌", "🚗", "⛽", "🚲", "🚆",
    "🎬", "🎵", "📺", "💊", "🏥", "🎲", "🎮", "🎉", "🛍️", "👕",
    "✈️", "🏖️", "🎁", "🐾", "🧸", "👶", "📄", "☂️", "📦", "🏋️",
  ];

  let iconPicker = null;
  let monthPickerOpen = false;

  // Phone: quick month switcher opened from the big month title.
  function renderMonthPicker() {
    const keys = Object.keys(state.months).sort();
    const items = keys
      .map((key) => {
        const selected = key === state.selectedMonth;
        const saved = Calc.monthHasData(state.months[key]);
        return [
          `<button type="button" class="month-pick${selected ? " is-selected" : ""}" data-action="select-month" data-month="${key}" aria-current="${selected ? "true" : "false"}">`,
          `  <span>${escapeHtml(Calc.monthTitle(key))}</span>`,
          selected ? '  <span class="month-pick-check" aria-hidden="true">✓</span>' : saved ? '  <span class="dot" aria-hidden="true"></span>' : "",
          "</button>",
        ].join("");
      })
      .join("");
    return [
      '<div class="icon-picker-layer month-picker-layer">',
      '  <div class="icon-picker-backdrop" data-action="close-month-picker"></div>',
      '  <div class="icon-picker month-picker" role="dialog" aria-modal="true" aria-label="Choose a month">',
      '    <div class="icon-picker-grab" aria-hidden="true"></div>',
      '    <div class="icon-picker-head">',
      "      <h2>Choose a month</h2>",
      '      <button type="button" class="icon-picker-close" data-action="close-month-picker" aria-label="Close">×</button>',
      "    </div>",
      `    <div class="month-pick-list">${items}</div>`,
      '    <button class="btn month-pick-add" type="button" data-action="add-month">Add next month</button>',
      "  </div>",
      "</div>",
    ].join("");
  }

  function rowIcon(row, kind) {
    const custom = Calc.sanitizeIcon(row && row.icon);
    return custom || categoryEmoji(row && row.name, kind);
  }

  function renderIconPicker() {
    if (!iconPicker) return "";
    const row = monthRows(iconPicker.kind).find((r) => String(r.id) === String(iconPicker.id));
    if (!row) return "";
    const auto = categoryEmoji(row.name, iconPicker.kind);
    const custom = Calc.sanitizeIcon(row.icon);
    const current = custom || auto;
    const autoBtn = [
      `<button type="button" class="icon-picker-auto${custom ? "" : " is-selected"}" data-action="set-icon" data-kind="${iconPicker.kind}" data-id="${iconPicker.id}" data-icon="" aria-pressed="${custom ? "false" : "true"}">`,
      `  <span class="icon-picker-auto-emoji" aria-hidden="true">${auto}</span>`,
      "  <span>Automatic</span>",
      "</button>",
    ].join("");
    const cells = ICON_CHOICES.map((emoji) => {
      const selected = custom === emoji;
      return `<button type="button" class="icon-pick${selected ? " is-selected" : ""}" data-action="set-icon" data-kind="${iconPicker.kind}" data-id="${iconPicker.id}" data-icon="${emoji}" aria-label="Use ${emoji}" aria-pressed="${selected ? "true" : "false"}">${emoji}</button>`;
    }).join("");
    return [
      '<div class="icon-picker-layer">',
      '  <div class="icon-picker-backdrop" data-action="close-icon-picker"></div>',
      '  <div class="icon-picker" role="dialog" aria-modal="true" aria-label="Choose an icon">',
      '    <div class="icon-picker-grab" aria-hidden="true"></div>',
      '    <div class="icon-picker-head">',
      "      <h2>Choose an icon</h2>",
      '      <button type="button" class="icon-picker-close" data-action="close-icon-picker" aria-label="Close">×</button>',
      "    </div>",
      autoBtn,
      `    <div class="icon-picker-grid">${cells}</div>`,
      "  </div>",
      "</div>",
    ].join("");
  }

  function setRowIcon(kind, id, icon) {
    const row = monthRows(kind).find((r) => String(r.id) === String(id));
    if (!row) return;
    const cleaned = Calc.sanitizeIcon(icon);
    if (cleaned) row.icon = cleaned;
    else delete row.icon;
    iconPicker = null;
    markDirty();
    renderAll();
  }

  function closeIconPicker() {
    if (!iconPicker) return;
    iconPicker = null;
    renderAll();
  }

  function renderRemainHero(incomeTotal, expenseTotal, remaining) {
    const shortfall = remaining < 0;
    return [
      '<section class="ws-hero">',
      '  <div class="ws-hero-top">',
      `    <div class="ws-hero-kicker">${shortfall ? "Shortfall" : "Remaining"}</div>`,
      renderSyncChip("hero"),
      "  </div>",
      `  <div class="ws-hero-value${shortfall ? " is-short" : ""}">${escapeHtml(money(Math.abs(remaining)))}</div>`,
      '  <div class="ws-split">',
      `    <div class="ws-cell"><div class="ws-lbl">Income</div><div class="ws-val in">${escapeHtml(money(incomeTotal))}</div></div>`,
      `    <div class="ws-cell"><div class="ws-lbl">Expenses</div><div class="ws-val out">−${escapeHtml(money(expenseTotal))}</div></div>`,
      "  </div>",
      "</section>",
    ].join("");
  }

  function renderLoanHero(loans, debt, starting, paid, paidPct) {
    const info = debtFreeInfo(loans);
    return [
      '<section class="ws-hero ws-loan-hero">',
      '  <div class="ws-hero-top">',
      `    <div class="ws-hero-kicker">${escapeHtml(debtUnitTitle())}</div>`,
      renderSyncChip("hero"),
      "  </div>",
      `  <div class="ws-hero-value${info.tone ? " " + info.tone : ""}">${escapeHtml(info.value)}</div>`,
      info.detail ? `  <p class="ws-hero-detail">${escapeHtml(info.detail)}</p>` : "",
      '  <div class="ws-split">',
      `    <div class="ws-cell"><div class="ws-lbl">Total debt</div><div class="ws-val">${escapeHtml(money(debt))}</div></div>`,
      `    <div class="ws-cell"><div class="ws-lbl">Monthly payoff</div><div class="ws-val out">${escapeHtml(money(loanMonthlyTotal()))}</div></div>`,
      `    <div class="ws-cell ws-desk-only"><div class="ws-lbl">Original balances</div><div class="ws-val">${escapeHtml(money(starting))}</div></div>`,
      "  </div>",
      starting > 0
        ? `  <div class="ws-loan-paid"><span>Paid off so far</span><strong>${escapeHtml(money(paid))}</strong><span class="ws-loan-pct">${paidPct}%</span></div><div class="progress-track ws-hero-track"><div class="progress-fill" style="width:${paidPct}%;background:${progressColour(paidPct)}"></div></div>`
        : "",
      "</section>",
    ].join("");
  }

  function largeGoalRing(pct) {
    const r = 52;
    const c = 2 * Math.PI * r;
    const fill = (Math.max(0, Math.min(100, pct)) / 100) * c;
    const color = progressColour(pct);
    return [
      '<div class="ws-goal-ring" aria-hidden="true">',
      '  <svg width="128" height="128" viewBox="0 0 128 128">',
      `    <circle cx="64" cy="64" r="${r}" fill="none" stroke="var(--ws-track, #F0E6D8)" stroke-width="12"/>`,
      `    <circle cx="64" cy="64" r="${r}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round"`,
      `      stroke-dasharray="${fill.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 64 64)"/>`,
      "  </svg>",
      `  <div class="ws-ring-label">${Math.round(pct)}%</div>`,
      "</div>",
    ].join("");
  }

  function renderSidebarTools(opts) {
    const prev = previousMonthKey();
    return [
      '<div class="sidebar-phone-tools">',
      currencySelect(),
      opts && opts.copyLast && prev
        ? `<button class="btn" type="button" data-action="copy-last">Copy ${escapeHtml(Calc.monthShortTitle(prev))}</button>`
        : "",
      "</div>",
    ].join("");
  }

  function syncLabel(place) {
    const status = syncSnapshot.status;
    if (status === "synced") return "Synced";
    if (status === "syncing") return "Syncing…";
    if (status === "offline") return "Offline";
    if (status === "error") return "Sync error";
    return place === "titlebar" ? "Sync" : "Sign in to sync";
  }

  function renderSyncChip(place) {
    const status = syncSnapshot.status;
    const title = status === "error" && syncSnapshot.error ? escapeHtml(syncSnapshot.error) : "";
    return (
      `<button class="sync-chip sync-chip-${place}" type="button" data-action="open-sync" data-status="${escapeHtml(
        status
      )}"` +
      (title ? ` title="${title}"` : "") +
      `>${syncLabel(place)}</button>`
    );
  }

  function refreshSyncChip() {
    document.querySelectorAll(".sync-chip").forEach((chip) => {
      const place = chip.classList.contains("sync-chip-sidebar") ? "sidebar" : "titlebar";
      chip.dataset.status = syncSnapshot.status;
      chip.textContent = syncLabel(place);
      if (syncSnapshot.status === "error" && syncSnapshot.error) chip.title = syncSnapshot.error;
      else chip.removeAttribute("title");
    });
  }

  function renderAuthModal() {
    const signedIn = !!(syncSnapshot.user && syncSnapshot.user.email);
    const email = signedIn ? escapeHtml(syncSnapshot.user.email) : escapeHtml(authEmail);
    const body = signedIn
      ? [
          `<p>Signed in as <strong>${email}</strong>. Changes here and on your iPhone stay in sync.</p>`,
          authError ? `<p class="auth-error">${escapeHtml(authError)}</p>` : "",
          '<div class="modal-actions">',
          '  <button class="btn" type="button" data-action="close-sync">Close</button>',
          '  <button class="btn" type="button" data-action="sync-signout">Sign out</button>',
          "</div>",
        ]
      : [
          "<p>Create an account or sign in to keep this budget in sync on your iPhone. Use the same email on both.</p>",
          authNotice ? `<p class="auth-notice">${escapeHtml(authNotice)}</p>` : "",
          authError ? `<p class="auth-error">${escapeHtml(authError)}</p>` : "",
          '<label class="field modal-field">',
          '  <span class="field-label">Email</span>',
          `  <input class="input" id="sync-email" type="email" autocomplete="username" value="${email}" ${
            authBusy ? "disabled" : ""
          } />`,
          "</label>",
          '<label class="field modal-field">',
          '  <span class="field-label">Password</span>',
          `  <input class="input" id="sync-password" type="password" autocomplete="current-password" ${
            authBusy ? "disabled" : ""
          } />`,
          "</label>",
          '<div class="modal-actions auth-actions">',
          '  <button class="btn" type="button" data-action="close-sync">Not now</button>',
          `  <button class="btn" type="button" data-action="sync-signin" ${authBusy ? "disabled" : ""}>Sign in</button>`,
          `  <button class="btn btn-primary" type="button" data-action="sync-signup" ${
            authBusy ? "disabled" : ""
          }>Create account</button>`,
          "</div>",
        ];
    return [
      '<div class="modal-backdrop" id="sync-backdrop">',
      '  <div class="modal auth-modal" role="dialog" aria-modal="true" aria-labelledby="sync-title">',
      '    <h2 id="sync-title">Sync</h2>',
      body.join(""),
      "  </div>",
      "</div>",
    ].join("");
  }

  function saveLabel() {
    if (saveStatus === "saved") return "Saved";
    if (saveStatus === "saving") return "Saving…";
    return "Save";
  }

  function refreshSaveChip() {
    const chip = document.querySelector(".save-chip");
    if (!chip) return;
    chip.dataset.status = saveStatus;
    chip.textContent = saveLabel();
  }


  function activeProfile() {
    return store && Profiles ? Profiles.getActive(store) : null;
  }

  function renderProfileSwitcher() {
    const profiles = (store && store.profiles) || [];
    const active = activeProfile();
    const name = (active && active.name) || "Budget";
    const canDelete = profiles.length > 1;
    const items = profiles
      .map((profile) => {
        const selected = active && profile.id === active.id;
        return [
          '<div class="profile-menu-row">',
          `  <button class="profile-menu-item${selected ? " is-active" : ""}" type="button" data-action="switch-profile" data-id="${escapeHtml(profile.id)}">`,
          `    <span class="profile-check" aria-hidden="true">${selected ? "✓" : ""}</span>`,
          `    <span class="profile-name">${escapeHtml(profile.name)}</span>`,
          "  </button>",
          `  <button class="btn-icon profile-row-btn" type="button" data-action="rename-profile" data-id="${escapeHtml(profile.id)}" aria-label="Rename ${escapeHtml(profile.name)}" title="Rename">✎</button>`,
          canDelete
            ? `  <button class="btn-icon profile-row-btn" type="button" data-action="delete-profile" data-id="${escapeHtml(profile.id)}" aria-label="Delete ${escapeHtml(profile.name)}" title="Delete">×</button>`
            : "",
          "</div>",
        ].join("");
      })
      .join("");
    return [
      '<div class="profile-switcher">',
      '  <button class="profile-switcher-btn" type="button" data-action="toggle-profiles" aria-haspopup="menu"',
      `   aria-expanded="${profileMenuOpen ? "true" : "false"}">`,
      `    <span class="ws-side-avatar ws-desk-only" aria-hidden="true">${escapeHtml(String(name).trim().charAt(0).toUpperCase() || "M")}</span>`,
      `    <span class="profile-switcher-label">${escapeHtml(name)}</span>`,
      '    <span class="profile-caret" aria-hidden="true">▾</span>',
      "  </button>",
      profileMenuOpen
        ? [
            '<div class="profile-menu-backdrop" data-action="close-profiles"></div>',
            '<div class="profile-menu" role="menu">',
            items,
            '<div class="profile-menu-sep"></div>',
            '<button class="profile-menu-item profile-menu-new" type="button" data-action="new-profile">+ New budget</button>',
            "</div>",
          ].join("")
        : "",
      "</div>",
    ].join("");
  }

  function renderGoalsSidebar() {
    return [
      '<nav class="sidebar goals-sidebar" aria-label="Budget">',
      renderProfileSwitcher(),
      renderSidebarTools(),
      '  <div class="sidebar-footer">',
      renderThemeSelect("sidebar-theme"),
      renderSyncChip("sidebar"),
      "  </div>",
      "</nav>",
    ].join("");
  }

  function renderSidebar() {
    const keys = Object.keys(state.months).sort();
    return [
      '<nav class="sidebar" aria-label="Months">',
      renderProfileSwitcher(),
      '  <div class="sidebar-title">Months</div>',
      '  <div class="month-list">',
      keys
        .map((key) => {
          const selected = key === state.selectedMonth;
          const saved = Calc.monthHasData(state.months[key]);
          return [
            `<button class="month-btn" type="button" data-action="select-month" data-month="${key}"`,
            ` aria-current="${selected ? "page" : "false"}"`,
            ` aria-label="${escapeHtml(Calc.monthTitle(key))}${saved ? ", has saved amounts" : ""}">`,
            `<span>${escapeHtml(Calc.monthShortTitle(key))}</span>`,
            saved ? '<span class="dot" aria-hidden="true"></span>' : "",
            "</button>",
          ].join("");
        })
        .join(""),
      "  </div>",
      renderSidebarWidgets(),
      renderSidebarTools({ copyLast: true }),
      '  <div class="sidebar-footer">',
      '    <button class="btn" type="button" data-action="add-month">Add next month</button>',
      renderThemeSelect("sidebar-theme"),
      renderSyncChip("sidebar"),
      "  </div>",
      "</nav>",
    ].join("");
  }

  function getWidgetPrefs() {
    const prefs = { savings: true, loans: true };
    try {
      const raw = JSON.parse(window.localStorage.getItem("sidebarWidgets") || "{}");
      if (typeof raw.savings === "boolean") prefs.savings = raw.savings;
      if (typeof raw.loans === "boolean") prefs.loans = raw.loans;
    } catch (e) {}
    return prefs;
  }

  function setWidgetPref(key, on) {
    const prefs = getWidgetPrefs();
    prefs[key] = on;
    try {
      window.localStorage.setItem("sidebarWidgets", JSON.stringify(prefs));
    } catch (e) {}
    renderAll();
  }

  function daysUntil(date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(date.getTime());
    end.setHours(0, 0, 0, 0);
    return Math.max(0, Math.round((end - today) / 86400000));
  }

  function savingsRing(pct) {
    const r = 22;
    const c = 2 * Math.PI * r;
    const fill = Math.max(0, Math.min(100, pct)) / 100 * c;
    return [
      '<svg class="mini-ring" viewBox="0 0 56 56" width="56" height="56" aria-hidden="true">',
      `<circle cx="28" cy="28" r="${r}" fill="none" stroke="var(--border)" stroke-width="6"/>`,
      `<circle cx="28" cy="28" r="${r}" fill="none" stroke="${progressColour(pct)}" stroke-width="6" stroke-linecap="round"`,
      ` stroke-dasharray="${fill.toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 28 28)"/>`,
      `<text x="28" y="32" text-anchor="middle" font-size="12" font-weight="700" fill="var(--text)">${Math.round(pct)}%</text>`,
      "</svg>",
    ].join("");
  }

  function fitSidebarNumbers() {
    document.querySelectorAll(".side-widget-big").forEach((el) => {
      el.style.fontSize = "";
      let size = parseFloat(getComputedStyle(el).fontSize) || 22;
      const box = el.closest(".side-widget");
      const fits = () => el.scrollWidth <= el.clientWidth + 0.5 && (!box || box.scrollWidth <= box.clientWidth + 0.5);
      while (!fits() && size > 10) {
        size -= 1;
        el.style.fontSize = size + "px";
      }
    });
  }

  function bigSizeClass(text) {
    const n = String(text).length;
    return n > 14 ? " big-xs" : n > 11 ? " big-sm" : "";
  }

  function renderSavingsWidget() {
    const goals = state.goals || [];
    if (!goals.length) {
      return '<button class="side-widget" type="button" data-action="tab" data-tab="goals"><div class="side-widget-title">Savings</div><div class="side-widget-sub">No savings goals yet. Click to add one.</div></button>';
    }
    const saved = Calc.roundMoney(goals.reduce((sum, g) => sum + Calc.goalSavedTotal(g), 0));
    const target = Calc.roundMoney(goals.reduce((sum, g) => sum + Calc.parseMoney(g.target), 0));
    const pct = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
    const bars = goals
      .slice(0, 4)
      .map((g) => {
        const p = Calc.goalProgress(g);
        return `<div class="mini-bar-row"><span class="mini-bar-name">${escapeHtml(g.name || "Goal")}</span><span class="mini-bar-track"><span class="mini-bar-fill" style="width:${p}%;background:${progressColour(p)}"></span></span><span class="mini-bar-pct">${p}%</span></div>`;
      })
      .join("");
    return [
      '<button class="side-widget" type="button" data-action="tab" data-tab="goals">',
      '  <div class="side-widget-title">Savings</div>',
      '  <div class="side-widget-head">',
      savingsRing(pct),
      `    <div class="side-widget-amount"><div class="side-widget-big soft-green${bigSizeClass(money(saved))}">${escapeHtml(money(saved))}</div><div class="side-widget-sub">of ${escapeHtml(money(target))}</div></div>`,
      "  </div>",
      `  <div class="mini-bars">${bars}</div>`,
      "</button>",
    ].join("");
  }

  function debtPaidPct(loans) {
    const starting = Calc.totalStartingDebt(loans);
    const debt = Calc.totalDebt(loans);
    return starting > 0 ? Math.min(100, Math.round(((starting - debt) / starting) * 1000) / 10) : 0;
  }

  function renderLoansWidget() {
    const loans = state.loans || [];
    if (!loans.length) {
      return '<button class="side-widget" type="button" data-action="tab" data-tab="loans"><div class="side-widget-title">Loans</div><div class="side-widget-sub">No loans yet.</div></button>';
    }
    const info = debtFreeInfo(loans);
    let daysText = info.value;
    let daysSub = info.detail;
    if (info.date) {
      daysText = new Intl.NumberFormat().format(daysUntil(info.date));
      daysSub = `days to debt-free · ${Calc.formatPayoffDate(info.date)}`;
    }
    return [
      '<button class="side-widget" type="button" data-action="tab" data-tab="loans">',
      '  <div class="side-widget-title">Loans</div>',
      `  <div class="side-widget-big" style="color:${progressColour(debtPaidPct(loans))}">${escapeHtml(daysText)}</div>`,
      `  <div class="side-widget-sub">${escapeHtml(daysSub)}</div>`,
      (() => {
        const starting = Calc.totalStartingDebt(loans);
        const debt = Calc.totalDebt(loans);
        const pct = starting > 0 ? Math.min(100, Math.round(((starting - debt) / starting) * 1000) / 10) : 0;
        return `  <div class="side-progress"><div class="side-progress-label"><span>Paid off</span><span>${pct}%</span></div><div class="mini-bar-track side-progress-track"><span class="mini-bar-fill" style="width:${pct}%;background:${progressColour(pct)}"></span></div></div>`;
      })(),
      '  <div class="side-widget-rows">',
      `    <div><span>Total debt</span><strong>${escapeHtml(money(Calc.totalDebt(loans)))}</strong></div>`,
      `    <div><span>Monthly payoff</span><strong class="soft-red">${escapeHtml(money(loanMonthlyTotal()))}</strong></div>`,
      "  </div>",
      "</button>",
    ].join("");
  }

  function nextPayoffCard(loans, asButton) {
    const n = nextPayoffInfo(loans || []);
    if (!n) return "";
    const tag = asButton ? 'button class="side-widget next-payoff-card" type="button" data-action="tab" data-tab="loans"' : 'div class="debtfree-card next-payoff-card"';
    const close = asButton ? "button" : "div";
    return `<${tag}><div class="${asButton ? "side-widget-title" : "debtfree-label"}">Next loan paid off</div><div class="next-payoff-days soft-green">${escapeHtml(new Intl.NumberFormat().format(n.days))} day${n.days === 1 ? "" : "s"}</div><div class="side-widget-sub">${escapeHtml(n.name)} · ${escapeHtml(n.when)}</div></${close}>`;
  }

  function renderSidebarWidgets() {
    const prefs = getWidgetPrefs();
    return [
      '<div class="side-widgets">',
      prefs.savings ? renderSavingsWidget() : "",
      prefs.loans ? renderLoansWidget() : "",
      prefs.loans ? nextPayoffCard(state.loans, true) : "",
      '  <div class="widget-toggles">',
      '    <span class="widget-toggles-label">Show</span>',
      `    <label class="widget-toggle"><input type="checkbox" data-action="widget-toggle" data-widget="savings"${prefs.savings ? " checked" : ""}> Savings</label>`,
      `    <label class="widget-toggle"><input type="checkbox" data-action="widget-toggle" data-widget="loans"${prefs.loans ? " checked" : ""}> Loans</label>`,
      "  </div>",
      "</div>",
    ].join("");
  }

  let tipIndex = 0;
  let editingCards = new Set();

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function timeSaved(months) {
    if (months >= 0.95) {
      const m = Math.round(months);
      return plural(m, "month");
    }
    const d = Math.max(1, Math.round(months * 30.4));
    return plural(d, "day");
  }

  function tipText(t, left) {
    const amt = `<strong>${escapeHtml(money(t.extra))}</strong> of your ${escapeHtml(money(left))} leftover`;
    const nm = `<strong>${escapeHtml(t.name || "")}</strong>`;
    const time = (m) => `<strong>${escapeHtml(timeSaved(m))}</strong>`;
    if (t.kind === "loan-extra") {
      const interest = t.interestSaved > 0 ? ` and save ${escapeHtml(money(t.interestSaved))} in interest` : "";
      if (t.paidOff) return `Use ${amt} this month to pay off ${nm} completely. That's ${time(t.monthsSaved)} sooner${interest}.`;
      return `Use ${amt} this month to pay extra on ${nm} and be done ${time(t.monthsSaved)} sooner${interest}.`;
    }
    if (t.kind === "loan-start") {
      return t.after <= 0
        ? `Use ${amt} this month to pay off ${nm} completely.`
        : `${nm} has no monthly payment. Use ${amt} this month to bring it down to <strong>${escapeHtml(money(t.after))}</strong>${/\.$/.test(money(t.after)) ? "" : "."}`;
    }
    if (t.kind === "goal-faster") {
      if (t.reached) return `Put ${amt} into ${nm} this month and you reach the goal right away.`;
      return `You put about ${escapeHtml(money(t.rate))} a month into ${nm}. Add ${amt} this month and reach it ${time(t.monthsSaved)} sooner (${t.pct}% of the goal).`;
    }
    if (t.kind === "goal") {
      if (t.reached) return `Put ${amt} into ${nm} this month and you reach the goal right away.`;
      return `Put ${amt} into ${nm} this month and you're at <strong>${t.pct}%</strong> of the goal.`;
    }
    return `Set aside ${amt} this month as a buffer for unexpected costs.`;
  }

  let tipTimer = null;
  const TIP_INTERVAL_MS = 8000;

  function refreshTipBox(direction) {
    const box = document.querySelector(".tip-box");
    if (!box) return;
    const { month, remaining } = totals();
    const html = renderTipBox(remaining, month);
    const wrap = document.createElement("div");
    wrap.innerHTML = html;
    const next = wrap.firstElementChild;
    if (!next) return;
    const body = next.querySelector(".tip-body");
    if (body && direction) {
      body.classList.add(direction === "back" ? "slide-back" : "slide-next");
      body.addEventListener("animationend", () => {
        body.classList.remove("slide-next", "slide-back");
      }, { once: true });
    }
    box.replaceWith(next);
  }

  function restartTipTimer() {
    clearInterval(tipTimer);
    tipTimer = setInterval(() => {
      const box = document.querySelector(".tip-box");
      if (!box || box.matches(":hover") || document.hidden) return;
      if (!box.querySelector('[data-action="next-tip"]')) return;
      tipIndex += 1;
      refreshTipBox("next");
    }, TIP_INTERVAL_MS);
  }

  function renderTipBox(remaining, month) {
    let body;
    let count = 0;
    if (remaining < 0) {
      const biggest = (month.expenses || [])
        .map((r) => ({ name: r.name, v: Calc.parseAmount(r.amount) }))
        .sort((a, b) => b.v - a.v)[0];
      body = `You're <strong>${escapeHtml(money(Math.abs(remaining)))}</strong> short this month.${
        biggest && biggest.v > 0 ? ` Your biggest expense is <strong>${escapeHtml(biggest.name || "unnamed")}</strong> at ${escapeHtml(money(biggest.v))}.` : ""
      }`;
    } else {
      const tips = Calc.leftoverTips(remaining, state.loans, state.goals);
      count = tips.length;
      if (!count) {
        body = remaining <= 0
          ? "You don't have any money left this month to pay extra. Tips come back when there's something left."
          : `You only have <strong>${escapeHtml(money(remaining))}</strong> left this month. That's too little to pay extra, so keep it as a small buffer.`;
      }
      if (!count) {
        // handled above
      } else {
      if (tipIndex === 1e9) tipIndex = count - 1;
      if (tipIndex >= count) tipIndex = 0;
      body = tipText(tips[tipIndex], remaining);
      }
    }
    return [
      '<div class="tip-box">',
      '  <div class="tip-badge" aria-hidden="true">💡</div>',
      '  <div class="tip-main">',
      '  <div class="tip-head"><span class="tip-title"><span class="tip-ico">💡 </span>Tip<span class="tip-this-month"> this month</span></span>',
      count > 1
        ? `<span class="tip-nav"><button class="tip-next" type="button" data-action="prev-tip" aria-label="Previous tip">‹ Back</button><span class="tip-count">${tipIndex + 1}/${count}</span><button class="tip-next" type="button" data-action="next-tip" aria-label="Next tip">Next ›</button></span>`
        : "",
      "  </div>",
      `  <p class="tip-body">${body}</p>`,
      "  </div>",
      "</div>",
    ].join("");
  }

  function renderBudget() {
    const { month, incomeTotal, expenseTotal, remaining, loanPayoff } = totals();
    const prev = previousMonthKey();
    const shortfall = remaining < 0;
    const hasAmounts = incomeTotal > 0 || expenseTotal > 0;
    const share =
      incomeTotal > 0 ? `${Math.round((expenseTotal / incomeTotal) * 100)}% of your income is allocated to expenses.` : "";
    const bars = Calc.expenseBars(
      loanPayoff > 0 ? month.expenses.concat([{ name: "Loans (monthly payoff)", amount: String(loanPayoff) }]) : month.expenses,
      state.currency
    );

    return [
      '<div class="page-head">',
      "  <div>",
      `    <p class="page-kicker ws-greet">Hi ${escapeHtml(profileName())}</p>`,
      `    <h1 class="page-title">${escapeHtml(Calc.monthTitle(state.selectedMonth))}</h1>`,
      "  </div>",
      '  <div class="page-head-right">',
      '  <div class="page-head-actions">',
      currencySelect(),
      prev
        ? `<button class="btn" type="button" data-action="copy-last">Copy ${escapeHtml(
            Calc.monthShortTitle(prev)
          )}</button>`
        : "",
      "  </div>",
      renderTipBox(remaining, month),
      "  </div>",
      "</div>",
      renderRemainHero(incomeTotal, expenseTotal, remaining),
      '<p class="lede">Plan one month at a time. Changing currency converts all your amounts at the current exchange rate. Your work is saved on this computer as you type.</p>',
      '<div class="metrics">',
      metric("Income", money(incomeTotal), "", "soft-green"),
      metric("Expenses", money(expenseTotal), "", "soft-red"),
      metric(
        shortfall ? "Shortfall" : "Remaining",
        money(Math.abs(remaining)),
        shortfall ? "Expenses exceed income" : "Income minus expenses",
        shortfall ? "soft-red" : ""
      ),
      "</div>",
      '<div class="grid-2">',
      entryCard("Income", "income", month.income, "Add income"),
      entryCard("Expenses", "expense", month.expenses, "Add expense", "Add as many expense categories as you need."),
      "</div>",
      hasAmounts
        ? [
            '<div class="grid-2">',
            '  <section class="card">',
            '    <h2 class="card-title">Income &amp; spending</h2>',
            Charts.columnChart(incomeTotal, expenseTotal, money),
            share ? `<p class="chart-note">${escapeHtml(share)}</p>` : "",
            "  </section>",
            '  <section class="card">',
            '    <h2 class="card-title">Where your money goes</h2>',
            bars.length ? Charts.horizontalBars(bars) : '<p class="empty">Add some expenses to see the breakdown.</p>',
            '    <div class="props">',
            `      <div class="prop"><span class="prop-label">Total expenses</span><span class="prop-value soft-red">−${escapeHtml(
              money(expenseTotal)
            )}</span></div>`,
            `      <div class="prop"><span class="prop-label">Left over</span><span class="prop-value ${
              shortfall ? "soft-red" : "soft-green"
            }">${escapeHtml(money(remaining))}${shortfall ? " · Shortfall" : ""}</span></div>`,
            "    </div>",
            '    <p class="chart-note" style="text-align:left">Total income minus total expenses.</p>',
            "  </section>",
            "</div>",
          ].join("")
        : '<p class="empty">Enter income and expenses to see your totals and charts.</p>',
    ].join("");
  }

  function metric(label, value, detail, valueClass) {
    return [
      '<div class="metric">',
      `  <div class="metric-label">${escapeHtml(label)}</div>`,
      `  <div class="metric-value${valueClass ? " " + valueClass : ""}">${escapeHtml(value)}</div>`,
      detail ? `<div class="metric-detail">${escapeHtml(detail)}</div>` : "",
      "</div>",
    ].join("");
  }

  function currencySelect() {
    const options = Defaults.CURRENCIES.map(
      (code) => `<option value="${code}"${code === state.currency ? " selected" : ""}>${code}</option>`
    ).join("");
    return [
      '<label class="field">',
      '<span class="field-label">Currency</span>',
      `<select class="select" data-action="currency" aria-label="Currency">${options}</select>`,
      conversionNote ? `<span class="currency-note">${escapeHtml(conversionNote)}</span>` : "",
      "</label>",
    ].join("");
  }

  function entryCard(title, kind, rows, addLabel, hint) {
    return [
      `<section class="card">`,
      '  <div class="section-head">',
      `    <h2 class="card-title">${escapeHtml(title)}</h2>`,
      `    <button class="btn btn-primary btn-small" type="button" data-action="add-row" data-kind="${kind}">${escapeHtml(
        addLabel
      )}</button>`,
      "  </div>",
      hint ? `<p class="hint">${escapeHtml(hint)}</p>` : "",
      '  <div class="row-list">',
      rows
        .map((row, index) => {
          return [
            `<div class="entry-row" data-id="${row.id}" data-kind="${kind}">`,
            `  <span class="drag-handle" draggable="true" data-kind="${kind}" data-id="${row.id}" title="Drag to move" role="button" aria-label="Move ${escapeHtml(row.name || title)}" tabindex="0">⋮⋮</span>`,
            `  <button type="button" class="ws-emoji" data-action="pick-icon" data-kind="${kind}" data-id="${row.id}" aria-label="Change icon for ${escapeHtml(row.name || title)}">${rowIcon(row, kind)}</button>`,
            `  <textarea class="input name-input" data-field="name" data-kind="${kind}" data-id="${row.id}" rows="2" aria-label="${escapeHtml(title)} ${index + 1} name">${escapeHtml(
              row.name
            )}</textarea>`,
            `  <input class="input amt-input" data-field="amount" data-kind="${kind}" data-id="${row.id}" value="${escapeHtml(
              row.amount
            )}" inputmode="numeric" aria-label="${escapeHtml(title)} ${index + 1} amount in ${state.currency}" />`,
            `  <button class="btn-icon" type="button" data-action="remove-row" data-kind="${kind}" data-id="${row.id}" aria-label="Remove ${escapeHtml(
              row.name || title
            )}">×</button>`,
            "</div>",
          ].join("");
        })
        .join(""),
      "  </div>",
      kind === "expense" && loanMonthlyTotal() > 0
        ? [
            '<div class="entry-row entry-row-auto">',
            '  <span></span>',
            '  <span class="ws-emoji" aria-hidden="true">🏦</span>',
            '  <input class="input" value="Loans (monthly payoff)" readonly aria-label="Loans monthly payoff, from the Loans tab" />',
            `  <input class="input amt-input" value="${escapeHtml(String(loanMonthlyTotal()))}" readonly inputmode="numeric" aria-label="Loans monthly payoff amount" />`,
            '  <span class="auto-tag" title="Updates automatically from the Loans tab">Auto</span>',
            "</div>",
          ].join("")
        : "",
      `  <div class="add-row"><button class="btn btn-quiet btn-small" type="button" data-action="add-row" data-kind="${kind}">Add another ${
        kind === "income" ? "income" : "expense"
      }</button></div>`,
      "</section>",
    ].join("");
  }

  function renderGoals() {
    const goals = state.goals || [];
    return [
      '<div class="page-head">',
      "  <div>",
      `    <p class="page-kicker ws-greet">Hi ${escapeHtml(profileName())}</p>`,
      '    <h1 class="page-title">Your goals</h1>',
      "  </div>",
      '  <div class="ws-head-actions">',
      currencySelect(),
      '    <button class="ws-add ws-desk-only" type="button" data-action="scroll-add">+ Add goal</button>',
      "  </div>",
      "</div>",
      '<p class="lede">Set a target, keep track of how much you have already saved, and log contributions along the way.</p>',
      '<section class="card" id="add-goal">',
      '  <h2 class="card-title">Add a goal</h2>',
      '  <div class="form-grid">',
      field("goal-name", "Name", "text", "Emergency fund"),
      field("goal-target", "Target", "amount", "50000"),
      field("goal-saved", "Already saved", "amount", "0"),
      field("goal-deadline", "Reach by (optional)", "date", ""),
      '    <div class="form-actions"><button class="btn btn-primary" type="button" data-action="add-goal">Add goal</button></div>',
      "  </div>",
      "</section>",
      '<div class="stack">',
      goals.length
        ? goals.map((goal, index) => renderGoalCard(goal, index)).join("")
        : '<p class="empty">No savings goals yet. Add one above to get started.</p>',
      "</div>",
    ].join("");
  }

  function deadlineNote(goal, saved, target) {
    if (!goal.deadline) return '<span class="muted">Optional. Pick a date to see how much to save each month.</span>';
    const need = Math.max(0, target - saved);
    const when = escapeHtml(Calc.formatDisplayDate(goal.deadline));
    if (need <= 0) return `<span class="ok">Goal reached. Nice work!</span>`;
    const end = new Date(goal.deadline + "T23:59:59");
    const now = new Date();
    if (isNaN(end)) return "";
    if (end < now) return `<span class="late">The date ${when} has passed. You still need ${escapeHtml(money(need))}.</span>`;
    const monthsLeft = Math.max(1, (end.getFullYear() - now.getFullYear()) * 12 + (end.getMonth() - now.getMonth()) + (end.getDate() >= now.getDate() ? 0 : -1) + 1);
    const perMonth = Math.ceil(need / monthsLeft);
    let line = `Save <strong>${escapeHtml(money(perMonth))}</strong> a month for ${escapeHtml(plural(monthsLeft, "month"))} to reach it by ${when}.`;
    const rate = Calc.monthlySavingRate(goal);
    if (rate > 0) {
      line += rate >= perMonth
        ? ` <span class="ok">You're on track at about ${escapeHtml(money(Math.round(rate)))} a month.</span>`
        : ` <span class="late">At your current ${escapeHtml(money(Math.round(rate)))} a month you'd need ${escapeHtml(plural(Math.ceil(need / rate), "month"))}.</span>`;
    }
    return line;
  }

  function renderGoalCard(goal, index) {
    const saved = Calc.goalSavedTotal(goal);
    const target = Calc.parseMoney(goal.target);
    const progress = Calc.goalProgress(goal);
    const contribs = goal.contributions || [];
    const featured = index === 0;
    return [
      `<article class="goal-card${featured ? " is-featured" : ""}${editingCards.has("goal:" + goal.id) ? " is-editing" : ""}" data-goal-id="${goal.id}">`,
      '  <div class="goal-top">',
      '    <div class="ws-goal-ident">',
      `      <span class="ws-emoji-badge" aria-hidden="true">${goalEmoji(goal.name)}</span>`,
      "      <div>",
      `      <h2 class="goal-name">${escapeHtml(goal.name || "Untitled goal")}</h2>`,
      `      <div class="goal-meta">${escapeHtml(money(saved))} of ${escapeHtml(money(target))}</div>`,
      "      </div>",
      "    </div>",
      '    <div class="goal-top-actions">',
      `    <button class="btn btn-quiet btn-small ws-edit-toggle" type="button" data-action="toggle-edit" data-kind="goal" data-id="${goal.id}">${editingCards.has("goal:" + goal.id) ? "Done" : "Edit"}</button>`,
      `    <button class="btn btn-quiet btn-small" type="button" data-action="remove-goal" data-id="${goal.id}">Remove</button>`,
      "    </div>",
      "  </div>",
      featured
        ? `<div class="ws-goal-hero">${largeGoalRing(progress)}<div class="ws-goal-saved"><div class="ws-goal-saved-amt">${escapeHtml(money(saved))}</div><div class="ws-goal-saved-of">of ${escapeHtml(money(target))}</div></div></div>`
        : "",
      featured
        ? ""
        : `<div class="ws-desk-progress ws-desk-only"><div class="progress-label"><span>Progress</span><span>${progress}%</span></div><div class="progress-track"><div class="progress-fill goal" style="width:${progress}%;background:${progressColour(progress)}"></div></div></div>`,
      goal.deadline ? `  <div class="deadline-note">${deadlineNote(goal, saved, target)}</div>` : "",
      `  <div class="ws-edit-block${editingCards.has("goal:" + goal.id) ? " is-open" : ""}">`,
      '  <div class="goal-amounts">',
      '    <label class="deadline-field"><span class="field-label">Target</span>',
      `      <input class="input input-sm amt-input" inputmode="numeric" data-gfield="target" data-goal="${goal.id}" value="${escapeHtml(goal.target)}" aria-label="Goal target in ${state.currency}" /></label>`,
      '    <label class="deadline-field"><span class="field-label">Saved before contributions</span>',
      `      <input class="input input-sm amt-input" inputmode="numeric" data-gfield="saved" data-goal="${goal.id}" value="${escapeHtml(goal.saved)}" aria-label="Amount already saved in ${state.currency}" /></label>`,
      "  </div>",
      '  <div class="goal-deadline-row">',
      '    <label class="deadline-field"><span class="field-label">Reach by</span>',
      `      <input class="input input-sm" type="date" data-gfield="deadline" data-goal="${goal.id}" value="${escapeHtml(goal.deadline || "")}" aria-label="Reach this goal by date" />`,
      "    </label>",
      goal.deadline ? `    <button class="btn btn-quiet btn-small" type="button" data-action="clear-deadline" data-id="${goal.id}">No date</button>` : "",
      "  </div>",
      '  <div class="progress-block">',
      '    <div class="progress-label">',
      "      <span>Progress</span>",
      `      <span>${progress}%</span>`,
      "    </div>",
      '    <div class="progress-track">',
      `      <div class="progress-fill goal" style="width:${progress}%;background:${progressColour(progress)}"></div>`,
      "    </div>",
      "  </div>",
      '  <div class="form-grid-3">',
      field(`contrib-date-${goal.id}`, "Date", "date", Calc.formatISODate(), { id: `contrib-date-${goal.id}` }),
      field(`contrib-amount-${goal.id}`, "Contribution", "amount", "", { id: `contrib-amount-${goal.id}` }),
      field(`contrib-note-${goal.id}`, "Note", "text", "Optional", { id: `contrib-note-${goal.id}` }),
      `    <div class="form-actions"><button class="btn btn-primary" type="button" data-action="add-contrib" data-id="${goal.id}">Add</button></div>`,
      "  </div>",
      contribs.length
        ? `<h3 class="subhead">Contributions</h3><ul class="contrib-list">${contribs
            .slice()
            .reverse()
            .map(
              (c) =>
                `<li class="contrib-edit">` +
                `<input class="input input-sm" type="date" data-cfield="date" data-goal="${goal.id}" data-cid="${c.id}" value="${escapeHtml(c.date)}" aria-label="Contribution date" />` +
                `<input class="input input-sm" data-cfield="note" data-goal="${goal.id}" data-cid="${c.id}" value="${escapeHtml(c.note || "")}" placeholder="Note" aria-label="Contribution note" />` +
                `<input class="input input-sm contrib-amt" inputmode="numeric" data-cfield="amount" data-goal="${goal.id}" data-cid="${c.id}" value="${escapeHtml(c.amount)}" aria-label="Contribution amount in ${state.currency}" />` +
                `<button class="btn-icon" type="button" data-action="remove-contrib" data-id="${goal.id}" data-cid="${c.id}" aria-label="Remove contribution">×</button>` +
                `</li>`
            )
            .join("")}</ul>`
        : "",
      "  </div>",
      "</article>",
    ].join("");
  }

  function renderLoans() {
    const loans = state.loans || [];
    const debt = Calc.totalDebt(loans);
    const starting = Calc.totalStartingDebt(loans);
    const paid = Calc.roundMoney(Math.max(0, starting - debt));
    const paidPct = starting > 0 ? Math.min(100, Math.round((paid / starting) * 1000) / 10) : 0;
    return [
      '<div class="page-head">',
      "  <div>",
      `    <p class="page-kicker ws-greet">Hi ${escapeHtml(profileName())}</p>`,
      '    <h1 class="page-title">Loans</h1>',
      "  </div>",
      '  <div class="ws-head-actions">',
      currencySelect(),
      '    <button class="ws-add ws-desk-only" type="button" data-action="scroll-add">+ Add loan</button>',
      "  </div>",
      "</div>",
      renderLoanHero(loans, debt, starting, paid, paidPct),
      '<p class="lede">Add each loan, log what you pay, and see how much is left, how far you have come, and when you should be free of it.</p>',
      '<div class="metrics">',
      metric("Total debt", money(debt), loans.length ? `${loans.length} loan${loans.length === 1 ? "" : "s"}` : "No loans yet"),
      metric("Monthly payoff", money(loanMonthlyTotal()), "Added to Expenses in Budget", "soft-red"),
      debtFreeMetric(loans),
      [
        '<div class="metric metric-stacked">',
        '  <div class="metric-half">',
        '    <div class="metric-label">Paid off so far</div>',
        `    <div class="metric-value-sm">${escapeHtml(money(paid))}</div>`,
        starting > 0 ? `    <div class="metric-detail">${paidPct}% of the original balances</div>` : "",
        "  </div>",
        '  <div class="metric-half">',
        '    <div class="metric-label">Original balances</div>',
        `    <div class="metric-value-sm">${escapeHtml(money(starting))}</div>`,
        "  </div>",
        "</div>",
      ].join(""),
      "</div>",
      '<section class="card" id="add-loan">',
      '  <h2 class="card-title">Add a loan</h2>',
      '  <div class="form-grid">',
      field("loan-name", "Name", "text", "Car loan"),
      field("loan-balance", "Starting balance", "amount", "85000"),
      field("loan-rate", "Interest rate %", "decimal", "4.5"),
      field("loan-payment", "Monthly payment", "amount", "2500"),
      "  </div>",
      '  <div class="form-grid" style="margin-top:10px">',
      field("loan-start", "Start date", "date", Calc.formatISODate()),
      '    <div class="form-actions"><button class="btn btn-primary" type="button" data-action="add-loan">Add loan</button></div>',
      "  </div>",
      "</section>",
      '<div class="stack">',
      loans.length ? loans.map(renderLoanCard).join("") : '<p class="empty">No loans yet. Add one above to track payoff progress.</p>',
      "</div>",
    ].join("");
  }

  function debtFreeInfo(loans) {
    const active = loans.filter((loan) => Calc.currentLoanBalance(loan) > 0);
    if (!loans.length) return { value: "—", detail: "No loans yet", tone: "" };
    if (!active.length) return { value: "0", detail: "You are debt-free", tone: "soft-green" };
    let months = 0;
    let date = null;
    const skipped = [];
    for (const loan of active) {
      const est = Calc.estimatePayoff(loan);
      if (est.never) {
        skipped.push(`${loan.name || "A loan"} (${String(est.reason || "no payoff").replace(/\.$/, "").toLowerCase()})`);
        continue;
      }
      if (est.months > months) {
        months = est.months;
        date = est.date;
      }
    }
    const note = skipped.length ? ` · Not counted: ${skipped.join(", ")}` : "";
    if (!date) return { value: "—", detail: `No loan has a payoff date yet${note}`, tone: "" };
    return { value: formatDebtFree(months, date), detail: `Debt-free ${Calc.formatPayoffDate(date)}${note}`, tone: "soft-green", months, date, note };
  }

  function nextPayoffInfo(loans) {
    let best = null;
    for (const loan of loans) {
      if (Calc.currentLoanBalance(loan) <= 0) continue;
      const est = Calc.estimatePayoff(loan);
      if (est.never || !est.date) continue;
      if (!best || est.date < best.date) best = { loan, date: est.date };
    }
    if (!best) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const end = new Date(best.date.getTime());
    end.setHours(0, 0, 0, 0);
    const days = Math.max(0, Math.round((end - today) / 86400000));
    return { name: best.loan.name || "A loan", days, when: Calc.formatPayoffDate(best.date) };
  }

  function getDebtUnit() {
    try {
      const unit = window.localStorage.getItem("debtFreeUnit");
      return unit === "days" || unit === "years" ? unit : "months";
    } catch (e) {
      return "months";
    }
  }

  function setDebtUnit(unit) {
    try {
      window.localStorage.setItem("debtFreeUnit", unit);
    } catch (e) {}
    renderAll();
  }

  function debtUnitTitle() {
    const unit = getDebtUnit();
    return unit === "days" ? "Days to debt-free" : unit === "years" ? "Years to debt-free" : "Months to debt-free";
  }

  function formatDebtFree(months, date) {
    const unit = getDebtUnit();
    if (unit === "days") {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const end = new Date(date.getTime());
      end.setHours(0, 0, 0, 0);
      return new Intl.NumberFormat().format(Math.max(0, Math.round((end - today) / 86400000)));
    }
    if (unit === "years") {
      return new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(months / 12);
    }
    return String(months);
  }

  function debtUnitToggle() {
    const unit = getDebtUnit();
    return [
      '<div class="unit-toggle" role="group" aria-label="Show as">',
      ["days", "months", "years"]
        .map(
          (u) =>
            `<button type="button" class="unit-btn${u === unit ? " is-on" : ""}" data-action="debt-unit" data-unit="${u}" aria-pressed="${
              u === unit
            }">${u.charAt(0).toUpperCase() + u.slice(1)}</button>`
        )
        .join(""),
      "</div>",
    ].join("");
  }

  function renderLoanSidebar() {
    const loans = state.loans || [];
    const info = debtFreeInfo(loans);
    return [
      '<aside class="sidebar loan-sidebar" aria-label="Debt-free countdown">',
      renderProfileSwitcher(),
      '  <div class="sidebar-title">Debt-free</div>',
      '  <div class="debtfree-card">',
      `    <div class="debtfree-label">${escapeHtml(debtUnitTitle())}</div>`,
      debtUnitToggle(),
      `    <div class="debtfree-value${info.tone ? " " + info.tone : ""}">${escapeHtml(info.value)}</div>`,
      `    <div class="debtfree-detail">${escapeHtml(info.detail)}</div>`,
      "  </div>",
      '  <div class="debtfree-mini">',
      `    <div><span>Total debt</span><strong>${escapeHtml(money(Calc.totalDebt(loans)))}</strong></div>`,
      `    <div><span>Monthly payoff</span><strong class="soft-red">${escapeHtml(money(loanMonthlyTotal()))}</strong></div>`,
      "  </div>",
      nextPayoffCard(loans, false),
      renderSidebarTools(),
      '  <div class="sidebar-footer">',
      renderThemeSelect("sidebar-theme"),
      renderSyncChip("sidebar"),
      "  </div>",
      "</aside>",
    ].join("");
  }

  function debtFreeMetric(loans) {
    const info = debtFreeInfo(loans);
    return metric(debtUnitTitle(), info.value, info.detail, info.tone);
  }

  function suggestionNote(loan, balance) {
    if (balance <= 0) return "";
    const tip = Calc.suggestExtraPayment(loan);
    if (!tip) return "";
    const interest = tip.interestSaved >= 1 ? ` and save about ${money(Math.round(tip.interestSaved))} in interest` : "";
    const text = `Pay ${money(tip.extra)} extra each month to finish in ${tip.months} months (${Calc.formatPayoffDate(tip.date)}), ${tip.monthsSaved} months sooner${interest}.`;
    const options = Calc.extraPaymentOptions(loan);
    const hasInterest = options.some((o) => o.interestSaved >= 1);
    const table = options.length
      ? [
          '<div class="suggestion-pop" role="tooltip">',
          '  <div class="suggestion-pop-title">More ways to pay it off faster</div>',
          '  <table class="suggestion-table"><thead><tr>',
          "<th>Extra / month</th><th>You pay</th><th>Months left</th><th>Paid off</th><th>Sooner</th>",
          hasInterest ? "<th>Interest saved</th>" : "",
          "</tr></thead><tbody>",
          options
            .map(
              (o) =>
                `<tr class="${o.extra === tip.extra ? "is-pick" : ""}"><td>+${escapeHtml(money(o.extra))}</td><td>${escapeHtml(
                  money(o.monthly)
                )}</td><td>${o.months}</td><td>${escapeHtml(Calc.formatPayoffDate(o.date))}</td><td>${o.monthsSaved} mo</td>${
                  hasInterest ? `<td>${escapeHtml(money(Math.round(o.interestSaved)))}</td>` : ""
                }</tr>`
            )
            .join(""),
          "</tbody></table>",
          "</div>",
        ].join("")
      : "";
    return `<div class="suggestion-wrap" tabindex="0"><p class="suggestion-note"><strong>Suggestion:</strong> ${escapeHtml(
      text
    )}${options.length ? ' <span class="suggestion-more">Hover for more</span>' : ""}</p>${table}</div>`;
  }

  /** Red under 30%, orange 30–70%, then light green deepening to dark green at 100%. */
  function progressColour(pct) {
    const theme = resolvedTheme();
    if (pct < 30) return theme === "dark" ? "#E5736B" : theme === "bright" ? "#DC2626" : "#C2554C";
    if (pct < 70) return theme === "dark" ? "#E8A25A" : theme === "bright" ? "#F97316" : "#D9823B";
    const t = Math.min(1, (pct - 70) / 30);
    const light = theme === "dark" ? [168, 224, 150] : [134, 207, 104];
    const dark = theme === "dark" ? [74, 168, 88] : [22, 101, 52];
    const mix = light.map((c, i) => Math.round(c + (dark[i] - c) * t));
    return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
  }

  function renderLoanCard(loan) {
    const balance = Calc.currentLoanBalance(loan);
    const starting = Calc.parseMoney(loan.startingBalance);
    const paid = Calc.roundMoney(Math.max(0, starting - balance));
    const progress = starting > 0 ? Math.min(100, Math.round((paid / starting) * 1000) / 10) : 0;
    const estimate = Calc.estimatePayoff(loan);
    let payoffText;
    if (balance <= 0) payoffText = "This loan is paid off.";
    else if (estimate.never) payoffText = `No estimated payoff date. ${estimate.reason}.`;
    else {
      const months = estimate.months;
      const when = Calc.formatPayoffDate(estimate.date);
      payoffText = `Estimated payoff ${when} · ${months} month${months === 1 ? "" : "s"} left`;
    }
    const payments = loan.payments || [];
    let bigMonths;
    if (balance <= 0) bigMonths = `<div class="loan-months is-done"><span class="loan-months-num" style="color:${progressColour(100)}">0</span><span class="loan-months-label">Paid off</span></div>`;
    else if (estimate.never) bigMonths = '<div class="loan-months"><span class="loan-months-num">—</span><span class="loan-months-label">months left</span></div>';
    else bigMonths = `<div class="loan-months"><span class="loan-months-num" style="color:${progressColour(progress)}">${estimate.months}</span><span class="loan-months-label">month${estimate.months === 1 ? "" : "s"} left</span></div>`;
    const editing = editingCards.has("loan:" + loan.id);
    return [
      `<article class="loan-card${editing ? " is-editing" : ""}" data-loan-id="${loan.id}">`,
      '  <div class="loan-top">',
      '    <div class="ws-goal-ident">',
      `      <span class="ws-emoji-badge" aria-hidden="true">${loanEmoji(loan.name)}</span>`,
      "      <div>",
      `      <h2 class="loan-name">${escapeHtml(loan.name || "Untitled loan")}</h2>`,
      `      <div class="loan-meta">${escapeHtml(money(paid))} paid of ${escapeHtml(money(starting))}</div>`,
      "      </div>",
      "    </div>",
      '    <div class="loan-top-right">',
      bigMonths,
      '    <div class="goal-top-actions">',
      `    <button class="btn btn-quiet btn-small ws-edit-toggle" type="button" data-action="toggle-edit" data-kind="loan" data-id="${loan.id}">${editing ? "Done" : "Edit"}</button>`,
      `    <button class="btn btn-quiet btn-small" type="button" data-action="remove-loan" data-id="${loan.id}">Remove</button>`,
      "    </div>",
      "    </div>",
      "  </div>",
      '  <div class="progress-block">',
      '    <div class="progress-label"><span>Payoff progress</span><span>' + progress + "%</span></div>",
      `    <div class="progress-track"><div class="progress-fill loan" style="width:${progress}%;background:${progressColour(progress)}"></div></div>`,
      "  </div>",
      '<div class="loan-stats">',
      stat("Remaining", money(balance), balance > 0 ? "" : "soft-green"),
      stat("Interest rate", `${loan.interestRate || "0"}%`),
      stat("Monthly payment", money(Calc.parseMoney(loan.monthlyPayment))),
      stat("Starting balance", money(starting), "stat-minor"),
      "</div>",
      `<p class="payoff-line">${escapeHtml(payoffText)}</p>`,
      `  <div class="ws-edit-block${editing ? " is-open" : ""}">`,
      suggestionNote(loan, balance),
      '  <h3 class="subhead">Log a payment</h3>',
      '  <div class="form-grid-3 pay-row">',
      field(`pay-date-${loan.id}`, "Date", "date", Calc.formatISODate(), { id: `pay-date-${loan.id}` }),
      field(`pay-amount-${loan.id}`, "Amount", "amount", String(loan.monthlyPayment || ""), { id: `pay-amount-${loan.id}` }),
      "    <div></div>",
      `    <div class="form-actions"><button class="btn btn-primary" type="button" data-action="add-payment" data-id="${loan.id}">Log payment</button></div>`,
      "  </div>",
      payments.length
        ? `<h3 class="subhead">Payment history</h3><ul class="payment-list">${payments
            .slice()
            .reverse()
            .map((p) => {
              return `<li><span>${escapeHtml(Calc.formatDisplayDate(p.date))}</span><span class="split">${escapeHtml(
                money(p.amount)
              )} · interest ${escapeHtml(money(p.interestPortion))} · principal ${escapeHtml(
                money(p.principalPortion)
              )}<button class="btn-icon pay-x" type="button" data-action="remove-payment" data-id="${loan.id}" data-pid="${p.id}" aria-label="Remove payment" title="Remove payment">×</button></span></li>`;
            })
            .join("")}</ul>`
        : "",
      "  </div>",
      "</article>",
    ].join("");
  }

  function stat(label, value, klass) {
    return `<div><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value${
      klass ? " " + klass : ""
    }">${escapeHtml(value)}</div></div>`;
  }

  function field(name, label, kind, placeholder, opts) {
    const id = (opts && opts.id) || name;
    const type = kind === "date" ? "date" : "text";
    const isAmt = kind === "amount" || (opts && opts.amount);
    const mode = isAmt ? "numeric" : kind === "decimal" ? "decimal" : "";
    const extra = mode ? ` inputmode="${mode}"` : "";
    const cls = isAmt ? "input amt-input" : "input";
    const ph = placeholder != null ? ` placeholder="${escapeHtml(placeholder)}"` : "";
    const val = kind === "date" && placeholder ? ` value="${escapeHtml(placeholder)}"` : "";
    return [
      '<label class="field">',
      `  <span class="field-label">${escapeHtml(label)}</span>`,
      `  <input class="${cls}" id="${escapeHtml(id)}" name="${escapeHtml(name)}" type="${type}"${extra}${ph}${val} />`,
      "</label>",
    ].join("");
  }

  function renderModal() {
    if (!modal) return "";
    const input = modal.input
      ? [
          '<label class="field modal-field">',
          `  <span class="field-label">${escapeHtml(modal.inputLabel || "Name")}</span>`,
          `  <input class="input" id="modal-input" name="modal-input" type="text" maxlength="60" placeholder="${escapeHtml(
            modal.inputPlaceholder || ""
          )}" value="${escapeHtml(modal.inputValue || "")}" autocomplete="off" />`,
          "</label>",
        ].join("")
      : "";
    return [
      '<div class="modal-backdrop" id="modal-backdrop">',
      '  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">',
      `    <h2 id="modal-title">${escapeHtml(modal.title)}</h2>`,
      modal.body ? `    <p>${escapeHtml(modal.body)}</p>` : "",
      input,
      '    <div class="modal-actions">',
      '      <button class="btn" type="button" data-action="close-modal">Cancel</button>',
      `      <button class="btn btn-primary" type="button" data-action="confirm-modal">${escapeHtml(
        modal.confirmLabel || "OK"
      )}</button>`,
      "    </div>",
      "  </div>",
      "</div>",
    ].join("");
  }

  function refreshBudgetSummaries() {
    if (state.activeTab !== "budget") return;
    const main = document.querySelector(".main-inner");
    if (!main) return;
    const focused = document.activeElement;
    const focusKey =
      focused && focused.dataset
        ? `${focused.dataset.kind || ""}:${focused.dataset.id || ""}:${focused.dataset.field || ""}:${focused.selectionStart || ""}`
        : null;
    const scroll = document.querySelector(".main").scrollTop;
    main.innerHTML = renderBudget();
    document.querySelector(".main").scrollTop = scroll;
    refreshSidebarDots();
    if (focusKey && focused && focused.dataset) {
      const next = document.querySelector(
        `[data-kind="${focused.dataset.kind}"][data-id="${focused.dataset.id}"][data-field="${focused.dataset.field}"]`
      );
      if (next) {
        focusInPlace(next);
        if (isAmountInput(next)) next.value = rawWhole(next.value) || next.value;
        try {
          const pos = Number(focused.selectionStart);
          if (Number.isFinite(pos)) next.setSelectionRange(pos, pos);
        } catch (err) {
          /* ignore */
        }
      }
    }
    decorateAmountInputs();
  }

  function refreshSidebarDots() {
    document.querySelectorAll(".month-btn").forEach((btn) => {
      const key = btn.dataset.month;
      const saved = Calc.monthHasData(state.months[key]);
      const existing = btn.querySelector(".dot");
      if (saved && !existing) {
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.setAttribute("aria-hidden", "true");
        btn.appendChild(dot);
      } else if (!saved && existing) {
        existing.remove();
      }
    });
  }

  /* ——— Actions ——— */

  function monthRows(kind) {
    const month = currentMonth();
    return kind === "income" ? month.income : month.expenses;
  }

  function addRow(kind) {
    const month = currentMonth();
    const id = Calc.nextIdFrom([...month.income, ...month.expenses]);
    const row = { id, name: kind === "income" ? "New income" : "New expense", amount: "0" };
    monthRows(kind).push(row);
    markDirty();
    renderAll();
    const input = document.querySelector(`.entry-row[data-id="${id}"] [data-field="name"]`);
    focusInPlace(input, { select: true, reveal: true });
  }

  function removeRow(kind, id) {
    const rows = monthRows(kind);
    const index = rows.findIndex((row) => String(row.id) === String(id));
    if (index >= 0) rows.splice(index, 1);
    markDirty();
    renderAll();
  }

  function moveRow(kind, fromId, toId, after) {
    const rows = monthRows(kind);
    const from = rows.findIndex((r) => String(r.id) === String(fromId));
    if (from < 0 || String(fromId) === String(toId)) return;
    const [row] = rows.splice(from, 1);
    let to = rows.findIndex((r) => String(r.id) === String(toId));
    if (to < 0) { rows.splice(from, 0, row); return; }
    if (after) to += 1;
    rows.splice(to, 0, row);
    markDirty();
    renderAll();
  }

  let dragInfo = null;
  function clearDropMarks() {
    document.querySelectorAll(".drop-before, .drop-after").forEach((el) => el.classList.remove("drop-before", "drop-after"));
  }
  function onDragStart(event) {
    if (pointerDrag || isPhone()) {
      event.preventDefault();
      return;
    }
    const handle = event.target.closest && event.target.closest(".drag-handle");
    if (!handle) return;
    dragInfo = { kind: handle.dataset.kind, id: handle.dataset.id };
    const row = handle.closest(".entry-row");
    if (row) {
      row.classList.add("dragging");
      try { event.dataTransfer.setDragImage(row, 20, 20); } catch (e) {}
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragInfo.id);
  }
  function dropTarget(event) {
    const row = event.target.closest && event.target.closest(".entry-row[data-id]");
    if (!row || !dragInfo || row.dataset.kind !== dragInfo.kind) return null;
    const rect = row.getBoundingClientRect();
    return { row, after: event.clientY > rect.top + rect.height / 2 };
  }
  function onDragOver(event) {
    const t = dropTarget(event);
    if (!t) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    clearDropMarks();
    t.row.classList.add(t.after ? "drop-after" : "drop-before");
  }
  function onDrop(event) {
    const t = dropTarget(event);
    clearDropMarks();
    if (!t) return;
    event.preventDefault();
    const info = dragInfo;
    dragInfo = null;
    moveRow(info.kind, info.id, t.row.dataset.id, t.after);
  }
  function onDragEnd() {
    if (pointerDrag) return;
    dragInfo = null;
    clearDropMarks();
    document.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
  }

  let pointerDrag = null;

  function usesPointerReorder(event) {
    if (event && event.pointerType && event.pointerType !== "mouse") return true;
    return isPhone();
  }

  function dropTargetFromPoint(x, y) {
    if (!pointerDrag) return null;
    const dragged = pointerDrag.row;
    const prev = dragged.style.pointerEvents;
    dragged.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y);
    dragged.style.pointerEvents = prev;
    const row = el && el.closest && el.closest(".entry-row[data-id]");
    if (!row || row.dataset.kind !== pointerDrag.kind) return null;
    if (String(row.dataset.id) === String(pointerDrag.id)) return null;
    const rect = row.getBoundingClientRect();
    return { row, after: y > rect.top + rect.height / 2 };
  }

  function autoScrollMain(clientY) {
    const main = document.querySelector(".main");
    if (!main) return;
    const rect = main.getBoundingClientRect();
    const edge = 56;
    if (clientY < rect.top + edge) main.scrollTop -= 18;
    else if (clientY > rect.bottom - edge) main.scrollTop += 18;
  }

  function endPointerDrag() {
    if (!pointerDrag) return;
    try {
      const handle = pointerDrag.handle;
      if (handle && handle.releasePointerCapture) handle.releasePointerCapture(pointerDrag.pointerId);
    } catch (err) {}
    document.body.classList.remove("is-row-dragging");
    document.querySelectorAll(".dragging").forEach((el) => el.classList.remove("dragging"));
    clearDropMarks();
    pointerDrag = null;
  }

  function onHandlePointerDown(event) {
    if (event.button != null && event.button !== 0) return;
    const handle = event.target.closest && event.target.closest(".drag-handle");
    if (!handle) return;
    if (handle.closest(".entry-row-auto")) return;
    if (!usesPointerReorder(event)) return;
    const row = handle.closest(".entry-row[data-id]");
    if (!row) return;
    event.preventDefault();
    pointerDrag = {
      kind: handle.dataset.kind,
      id: handle.dataset.id,
      pointerId: event.pointerId,
      startY: event.clientY,
      startX: event.clientX,
      row,
      handle,
      moved: false,
    };
    try { handle.setPointerCapture(event.pointerId); } catch (err) {}
    document.body.classList.add("is-row-dragging");
    row.classList.add("dragging");
  }

  function onHandlePointerMove(event) {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    event.preventDefault();
    const dy = event.clientY - pointerDrag.startY;
    const dx = event.clientX - pointerDrag.startX;
    if (Math.abs(dy) > 5 || Math.abs(dx) > 5) pointerDrag.moved = true;
    if (!pointerDrag.moved) return;
    autoScrollMain(event.clientY);
    clearDropMarks();
    const t = dropTargetFromPoint(event.clientX, event.clientY);
    if (t) t.row.classList.add(t.after ? "drop-after" : "drop-before");
  }

  function onHandlePointerUp(event) {
    if (!pointerDrag || event.pointerId !== pointerDrag.pointerId) return;
    const info = pointerDrag;
    const t = info.moved ? dropTargetFromPoint(event.clientX, event.clientY) : null;
    endPointerDrag();
    if (info.moved && t) moveRow(info.kind, info.id, t.row.dataset.id, t.after);
  }

  function onHandlePointerCancel(event) {
    if (!pointerDrag || (event && event.pointerId !== pointerDrag.pointerId)) return;
    endPointerDrag();
  }

  function updateRow(kind, id, field, value) {
    const row = monthRows(kind).find((r) => String(r.id) === String(id));
    if (!row) return;
    row[field] = value;
    markDirty();
    if (field === "amount" || field === "name") refreshBudgetSummaries();
  }

  function addMonth() {
    const result = Defaults.addNextMonth(state);
    state = result.state;
    markDirty();
    renderAll();
    showToast(`Added ${Calc.monthTitle(result.key)}`);
  }

  function copyLast() {
    const result = Defaults.copyLastMonth(state, state.selectedMonth);
    if (result.needsConfirm) {
      openModal({
        title: "Replace this month?",
        body: `This will overwrite ${Calc.monthTitle(state.selectedMonth)} with the rows from ${Calc.monthTitle(
          result.sourceKey
        )}.`,
        confirmLabel: "Replace",
        onConfirm: () => {
          const forced = Defaults.applyCopy(state, result.sourceKey, state.selectedMonth);
          state = forced.state;
          markDirty();
          renderAll();
        },
      });
      return;
    }
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    state = result.state;
    markDirty();
    renderAll();
    showToast(`Copied ${Calc.monthTitle(result.sourceKey)}`);
  }

  function addGoal() {
    const name = valueOf("goal-name").trim() || "New goal";
    const target = amountValueOf("goal-target");
    const saved = amountValueOf("goal-saved") || "0";
    const id = Calc.nextIdFrom(state.goals);
    const deadline = valueOf("goal-deadline") || "";
    state.goals.push({ id, name, target, saved, contributions: [], deadline });
    markDirty();
    renderAll();
  }

  function removeGoal(id) {
    openModal({
      title: "Remove this goal?",
      body: "The goal and its contributions will be deleted.",
      confirmLabel: "Remove",
      onConfirm: () => {
        state.goals = state.goals.filter((g) => String(g.id) !== String(id));
        markDirty();
        renderAll();
      },
    });
  }

  function addContribution(id) {
    const amount = amountValueOf(`contrib-amount-${id}`);
    if (Calc.parseMoney(amount) <= 0) {
      showToast("Enter a contribution amount.");
      return;
    }
    const goal = state.goals.find((g) => String(g.id) === String(id));
    if (!goal) return;
    const contribId = Calc.nextIdFrom(goal.contributions);
    goal.contributions.push({
      id: contribId,
      date: valueOf(`contrib-date-${id}`) || Calc.formatISODate(),
      amount,
      note: valueOf(`contrib-note-${id}`).trim(),
    });
    markDirty();
    renderAll();
  }

  function addLoan() {
    const name = valueOf("loan-name").trim() || "New loan";
    const startingBalance = amountValueOf("loan-balance");
    const interestRate = valueOf("loan-rate") || "0";
    const monthlyPayment = amountValueOf("loan-payment") || "0";
    const startDate = valueOf("loan-start") || Calc.formatISODate();
    if (Calc.parseMoney(startingBalance) <= 0) {
      showToast("Enter a starting balance.");
      return;
    }
    const id = Calc.nextIdFrom(state.loans);
    state.loans.push({
      id,
      name,
      startingBalance,
      interestRate,
      monthlyPayment,
      startDate,
      payments: [],
    });
    markDirty();
    renderAll();
  }

  function removeLoan(id) {
    openModal({
      title: "Remove this loan?",
      body: "The loan and its payment history will be deleted.",
      confirmLabel: "Remove",
      onConfirm: () => {
        state.loans = state.loans.filter((l) => String(l.id) !== String(id));
        markDirty();
        renderAll();
      },
    });
  }

  function addPayment(id) {
    const loan = state.loans.find((l) => String(l.id) === String(id));
    if (!loan) return;
    const amount = amountValueOf(`pay-amount-${id}`);
    const date = valueOf(`pay-date-${id}`) || Calc.formatISODate();
    const result = Calc.applyLoanPayment(loan, amount, date);
    if (!result.ok) {
      showToast(result.error);
      return;
    }
    const payId = Calc.nextIdFrom(loan.payments);
    loan.payments.push({ id: payId, ...result.payment });
    markDirty();
    renderAll();
  }

  function valueOf(id) {
    const el = document.getElementById(id) || document.querySelector(`[name="${id}"]`);
    return el ? el.value : "";
  }

  function openModal(next) {
    modal = next;
    renderAll();
  }

  function closeModal() {
    modal = null;
    renderAll();
  }

  function confirmModal() {
    const action = modal && modal.onConfirm;
    const value = modal && modal.input ? valueOf("modal-input") : undefined;
    modal = null;
    if (action) action(value);
    else renderAll();
  }

  function applyActiveProfile() {
    const profile = activeProfile();
    state = Defaults.normalizeState(profile && profile.data);
    Calc.roundAllAmounts(state);
    tipIndex = 0;
    modal = null;
    profileMenuOpen = false;
    conversionNote = "";
    restartTipTimer();
    renderAll();
  }

  async function switchProfile(id) {
    if (!store || (activeProfile() && String(activeProfile().id) === String(id))) {
      profileMenuOpen = false;
      renderAll();
      return;
    }
    await saveNow();
    const result = Profiles.setActive(store, id);
    if (!result.ok) {
      showToast(result.error);
      profileMenuOpen = false;
      renderAll();
      return;
    }
    store = result.store;
    applyActiveProfile();
    await saveNow();
    const name = activeProfile() && activeProfile().name;
    if (name) showToast("Switched to " + name);
  }

  function promptNewProfile() {
    profileMenuOpen = false;
    openModal({
      title: "New budget",
      body: "Give this budget a name. It starts empty, with only the current month.",
      input: true,
      inputLabel: "Name",
      inputPlaceholder: "e.g. Household",
      inputValue: "",
      confirmLabel: "Create",
      onConfirm: (name) => {
        const result = Profiles.addProfile(store, name);
        if (!result.ok) {
          showToast(result.error);
          renderAll();
          return;
        }
        store = result.store;
        applyActiveProfile();
        markDirty();
        showToast("Created " + result.profile.name);
      },
    });
  }

  function promptRenameProfile(id) {
    const profile = ((store && store.profiles) || []).find((item) => String(item.id) === String(id));
    if (!profile) return;
    profileMenuOpen = false;
    openModal({
      title: "Rename budget",
      body: "Choose a name for this budget.",
      input: true,
      inputLabel: "Name",
      inputValue: profile.name,
      confirmLabel: "Rename",
      onConfirm: (name) => {
        const result = Profiles.renameProfile(store, id, name);
        if (!result.ok) {
          showToast(result.error);
          renderAll();
          return;
        }
        store = result.store;
        markDirty();
        renderAll();
        showToast("Renamed to " + Profiles.cleanName(name));
      },
    });
  }

  function promptDeleteProfile(id) {
    const profile = ((store && store.profiles) || []).find((item) => String(item.id) === String(id));
    if (!profile) return;
    profileMenuOpen = false;
    if (!store || store.profiles.length <= 1) {
      showToast("You need at least one budget.");
      renderAll();
      return;
    }
    openModal({
      title: "Delete this budget?",
      body: "“" + profile.name + "” and all of its months, goals and loans will be deleted. This cannot be undone.",
      confirmLabel: "Delete",
      onConfirm: () => {
        const result = Profiles.deleteProfile(store, id);
        if (!result.ok) {
          showToast(result.error);
          renderAll();
          return;
        }
        store = result.store;
        applyActiveProfile();
        markDirty();
        showToast("Budget deleted");
      },
    });
  }

  function toggleTheme() {
    const current = resolvedTheme();
    state.theme = current === "dark" ? "light" : "dark";
    markDirty();
    applyTheme();
    const btn = document.querySelector("[data-action='toggle-theme']");
    if (btn) btn.textContent = resolvedTheme() === "dark" ? "Light mode" : "Dark mode";
  }

  function closeAuth() {
    authOpen = false;
    authDismissed = true;
    authError = "";
    renderAll();
  }

  function readAuthFields() {
    const emailEl = document.getElementById("sync-email");
    const passEl = document.getElementById("sync-password");
    if (emailEl) authEmail = emailEl.value.trim();
    return { email: authEmail, password: passEl ? passEl.value : "" };
  }

  function friendlyAuthError(err) {
    const msg = String((err && err.message) || err || "Something went wrong.");
    if (/invalid login/i.test(msg)) return "That email or password is not correct.";
    if (/already registered/i.test(msg)) return "That email already has an account. Try signing in.";
    if (/confirm/i.test(msg) || /not confirmed/i.test(msg)) {
      return "Please confirm your email first. Open the link we sent you, then sign in.";
    }
    return msg;
  }

  async function handleSignIn() {
    const { email, password } = readAuthFields();
    authError = "";
    authNotice = "";
    if (!email || !password) {
      authError = "Enter your email and password.";
      renderAll();
      return;
    }
    if (!window.BudgetSync) {
      authError = "Sync is not available.";
      renderAll();
      return;
    }
    authBusy = true;
    renderAll();
    try {
      await window.BudgetSync.signIn(email, password);
      authOpen = false;
      authDismissed = true;
      showToast("Signed in. Sync is on.");
    } catch (err) {
      authError = friendlyAuthError(err);
    }
    authBusy = false;
    renderAll();
  }

  async function handleSignUp() {
    const { email, password } = readAuthFields();
    authError = "";
    authNotice = "";
    if (!email || !password) {
      authError = "Enter an email and a password to create your account.";
      renderAll();
      return;
    }
    if (password.length < 6) {
      authError = "Use a password of at least 6 characters.";
      renderAll();
      return;
    }
    if (!window.BudgetSync) {
      authError = "Sync is not available.";
      renderAll();
      return;
    }
    authBusy = true;
    renderAll();
    try {
      const data = await window.BudgetSync.signUp(email, password);
      if (data && data.user && !data.session) {
        authNotice =
          "Account created. Check your email and click the confirmation link, then come back here to sign in. The email may take a minute to arrive.";
      } else {
        authOpen = false;
        authDismissed = true;
        showToast("Account created. Sync is on.");
      }
    } catch (err) {
      authError = friendlyAuthError(err);
    }
    authBusy = false;
    renderAll();
  }

  async function handleSignOut() {
    try {
      if (window.BudgetSync) await window.BudgetSync.signOut();
    } catch (err) {}
    authOpen = false;
    authDismissed = true;
    showToast("Signed out. This copy stays on this device.");
    renderAll();
  }

  async function applySyncedStore(next, updatedAt, opts) {
    if (opts && opts.fromCloud && (saveStatus === "unsaved" || saveStatus === "saving")) return;
    applyingRemote = true;
    const raw = updatedAt ? { ...next, updatedAt } : next;
    store = Profiles.normalizeStore(raw);
    const profile = Profiles.getActive(store);
    state = Defaults.normalizeState(profile && profile.data);
    if (!opts || !opts.silent) {
      navOpen = false;
      profileMenuOpen = false;
      renderAll();
    }
    try {
      await storage.save(store);
    } catch (err) {}
    applyingRemote = false;
  }

  function onClick(event) {
    if (event.target.id === "modal-backdrop") {
      closeModal();
      return;
    }
    if (event.target.id === "sync-backdrop") {
      closeAuth();
      return;
    }
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    switch (action) {
      case "tab":
        setTab(target.dataset.tab);
        break;
      case "save":
        saveNow();
        break;
      case "toggle-theme":
        toggleTheme();
        break;
      case "set-theme":
        state.theme = target.dataset.theme;
        markDirty();
        renderAll();
        break;
      case "select-month":
        selectMonth(target.dataset.month);
        break;
      case "debt-unit":
        setDebtUnit(target.dataset.unit);
        break;
      case "add-month":
        monthPickerOpen = false;
        navOpen = false;
        addMonth();
        break;
      case "open-month-picker":
        navOpen = false;
        monthPickerOpen = true;
        renderAll();
        break;
      case "close-month-picker":
        monthPickerOpen = false;
        renderAll();
        break;
      case "clear-deadline": {
        const goal = (state.goals || []).find((g) => String(g.id) === String(target.dataset.id));
        if (goal) {
          goal.deadline = "";
          markDirty();
          renderAll();
        }
        break;
      }
      case "remove-payment": {
        const loan = (state.loans || []).find((l) => String(l.id) === String(target.dataset.id));
        if (loan) {
          loan.payments = (loan.payments || []).filter((p) => String(p.id) !== String(target.dataset.pid));
          Calc.recomputeLoanPayments(loan);
          markDirty();
          renderAll();
          showToast("Payment removed");
        }
        break;
      }
      case "remove-contrib": {
        const goal = (state.goals || []).find((g) => String(g.id) === String(target.dataset.id));
        if (goal) {
          goal.contributions = (goal.contributions || []).filter((c) => String(c.id) !== String(target.dataset.cid));
          markDirty();
          renderAll();
        }
        break;
      }
      case "prev-tip":
        tipIndex = tipIndex > 0 ? tipIndex - 1 : 1e9;
        refreshTipBox("back");
        restartTipTimer();
        break;
      case "next-tip":
        tipIndex += 1;
        refreshTipBox("next");
        restartTipTimer();
        break;
      case "copy-last":
        copyLast();
        break;
      case "add-row":
        addRow(target.dataset.kind);
        break;
      case "remove-row":
        removeRow(target.dataset.kind, target.dataset.id);
        break;
      case "pick-icon":
        iconPicker = { kind: target.dataset.kind, id: target.dataset.id };
        renderAll();
        break;
      case "set-icon":
        setRowIcon(target.dataset.kind, target.dataset.id, target.dataset.icon);
        break;
      case "close-icon-picker":
        closeIconPicker();
        break;
      case "add-goal":
        addGoal();
        break;
      case "remove-goal":
        removeGoal(target.dataset.id);
        break;
      case "add-contrib":
        addContribution(target.dataset.id);
        break;
      case "add-loan":
        addLoan();
        break;
      case "remove-loan":
        removeLoan(target.dataset.id);
        break;
      case "add-payment":
        addPayment(target.dataset.id);
        break;
      case "close-modal":
        closeModal();
        break;
      case "confirm-modal":
        confirmModal();
        break;
      case "toggle-profiles":
        profileMenuOpen = !profileMenuOpen;
        renderAll();
        break;
      case "close-profiles":
        profileMenuOpen = false;
        renderAll();
        break;
      case "switch-profile":
        switchProfile(target.dataset.id);
        break;
      case "new-profile":
        promptNewProfile();
        break;
      case "rename-profile":
        promptRenameProfile(target.dataset.id);
        break;
      case "delete-profile":
        promptDeleteProfile(target.dataset.id);
        break;
      case "toggle-edit": {
        const key = (target.dataset.kind || "goal") + ":" + target.dataset.id;
        if (editingCards.has(key)) editingCards.delete(key);
        else editingCards.add(key);
        renderAll();
        break;
      }
      case "scroll-add": {
        const target = document.getElementById(state.activeTab === "loans" ? "add-loan" : "add-goal");
        if (target) target.scrollIntoView({ block: "start" });
        break;
      }
      case "toggle-nav":
        navOpen = !navOpen;
        renderAll();
        break;
      case "close-nav":
        navOpen = false;
        renderAll();
        break;
      case "open-sync":
        authOpen = true;
        authError = "";
        renderAll();
        break;
      case "close-sync":
        closeAuth();
        break;
      case "sync-signin":
        handleSignIn();
        break;
      case "sync-signup":
        handleSignUp();
        break;
      case "sync-signout":
        handleSignOut();
        break;
      default:
        break;
    }
  }

  function findContrib(el) {
    const goal = (state.goals || []).find((g) => String(g.id) === String(el.dataset.goal));
    if (!goal) return null;
    return (goal.contributions || []).find((c) => String(c.id) === String(el.dataset.cid)) || null;
  }

  function onAmountFocus(event) {
    const el = event.target;
    if (!isAmountInput(el) || el.readOnly) return;
    const raw = rawWhole(el.value);
    if (raw !== "" || el.value) el.value = raw;
    try { el.select(); } catch (err) {}
  }

  function onAmountBlur(event) {
    const el = event.target;
    if (!isAmountInput(el) || el.readOnly) return;
    const raw = rawWhole(el.value);
    if (el.dataset && el.dataset.field === "amount" && el.dataset.kind && el.dataset.id) {
      updateRow(el.dataset.kind, el.dataset.id, "amount", raw === "" ? "0" : raw);
      return;
    }
    if (el.dataset && el.dataset.gfield) {
      const goal = (state.goals || []).find((g) => String(g.id) === String(el.dataset.goal));
      if (goal && (el.dataset.gfield === "target" || el.dataset.gfield === "saved")) {
        goal[el.dataset.gfield] = raw === "" ? "0" : raw;
        markDirty();
        renderAll();
        return;
      }
    }
    if (el.dataset && el.dataset.cfield === "amount") {
      const c = findContrib(el);
      if (c) {
        c.amount = raw === "" ? "0" : c.amount;
        if (raw !== "") c.amount = raw;
        markDirty();
        renderAll();
        return;
      }
    }
    if (raw !== "") el.value = formatWhole(raw);
  }

  function onInput(event) {
    const el = event.target;
    if (el.dataset && el.dataset.cfield) {
      const c = findContrib(el);
      if (c && el.dataset.cfield !== "amount") {
        c[el.dataset.cfield] = el.value;
        markDirty();
      }
      return;
    }
    if (el.dataset && el.dataset.field && el.dataset.kind && el.dataset.id) {
      const value = el.dataset.field === "amount" ? (rawWhole(el.value) || el.value) : el.value;
      updateRow(el.dataset.kind, el.dataset.id, el.dataset.field, value);
    }
  }

  let conversionNote = "";

  async function changeCurrency(to, el) {
    const from = state.currency;
    if (to === from) return;
    if (el) el.disabled = true;
    let result = null;
    try {
      result = window.budgetAPI && window.budgetAPI.rate ? await window.budgetAPI.rate(from, to) : null;
    } catch (e) {
      result = null;
    }
    if (!result || !(result.rate > 0)) {
      conversionNote = `Could not get an exchange rate from ${from} to ${to}, so nothing was changed.`;
      renderAll();
      return;
    }
    state = Calc.convertAmounts(state, result.rate);
    Calc.roundAllAmounts(state);
    state.currency = to;
    const rateText = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(result.rate);
    conversionNote = `Converted from ${from} to ${to} at 1 ${from} = ${rateText} ${to}${
      result.live ? (result.date ? ` (rate from ${result.date})` : "") : " (saved rate, you seem to be offline)"
    }.`;
    markDirty();
    renderAll();
  }

  function onChange(event) {
    const el = event.target;
    if (el.dataset && el.dataset.gfield) {
      const goal = (state.goals || []).find((g) => String(g.id) === String(el.dataset.goal));
      if (goal) {
        let v = el.value;
        if (el.dataset.gfield === "target" || el.dataset.gfield === "saved") {
          const w = rawWhole(v);
          v = w === "" ? "0" : w;
        }
        goal[el.dataset.gfield] = v;
        markDirty();
        renderAll();
      }
      return;
    }
    if (el.dataset && el.dataset.cfield) {
      const c = findContrib(el);
      if (!c) return;
      if (el.dataset.cfield === "amount") {
        const w = rawWhole(el.value);
        c.amount = w === "" ? "0" : w;
      } else {
        c[el.dataset.cfield] = el.value;
      }
      markDirty();
      renderAll();
      return;
    }
    if (el.dataset && el.dataset.field === "amount" && el.dataset.kind && el.dataset.id) {
      const w = rawWhole(el.value);
      if (w !== "") el.value = w;
      updateRow(el.dataset.kind, el.dataset.id, "amount", w === "" ? "0" : w);
      return;
    }
    if (el.dataset && el.dataset.action === "theme") {
      state.theme = el.value;
      markDirty();
      applyTheme();
      return;
    }
    if (el.dataset && el.dataset.action === "widget-toggle") {
      setWidgetPref(el.dataset.widget, el.checked);
      return;
    }
    if (el.dataset && el.dataset.action === "currency") {
      changeCurrency(el.value, el);
    }
  }

  function onKey(event) {
    if (event.key === "Escape") {
      if (monthPickerOpen) {
        monthPickerOpen = false;
        renderAll();
        return;
      }
      if (iconPicker) {
        closeIconPicker();
        return;
      }
      if (modal) {
        closeModal();
        return;
      }
      if (authOpen) {
        closeAuth();
        return;
      }
      if (navOpen) {
        navOpen = false;
        renderAll();
        return;
      }
      if (profileMenuOpen) {
        profileMenuOpen = false;
        renderAll();
        return;
      }
    }
    if (event.key === "Enter" && authOpen && event.target && (event.target.id === "sync-email" || event.target.id === "sync-password")) {
      event.preventDefault();
      handleSignIn();
      return;
    }
    if (event.key === "Enter" && modal && modal.input && event.target && event.target.id === "modal-input") {
      event.preventDefault();
      confirmModal();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveNow();
    }
  }

  async function loadRequestedFixture() {
    const params = new URLSearchParams(window.location.search);
    if (params.get("fixture") !== "1") return null;
    try {
      const response = await fetch("../fixtures/screenshot-data.json");
      if (!response.ok) return null;
      return await response.json();
    } catch (err) {
      return null;
    }
  }

  async function init() {
    const fixture = await loadRequestedFixture();
    const raw = fixture || (await storage.load());
    const opened = Profiles.openRaw(raw, { existingName: "Morten", emptyName: "My budget" });
    store = opened.store;
    const stampedOnLoad = !store.updatedAt && window.BudgetSyncLogic;
    if (stampedOnLoad) store = window.BudgetSyncLogic.stamp(store);
    const profile = Profiles.getActive(store);
    const before = profile && profile.data && profile.data.months ? Object.keys(profile.data.months) : [];
    state = Defaults.normalizeState(profile && profile.data);
    const roundedOnLoad = Calc.roundAllAmounts(state);
    const params = new URLSearchParams(window.location.search);
    if (params.get("tab") === "goals" || params.get("tab") === "loans" || params.get("tab") === "budget") {
      state.activeTab = params.get("tab");
    }
    if (params.get("theme") === "light" || params.get("theme") === "dark") {
      state.theme = params.get("theme");
    }
    const created = Object.keys(state.months).some((key) => !before.includes(key));
    if (window.budgetAPI && window.budgetAPI.onSaveNow) window.budgetAPI.onSaveNow(() => saveNow());
    restartTipTimer();
    if (window.budgetAPI && window.budgetAPI.onTab) window.budgetAPI.onTab((tab) => setTab(tab));
    mediaQuery.addEventListener("change", () => {
      if (state.theme === "system") {
        applyTheme();
      }
    });
    document.getElementById("app").addEventListener("click", onClick);
    document.getElementById("app").addEventListener("input", onInput);
    document.getElementById("app").addEventListener("change", onChange);
    document.getElementById("app").addEventListener("focusin", onAmountFocus);
    document.getElementById("app").addEventListener("focusout", onAmountBlur);
    const appEl = document.getElementById("app");
    appEl.addEventListener("dragstart", onDragStart);
    appEl.addEventListener("dragover", onDragOver);
    appEl.addEventListener("drop", onDrop);
    appEl.addEventListener("dragend", onDragEnd);
    appEl.addEventListener("pointerdown", onHandlePointerDown);
    document.addEventListener("pointermove", onHandlePointerMove, { passive: false });
    document.addEventListener("pointerup", onHandlePointerUp);
    document.addEventListener("pointercancel", onHandlePointerCancel);
    document.addEventListener("keydown", onKey);
    renderAll();
    if (window.BudgetSync) {
      window.BudgetSync.init({
        getStore: () => store,
        setStore: (next, updatedAt, opts) => applySyncedStore(next, updatedAt, opts),
        backupLocal: () =>
          window.budgetAPI && window.budgetAPI.backupBeforeSync
            ? window.budgetAPI.backupBeforeSync()
            : Promise.resolve({ ok: true }),
        onChange: (snapshot) => {
          syncSnapshot = snapshot;
          refreshSyncChip();
          const isWeb = window.budgetAPI && window.budgetAPI.isWeb;
          if (snapshot.status === "signed-out" && isWeb && !authDismissed && !authOpen) {
            authOpen = true;
            renderAll();
          }
          if (snapshot.status === "synced" && snapshot.user && authOpen && !authNotice) {
            authOpen = false;
            authDismissed = true;
            renderAll();
          }
        },
      });
    }
    if (!raw || opened.migrated || opened.created || created || roundedOnLoad || stampedOnLoad) await saveNow();
    window.__budgetReady = true;
    window.__setTab = setTab;
    if (typeof window.__onBudgetReady === "function") window.__onBudgetReady();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
