(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BudgetSyncLogic = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function stamp(store, now) {
    const when =
      now instanceof Date ? now.toISOString() : typeof now === "string" && now ? now : new Date().toISOString();
    return { ...store, updatedAt: when };
  }

  function timeOf(value) {
    if (!value) return 0;
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : 0;
  }

  function substanceScore(store) {
    if (!store || !Array.isArray(store.profiles)) return 0;
    let score = 0;
    store.profiles.forEach((profile) => {
      score += 1;
      const data = profile && profile.data;
      if (!data) return;
      if (Array.isArray(data.goals)) score += data.goals.length * 2;
      if (Array.isArray(data.loans)) score += data.loans.length * 2;
      const months = data.months && typeof data.months === "object" ? data.months : {};
      Object.keys(months).forEach((key) => {
        const month = months[key] || {};
        const income = Array.isArray(month.income) ? month.income : [];
        const expenses = Array.isArray(month.expenses) ? month.expenses : [];
        income.concat(expenses).forEach((row) => {
          const amount = Number(String((row && row.amount) || "0").replace(",", "."));
          if (amount) score += 3;
        });
      });
    });
    return score;
  }

  function choose(localStore, cloudRow, opts) {
    if (!cloudRow || cloudRow.data == null) {
      return { source: "local", reason: "cloud-empty" };
    }
    const localTime = timeOf(localStore && localStore.updatedAt);
    const cloudTime = timeOf(cloudRow.updated_at);
    const firstSync = !!(opts && opts.firstSync);
    if (firstSync) {
      const localScore = substanceScore(localStore);
      const cloudScore = substanceScore(cloudRow.data);
      if (localScore > 0 && localScore > cloudScore) {
        return { source: "local", reason: "first-sync-keep-local" };
      }
    }
    if (cloudTime > localTime) return { source: "cloud", reason: "cloud-newer" };
    return { source: "local", reason: cloudTime === localTime ? "tie-keep-local" : "local-newer" };
  }

  return { stamp, timeOf, substanceScore, choose };
});
