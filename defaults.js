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

    Object.keys(monthsIn).forEach((key) => {
      if (!/^\d{4}-\d{2}$/.test(key)) return;
      const month = isPlainObject(monthsIn[key]) ? monthsIn[key] : {};
      const nextMonth = {
        income: sanitizeEntries(month.income, DEFAULT_INCOME),
        expenses: sanitizeEntries(month.expenses, DEFAULT_EXPENSES),
      };
      if (month.includeLoanPayoff === false) nextMonth.includeLoanPayoff = false;
      months[key] = nextMonth;
    });

    if (Object.keys(months).length === 0) {
      SEED_MONTHS.forEach((key) => {
        months[key] = emptyMonth();
      });
    }

    const current = Calc.currentMonthKey(now);
    if (!months[current]) months[current] = emptyMonth();

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

    return {
      version: 1,
      currency,
      theme,
      selectedMonth,
      activeTab,
      months,
      goals,
      loans,
    };
  }

  function ensureCurrentMonth(state, now) {
    const next = {
      ...state,
      months: { ...state.months },
    };
    const current = Calc.currentMonthKey(now);
    if (!next.months[current]) {
      next.months[current] = emptyMonth();
    }
    return { state: next, created: !state.months[current], key: current };
  }

  function addNextMonth(state) {
    const key = Calc.nextMonthKey(Object.keys(state.months));
    if (state.months[key]) {
      return { state, key, created: false };
    }
    const next = {
      ...state,
      months: { ...state.months, [key]: emptyMonth() },
      selectedMonth: key,
    };
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
      months: { ...state.months, [targetKey]: copied },
      selectedMonth: targetKey,
    };
    return { ok: true, state: next, sourceKey, targetKey };
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
  };
});
