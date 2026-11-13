(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./calc"));
  } else {
    root.BudgetDefaults = factory(root.BudgetCalc);
  }
})(typeof self !== "undefined" ? self : this, function (Calc) {
  "use strict";

  const DEFAULT_INCOME = [
    { id: 1, name: "Salary · take-home", amount: "0" },
    { id: 2, name: "Other income", amount: "0" },
  ];

  const DEFAULT_EXPENSES = [
    { id: 3, name: "Housing", amount: "0" },
    { id: 4, name: "Groceries", amount: "0" },
    { id: 5, name: "Utilities", amount: "0" },
    { id: 6, name: "Transport", amount: "0" },
    { id: 7, name: "Subscriptions", amount: "0" },
    { id: 8, name: "Leisure & other", amount: "0" },
  ];

  const SEED_MONTHS = ["2026-11", "2026-12"];
  const CURRENCIES = ["DKK", "EUR", "USD", "GBP", "SEK", "NOK"];

  function emptyMonth() {
    return {
      income: Calc.cloneEntries(DEFAULT_INCOME),
      expenses: Calc.cloneEntries(DEFAULT_EXPENSES),
    };
  }

  function seedMonths() {
    const months = {};
    SEED_MONTHS.forEach((key) => {
      months[key] = emptyMonth();
    });
    return months;
  }

  function defaultState() {
    return {
      version: 1,
      currency: "DKK",
      theme: "system",
      selectedMonth: null,
      activeTab: "budget",
      months: seedMonths(),
      goals: [],
      loans: [],
    };
  }

  function freshState(now) {
    const current = Calc.currentMonthKey(now);
    return {
      version: 1,
      currency: "DKK",
      theme: "system",
      selectedMonth: current,
      activeTab: "budget",
      months: { [current]: emptyMonth() },
      goals: [],
      loans: [],
    };
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isoNow(now) {
    if (now instanceof Date) return now.toISOString();
    if (typeof now === "string" && now) return now;
    return new Date().toISOString();
  }

  function isMonthKey(key) {
    return /^\d{4}-\d{2}$/.test(String(key || ""));
  }

  function sanitizeDeletedMonths(raw) {
    if (!isPlainObject(raw)) return {};
    const out = {};
    Object.keys(raw).forEach((key) => {
      if (!isMonthKey(key)) return;
      const value = raw[key];
      if (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value))) {
        out[key] = value.trim();
      }
    });
    return out;
  }

  function isMonthDeleted(deletedMonths, key) {
    return !!(deletedMonths && deletedMonths[key]);
  }

  function touchMonth(month, now) {
    if (!isPlainObject(month)) return month;
    return { ...month, updatedAt: isoNow(now) };
  }

  function sanitizeEntries(rows, fallback) {
    if (!Array.isArray(rows) || rows.length === 0) {
      return Calc.cloneEntries(fallback);
    }
    return rows.map((row, index) => {
      const entry = {
        id: Number.isFinite(Number(row && row.id)) ? Number(row.id) : index + 1,
        name: row && row.name != null ? String(row.name) : "",
        amount: row && row.amount != null ? String(row.amount) : "0",
      };
      const icon = Calc.sanitizeIcon(row && row.icon);
      if (icon) entry.icon = icon;
      return entry;
    });
  }

  function sanitizeContributions(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row, index) => ({
      id: Number.isFinite(Number(row && row.id)) ? Number(row.id) : index + 1,
      date: row && row.date ? String(row.date) : "",
      amount: row && row.amount != null ? String(row.amount) : "0",
      note: row && row.note != null ? String(row.note) : "",
    }));
  }

  function sanitizePayments(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row, index) => ({
      id: Number.isFinite(Number(row && row.id)) ? Number(row.id) : index + 1,
      date: row && row.date ? String(row.date) : "",
      amount: Number.isFinite(Number(row && row.amount)) ? Number(row.amount) : Calc.parseMoney(row && row.amount),
      interestPortion: Number(row && row.interestPortion) || 0,
      principalPortion: Number(row && row.principalPortion) || 0,
      balanceAfter: Number.isFinite(Number(row && row.balanceAfter)) ? Number(row.balanceAfter) : 0,
    }));
  }

  function normalizeState(raw, now) {
    const base = defaultState();
    const data = isPlainObject(raw) ? raw : {};
    const monthsIn = isPlainObject(data.months) ? data.months : {};
    const months = {};

    const deletedMonths = sanitizeDeletedMonths(data.deletedMonths);

    Object.keys(monthsIn).forEach((key) => {
      if (!isMonthKey(key)) return;
      if (isMonthDeleted(deletedMonths, key)) return;
      const month = isPlainObject(monthsIn[key]) ? monthsIn[key] : {};
      const nextMonth = {
        income: sanitizeEntries(month.income, DEFAULT_INCOME),
        expenses: sanitizeEntries(month.expenses, DEFAULT_EXPENSES),
      };
      if (month.includeLoanPayoff === false) nextMonth.includeLoanPayoff = false;
      if (typeof month.updatedAt === "string" && month.updatedAt.trim() && Number.isFinite(Date.parse(month.updatedAt))) {
        nextMonth.updatedAt = month.updatedAt.trim();
      }
      months[key] = nextMonth;
    });

    if (Object.keys(months).length === 0) {
      SEED_MONTHS.forEach((key) => {
        if (!isMonthDeleted(deletedMonths, key)) months[key] = emptyMonth();
      });
    }

    const current = Calc.currentMonthKey(now);
    if (!months[current] && !isMonthDeleted(deletedMonths, current)) months[current] = emptyMonth();

    if (Object.keys(months).length === 0) {
      // Every known month was tombstoned: open the next free month after the current one.
      let key = current;
      for (let i = 0; i < 24 && isMonthDeleted(deletedMonths, key); i += 1) {
        key = Calc.addMonthsToKey(key, 1);
      }
      if (!months[key]) months[key] = emptyMonth();
    }

    const currency = CURRENCIES.includes(data.currency) ? data.currency : "DKK";
    const theme = data.theme === "light" || data.theme === "dark" || data.theme === "bright" || data.theme === "system" ? data.theme : "system";
    const monthKeys = Object.keys(months).sort();
    const selectedMonth = monthKeys.includes(data.selectedMonth) ? data.selectedMonth : (months[current] ? current : monthKeys[monthKeys.length - 1]);
    const activeTab = data.activeTab === "goals" || data.activeTab === "loans" ? data.activeTab : "budget";

    const goals = Array.isArray(data.goals)
      ? data.goals.map((goal, index) => ({
          id: Number.isFinite(Number(goal && goal.id)) ? Number(goal.id) : index + 1,
          name: goal && goal.name != null ? String(goal.name) : "",
          target: goal && goal.target != null ? String(goal.target) : "0",
          saved: goal && goal.saved != null ? String(goal.saved) : "0",
          contributions: sanitizeContributions(goal && goal.contributions),
          deadline: goal && goal.deadline ? String(goal.deadline) : "",
        }))
      : [];

    const loans = Array.isArray(data.loans)
      ? data.loans.map((loan, index) => ({
          id: Number.isFinite(Number(loan && loan.id)) ? Number(loan.id) : index + 1,
          name: loan && loan.name != null ? String(loan.name) : "",
          startingBalance: loan && loan.startingBalance != null ? String(loan.startingBalance) : "0",
          interestRate: loan && loan.interestRate != null ? String(loan.interestRate) : "0",
          monthlyPayment: loan && loan.monthlyPayment != null ? String(loan.monthlyPayment) : "0",
          startDate: loan && loan.startDate ? String(loan.startDate) : "",
          payments: sanitizePayments(loan && loan.payments),
        }))
      : [];

    const out = {
      version: 1,
      currency,
      theme,
      selectedMonth,
      activeTab,
      months,
      goals,
      loans,
    };
    if (Object.keys(deletedMonths).length) out.deletedMonths = deletedMonths;
    return out;
  }

  function ensureCurrentMonth(state, now) {
    const next = {
      ...state,
      months: { ...state.months },
    };
    const current = Calc.currentMonthKey(now);
    const blocked = isMonthDeleted(state.deletedMonths, current);
    if (!next.months[current] && !blocked) {
      next.months[current] = emptyMonth();
    }
    return { state: next, created: !state.months[current] && !blocked, key: current };
  }

  function addNextMonth(state, now) {
    const key = Calc.nextMonthKey(Object.keys(state.months));
    if (state.months[key]) {
      return { state, key, created: false };
    }
    const months = { ...state.months, [key]: touchMonth(emptyMonth(), now) };
    const deletedMonths = { ...(state.deletedMonths || {}) };
    delete deletedMonths[key];
    const next = {
      ...state,
      months,
      selectedMonth: key,
    };
    if (Object.keys(deletedMonths).length) next.deletedMonths = deletedMonths;
    else delete next.deletedMonths;
    return { state: next, key, created: true };
  }

  function copyLastMonth(state, targetKey) {
    const keys = Object.keys(state.months).sort();
    const index = keys.indexOf(targetKey);
    if (index <= 0) {
      return { ok: false, error: "There is no earlier month to copy from.", state };
    }
    const sourceKey = keys[index - 1];
    const source = state.months[sourceKey];
    const target = state.months[targetKey];
    if (target && Calc.monthHasData(target)) {
      return { ok: false, needsConfirm: true, sourceKey, state, error: "This month already has amounts." };
    }
    return applyCopy(state, sourceKey, targetKey);
  }

  function applyCopy(state, sourceKey, targetKey) {
    const source = state.months[sourceKey];
    if (!source) {
      return { ok: false, error: "Could not find the earlier month.", state };
    }
    let nextId = 1;
    const remap = (rows) =>
      (rows || []).map((row) => {
        const entry = { id: nextId, name: row.name, amount: String(row.amount ?? "0") };
        const icon = Calc.sanitizeIcon(row && row.icon);
        if (icon) entry.icon = icon;
        nextId += 1;
        return entry;
      });
    const copied = {
      income: remap(source.income),
      expenses: remap(source.expenses),
    };
    if (source.includeLoanPayoff === false) copied.includeLoanPayoff = false;
    const next = {
      ...state,
      months: { ...state.months, [targetKey]: touchMonth(copied) },
      selectedMonth: targetKey,
    };
    return { ok: true, state: next, sourceKey, targetKey };
  }

  // Prefer the previous month, otherwise the next one.
  function nearestMonthKey(keys, removedKey) {
    const sorted = (keys || []).slice().sort();
    const index = sorted.indexOf(removedKey);
    if (index < 0) return sorted[sorted.length - 1] || null;
    return sorted[index - 1] || sorted[index + 1] || null;
  }

  function deleteMonth(state, key, now) {
    const keys = Object.keys((state && state.months) || {}).sort();
    if (!keys.includes(key)) {
      return { ok: false, error: "Could not find that month.", state };
    }
    if (keys.length <= 1) {
      return { ok: false, error: "You need to keep at least one month.", state };
    }
    const months = { ...state.months };
    delete months[key];
    const remaining = Object.keys(months).sort();
    const selected = state.selectedMonth === key || !remaining.includes(state.selectedMonth)
      ? nearestMonthKey(keys, key)
      : state.selectedMonth;
    const deletedMonths = { ...(state.deletedMonths || {}), [key]: isoNow(now) };
    return {
      ok: true,
      state: { ...state, months, deletedMonths, selectedMonth: selected },
      key,
      nextKey: selected,
    };
  }

  return {
    DEFAULT_INCOME,
    DEFAULT_EXPENSES,
    SEED_MONTHS,
    CURRENCIES,
    emptyMonth,
    seedMonths,
    defaultState,
    freshState,
    normalizeState,
    ensureCurrentMonth,
    addNextMonth,
    copyLastMonth,
    applyCopy,
    deleteMonth,
    nearestMonthKey,
    touchMonth,
    sanitizeDeletedMonths,
    isMonthDeleted,
    isoNow,
  };
});
