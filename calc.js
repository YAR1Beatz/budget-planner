(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BudgetCalc = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function roundMoney(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function roundRate(n) {
    return Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
  }

  function parseNumericString(value) {
    if (value === null || value === undefined) return NaN;
    if (typeof value === "number") return value;
    let s = String(value).trim();
    if (!s) return NaN;
    s = s.replace(/\s/g, "").replace(/[^\d,.-]/g, "");
    if (!s || s === "-" || s === "." || s === ",") return NaN;
    const hasComma = s.includes(",");
    const hasDot = s.includes(".");
    if (hasComma && hasDot) {
      if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
        s = s.replace(/\./g, "").replace(",", ".");
      } else {
        s = s.replace(/,/g, "");
      }
    } else if (hasComma) {
      s = s.replace(",", ".");
    }
    return Number(s);
  }

  /** Budget amounts: blank, negative or invalid count as zero. Only positive values count. */
  function parseAmount(value) {
    const n = parseNumericString(value);
    return Number.isFinite(n) && n > 0 ? roundMoney(n) : 0;
  }

  /** Non-negative money (balances, targets, payments), zero allowed. */
  /** Round a stored amount to a whole number, keeping blanks and text as they are. */
  function wholeAmount(v) {
    if (v === null || v === undefined || v === "") return v;
    const n = parseNumericString(v);
    if (!Number.isFinite(n)) return v;
    const w = Math.round(n);
    return typeof v === "number" ? w : String(w);
  }

  /** Round every user money amount in state to whole numbers, in place. Returns true if anything changed. */
  function roundAllAmounts(state) {
    let changed = false;
    const fix = (obj, key) => {
      if (!obj || !(key in obj)) return;
      const next = wholeAmount(obj[key]);
      if (next !== obj[key]) {
        obj[key] = next;
        changed = true;
      }
    };
    Object.keys((state && state.months) || {}).forEach((key) => {
      const m = state.months[key] || {};
      (m.income || []).forEach((row) => fix(row, "amount"));
      (m.expenses || []).forEach((row) => fix(row, "amount"));
    });
    ((state && state.goals) || []).forEach((g) => {
      fix(g, "target");
      fix(g, "saved");
      (g.contributions || []).forEach((c) => fix(c, "amount"));
    });
    ((state && state.loans) || []).forEach((l) => {
      fix(l, "startingBalance");
      fix(l, "monthlyPayment");
      (l.payments || []).forEach((p) => fix(p, "amount"));
    });
    return changed;
  }

  /** Multiply every stored money amount by rate (used when switching currency). */
  function convertAmounts(state, rate) {
    const r = Number(rate);
    if (!Number.isFinite(r) || r <= 0) return state;
    const conv = (v) => {
      const n = parseNumericString(v);
      return Number.isFinite(n) ? String(Math.round(n * r)) : v;
    };
    const convNum = (v) => (Number.isFinite(Number(v)) ? roundMoney(Number(v) * r) : v);
    const months = {};
    Object.keys(state.months || {}).forEach((key) => {
      const m = state.months[key] || {};
      months[key] = {
        ...m,
        income: (m.income || []).map((row) => ({ ...row, amount: conv(row.amount) })),
        expenses: (m.expenses || []).map((row) => ({ ...row, amount: conv(row.amount) })),
      };
    });
    const goals = (state.goals || []).map((g) => ({
      ...g,
      target: conv(g.target),
      saved: conv(g.saved),
      contributions: (g.contributions || []).map((c) => ({ ...c, amount: conv(c.amount) })),
    }));
    const loans = (state.loans || []).map((l) => ({
      ...l,
      startingBalance: conv(l.startingBalance),
      monthlyPayment: conv(l.monthlyPayment),
      payments: (l.payments || []).map((p) => ({
        ...p,
        amount: convNum(p.amount),
        interestPortion: convNum(p.interestPortion),
        principalPortion: convNum(p.principalPortion),
        balanceAfter: convNum(p.balanceAfter),
      })),
    }));
    return { ...state, months, goals, loans };
  }

  function parseMoney(value) {
    const n = parseNumericString(value);
    return Number.isFinite(n) && n >= 0 ? roundMoney(n) : 0;
  }

  /** Interest rate as an annual percent; zero allowed, negatives become 0. */
  function parseRate(value) {
    const n = parseNumericString(value);
    return Number.isFinite(n) && n >= 0 ? roundRate(n) : 0;
  }

  function sumAmounts(rows) {
    const total = (rows || []).reduce((sum, row) => sum + parseAmount(row && row.amount), 0);
    return roundMoney(total);
  }

  function leftover(incomeTotal, expenseTotal) {
    return roundMoney(parseMoney(incomeTotal) - parseMoney(expenseTotal));
  }

  function currencyLocale(currency) {
    if (currency === "DKK" || currency === "SEK" || currency === "NOK") return "da-DK";
    return "en-GB";
  }

  function formatMoney(n, currency) {
    const code = currency || "DKK";
    const value = Number.isFinite(Number(n)) ? Number(n) : 0;
    try {
      return new Intl.NumberFormat(currencyLocale(code), {
        style: "currency",
        currency: code,
        maximumFractionDigits: 0,
        minimumFractionDigits: 0,
      }).format(Math.round(value));
    } catch (err) {
      return `${Math.round(value)} ${code}`;
    }
  }

  function formatPercent(n) {
    if (!Number.isFinite(n)) return "0%";
    return `${Math.round(n)}%`;
  }

  function monthTitle(key) {
    const parts = String(key || "").split("-");
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const names = [
      "January", "February", "March", "April", "May", "June",
      "July", "August", "September", "October", "November", "December",
    ];
    const name = names[month - 1];
    if (!name || !Number.isFinite(year)) return String(key || "");
    return `${name} ${year}`;
  }

  function monthShortTitle(key) {
    const parts = String(key || "").split("-");
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const name = names[month - 1];
    if (!name || !Number.isFinite(year)) return String(key || "");
    return `${name} ${year}`;
  }

  function currentMonthKey(now, timeZone) {
    const date = now ? new Date(now) : new Date();
    const tz = timeZone || "Europe/Copenhagen";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(date);
    const year = parts.find((p) => p.type === "year").value;
    const month = parts.find((p) => p.type === "month").value;
    return `${year}-${month}`;
  }

  function addMonthsToKey(key, count) {
    const parts = String(key).split("-");
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    if (!Number.isFinite(year) || !Number.isFinite(month)) return key;
    const date = new Date(Date.UTC(year, month - 1 + count, 1));
    const y = date.getUTCFullYear();
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }

  function nextMonthKey(keys) {
    const sorted = (keys || []).slice().sort();
    const latest = sorted[sorted.length - 1];
    if (!latest) return currentMonthKey();
    return addMonthsToKey(latest, 1);
  }

  function monthHasData(month) {
    if (!month) return false;
    const rows = [...(month.income || []), ...(month.expenses || [])];
    return rows.some((row) => parseAmount(row && row.amount) > 0);
  }

  function sanitizeIcon(value) {
    if (value == null) return "";
    const s = String(value).trim();
    if (!s || s.length > 16) return "";
    if (/[\u0000-\u001f<>]/.test(s)) return "";
    return s;
  }

  function cloneEntries(rows) {
    return (rows || []).map((row) => {
      const entry = {
        id: row.id,
        name: row.name,
        amount: String(row.amount ?? "0"),
      };
      const icon = sanitizeIcon(row && row.icon);
      if (icon) entry.icon = icon;
      return entry;
    });
  }

  function nextIdFrom(items, extra) {
    const ids = [];
    (items || []).forEach((item) => {
      if (item && Number.isFinite(Number(item.id))) ids.push(Number(item.id));
    });
    (extra || []).forEach((n) => {
      if (Number.isFinite(Number(n))) ids.push(Number(n));
    });
    return (ids.length ? Math.max.apply(null, ids) : 0) + 1;
  }

  function expenseBars(expenses, currency) {
    return (expenses || [])
      .map((row) => ({
        label: (row && row.name) || "Unnamed expense",
        value: parseAmount(row && row.amount),
      }))
      .filter((row) => row.value > 0)
      .sort((a, b) => b.value - a.value)
      .map((row) => ({
        label: row.label,
        value: row.value,
        display: formatMoney(row.value, currency),
      }));
  }

  function goalSavedTotal(goal) {
    const base = parseMoney(goal && goal.saved);
    const contrib = (goal && goal.contributions ? goal.contributions : []).reduce(
      (sum, c) => sum + parseMoney(c && c.amount),
      0
    );
    return roundMoney(base + contrib);
  }

  function goalProgress(goal) {
    const target = parseMoney(goal && goal.target);
    const saved = goalSavedTotal(goal);
    if (target <= 0) return saved > 0 ? 100 : 0;
    return Math.min(100, Math.round((saved / target) * 1000) / 10);
  }

  function currentLoanBalance(loan) {
    const starting = parseMoney(loan && loan.startingBalance);
    const payments = (loan && loan.payments) || [];
    if (!payments.length) return starting;
    const last = payments[payments.length - 1];
    if (last && Number.isFinite(Number(last.balanceAfter))) {
      return roundMoney(Math.max(0, Number(last.balanceAfter)));
    }
    return starting;
  }

  function applyLoanPayment(loan, amount, date) {
    const payment = parseMoney(amount);
    const balance = currentLoanBalance(loan);
    const rate = parseRate(loan && loan.interestRate);
    const monthlyRate = rate / 100 / 12;
    const interest = roundMoney(balance * monthlyRate);
    if (payment <= 0) {
      return {
        ok: false,
        error: "Enter a payment greater than zero.",
      };
    }
    if (balance <= 0) {
      return { ok: false, error: "This loan is already paid off." };
    }
    const applied = roundMoney(Math.min(payment, roundMoney(balance + interest)));
    const interestPortion = roundMoney(Math.min(interest, applied));
    const principalPortion = roundMoney(Math.max(0, applied - interestPortion));
    const balanceAfter = roundMoney(Math.max(0, balance - principalPortion));
    return {
      ok: true,
      payment: {
        date: date || formatISODate(new Date()),
        amount: applied,
        interestPortion,
        principalPortion,
        balanceAfter,
      },
    };
  }

  function recomputeLoanPayments(loan) {
    const old = (loan && loan.payments) || [];
    const temp = { ...loan, payments: [] };
    for (const p of old) {
      const r = applyLoanPayment(temp, p.amount, p.date);
      if (!r.ok) continue;
      temp.payments.push({ ...p, ...r.payment, amount: r.payment.amount });
    }
    loan.payments = temp.payments;
    return loan;
  }

  /**
   * Estimate payoff by simulating amortisation month by month from the
   * remaining balance, using the loan's interest rate and monthly payment.
   */
  function estimatePayoff(loan, fromDate) {
    const balance = currentLoanBalance(loan);
    const payment = parseMoney(loan && loan.monthlyPayment);
    const rate = parseRate(loan && loan.interestRate);
    const monthlyRate = rate / 100 / 12;
    const start = fromDate ? new Date(fromDate) : new Date();

    if (balance <= 0) {
      return { paidOff: true, never: false, months: 0, date: start, reason: null };
    }
    if (payment <= 0) {
      return { paidOff: false, never: true, months: null, date: null, reason: "No monthly payment set" };
    }
    if (monthlyRate > 0 && payment <= roundMoney(balance * monthlyRate)) {
      return {
        paidOff: false,
        never: true,
        months: null,
        date: null,
        reason: "Payment does not cover the interest",
      };
    }

    let remaining = balance;
    let months = 0;
    const maxMonths = 1200;
    while (remaining > 0.005 && months < maxMonths) {
      const interest = roundMoney(remaining * monthlyRate);
      const principal = roundMoney(Math.min(payment - interest, remaining));
      remaining = roundMoney(remaining - principal);
      months += 1;
    }
    if (remaining > 0.005) {
      return { paidOff: false, never: true, months: null, date: null, reason: "Payoff is too far in the future" };
    }
    const date = new Date(start.getTime());
    date.setMonth(date.getMonth() + months);
    return { paidOff: false, never: false, months, date, reason: null };
  }

  function simulatePayoff(balance, payment, monthlyRate) {
    let remaining = balance, months = 0, interestTotal = 0;
    while (remaining > 0.005 && months < 1200) {
      const interest = roundMoney(remaining * monthlyRate);
      if (payment <= interest) return null;
      interestTotal += interest;
      remaining = roundMoney(remaining - Math.min(payment - interest, remaining));
      months += 1;
    }
    return remaining > 0.005 ? null : { months, interest: roundMoney(interestTotal) };
  }

  /** Average amount added to a goal per month, from its dated contributions. */
  function monthlySavingRate(goal, now) {
    const rows = ((goal && goal.contributions) || []).filter((c) => parseMoney(c && c.amount) > 0 && c.date);
    if (!rows.length) return 0;
    const total = rows.reduce((sum, c) => sum + parseMoney(c.amount), 0);
    const first = rows.map((c) => new Date(c.date)).filter((d) => !isNaN(d)).sort((a, b) => a - b)[0];
    if (!first) return 0;
    const today = now ? new Date(now) : new Date();
    const span = (today.getFullYear() - first.getFullYear()) * 12 + (today.getMonth() - first.getMonth()) + 1;
    return total / Math.max(1, span);
  }

  /** Tips for using part of this month's leftover, best first. */
  /** Months (with a fraction for the last, partial month) and interest to pay off a balance. */
  function payoffFraction(balance, payment, monthlyRate) {
    let remaining = balance, months = 0, interestTotal = 0;
    while (remaining > 0.005 && months < 1200) {
      const interest = remaining * monthlyRate;
      if (payment <= interest) return null;
      interestTotal += interest;
      const principal = payment - interest;
      if (principal >= remaining) {
        months += (remaining + interest) / payment;
        remaining = 0;
        break;
      }
      remaining -= principal;
      months += 1;
    }
    return remaining > 0.005 ? null : { months, interest: interestTotal };
  }

  /** Tips for a one-time extra payment from this month's leftover, best first. */
  function leftoverTips(leftover, loans, goals) {
    const left = Number(leftover) || 0;
    const tips = [];
    if (left <= 0) return tips;
    // Use about half the leftover, rounded down to a tidy step, so the rest stays as a buffer.
    const half = left / 2;
    const step = half >= 5000 ? 1000 : half >= 1000 ? 500 : half >= 200 ? 100 : half >= 20 ? 10 : 1;
    const amount = Math.floor(half / step) * step;
    if (!(amount > 0)) return tips;
    const loanTips = [];
    (loans || []).forEach((loan) => {
      const balance = currentLoanBalance(loan);
      if (balance <= 0) return;
      const extra = Math.min(amount, Math.ceil(balance));
      const payment = parseMoney(loan && loan.monthlyPayment);
      const rate = parseRate(loan && loan.interestRate) / 100 / 12;
      const name = (loan && loan.name) || "your loan";
      if (payment <= 0) {
        const after = Math.max(0, Math.round(balance - extra));
        loanTips.push({ kind: "loan-start", name, extra, after, score: 1e6 + balance });
        return;
      }
      const base = payoffFraction(balance, payment, rate);
      if (!base) return;
      const after = balance - extra;
      const sim = after <= 0.005 ? { months: 0, interest: 0 } : payoffFraction(after, payment, rate);
      if (!sim) return;
      const monthsSaved = base.months - sim.months;
      if (monthsSaved <= 0.01) return;
      loanTips.push({
        kind: "loan-extra",
        name,
        extra,
        monthsSaved,
        paidOff: after <= 0.005,
        interestSaved: Math.round(Math.max(0, base.interest - sim.interest)),
        score: monthsSaved * 1000 + Math.max(0, base.interest - sim.interest) / 1000,
      });
    });
    loanTips.sort((a, b) => b.score - a.score);
    const goalTips = [];
    (goals || []).forEach((goal) => {
      const target = parseMoney(goal && goal.target);
      const saved = goalSavedTotal(goal);
      const need = target - saved;
      if (target <= 0 || need <= 0) return;
      const extra = Math.min(amount, Math.ceil(need));
      const name = (goal && goal.name) || "your goal";
      const rate = monthlySavingRate(goal);
      const reached = extra >= need;
      const pct = Math.min(100, Math.round(((saved + extra) / target) * 100));
      if (rate > 0) {
        goalTips.push({ kind: "goal-faster", name, extra, rate: Math.round(rate), monthsSaved: extra / rate, reached, pct });
      } else {
        goalTips.push({ kind: "goal", name, extra, reached, pct });
      }
    });
    // Alternate loan and savings tips so both show up early.
    const n = Math.max(loanTips.length, goalTips.length);
    for (let i = 0; i < n; i += 1) {
      if (loanTips[i]) tips.push(loanTips[i]);
      if (goalTips[i]) tips.push(goalTips[i]);
    }
    if (!tips.length) tips.push({ kind: "buffer", extra: amount });
    return tips;
  }

  /** Suggest a round extra monthly amount that clearly shortens the payoff. */
  /** Round amounts (1, 1.5, 2, 2.5, 3, 4, 5, 7.5 × powers of ten) so suggestions fit any currency. */
  function niceLadder() {
    const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5];
    const out = [];
    for (let exp = 0; exp <= 7; exp += 1) steps.forEach((x) => out.push(roundMoney(x * Math.pow(10, exp))));
    return out;
  }

  function suggestExtraPayment(loan, fromDate) {
    const balance = currentLoanBalance(loan);
    const payment = parseMoney(loan && loan.monthlyPayment);
    const monthlyRate = parseRate(loan && loan.interestRate) / 100 / 12;
    if (balance <= 0 || payment <= 0) return null;
    const base = simulatePayoff(balance, payment, monthlyRate);
    if (!base || base.months < 4) return null;
    const goal = Math.max(2, Math.round(base.months * 0.25));
    const extras = niceLadder().filter((x) => x >= payment * 0.03);
    for (const extra of extras) {
      const sim = simulatePayoff(balance, payment + extra, monthlyRate);
      if (sim && base.months - sim.months >= goal) {
        const start = fromDate ? new Date(fromDate) : new Date();
        const date = new Date(start.getTime());
        date.setMonth(date.getMonth() + sim.months);
        return {
          extra,
          months: sim.months,
          monthsSaved: base.months - sim.months,
          interestSaved: roundMoney(Math.max(0, base.interest - sim.interest)),
          date,
        };
      }
    }
    return null;
  }

  /** A spread of extra monthly amounts with their payoff effect. */
  function extraPaymentOptions(loan, fromDate) {
    const balance = currentLoanBalance(loan);
    const payment = parseMoney(loan && loan.monthlyPayment);
    const monthlyRate = parseRate(loan && loan.interestRate) / 100 / 12;
    if (balance <= 0 || payment <= 0) return [];
    const base = simulatePayoff(balance, payment, monthlyRate);
    if (!base || base.months < 2) return [];
    const all = niceLadder();
    const lo = payment * 0.08, hi = payment * 2;
    let pool = all.filter((x) => x >= lo && x <= hi);
    if (pool.length > 6) {
      const step = (pool.length - 1) / 5;
      pool = [0, 1, 2, 3, 4, 5].map((i) => pool[Math.round(i * step)]);
    }
    const start = fromDate ? new Date(fromDate) : new Date();
    const out = [];
    for (const extra of pool) {
      const sim = simulatePayoff(balance, payment + extra, monthlyRate);
      if (!sim) continue;
      const date = new Date(start.getTime());
      date.setMonth(date.getMonth() + sim.months);
      out.push({
        extra,
        monthly: roundMoney(payment + extra),
        months: sim.months,
        monthsSaved: base.months - sim.months,
        interestSaved: roundMoney(Math.max(0, base.interest - sim.interest)),
        date,
      });
      if (sim.months <= 1) break;
    }
    return out;
  }

  function formatPayoffDate(date) {
    if (!date) return "";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Copenhagen",
      month: "long",
      year: "numeric",
    }).format(date);
  }

  function formatISODate(date, timeZone) {
    const tz = timeZone || "Europe/Copenhagen";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date || new Date());
    const y = parts.find((p) => p.type === "year").value;
    const m = parts.find((p) => p.type === "month").value;
    const d = parts.find((p) => p.type === "day").value;
    return `${y}-${m}-${d}`;
  }

  function formatDisplayDate(iso) {
    if (!iso) return "";
    const parts = String(iso).split("-");
    const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
    if (Number.isNaN(date.getTime())) return String(iso);
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(date);
  }

  function totalDebt(loans) {
    return roundMoney((loans || []).reduce((sum, loan) => sum + currentLoanBalance(loan), 0));
  }

  function totalStartingDebt(loans) {
    return roundMoney((loans || []).reduce((sum, loan) => sum + parseMoney(loan && loan.startingBalance), 0));
  }

  return {
    roundMoney,
    parseAmount,
    parseMoney,
    parseRate,
    sumAmounts,
    leftover,
    formatMoney,
    recomputeLoanPayments,
    formatPercent,
    currencyLocale,
    monthTitle,
    monthShortTitle,
    currentMonthKey,
    addMonthsToKey,
    nextMonthKey,
    monthHasData,
    sanitizeIcon,
    cloneEntries,
    nextIdFrom,
    expenseBars,
    convertAmounts,
    wholeAmount,
    leftoverTips,
    monthlySavingRate,
    roundAllAmounts,
    goalSavedTotal,
    goalProgress,
    currentLoanBalance,
    applyLoanPayment,
    estimatePayoff,
    suggestExtraPayment,
    extraPaymentOptions,
    formatPayoffDate,
    formatISODate,
    formatDisplayDate,
    totalDebt,
    totalStartingDebt,
  };
});
