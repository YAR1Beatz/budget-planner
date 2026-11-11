(function () {
  "use strict";

  if (window.budgetAPI && window.budgetAPI.load) return;

  const KEY = "budget-planner-data";
  const FALLBACK_PER_DKK = { DKK: 1, EUR: 0.13377, GBP: 0.11176, NOK: 1.4201, SEK: 1.4703, USD: 0.15001 };

  window.budgetAPI = {
    isWeb: true,
    platform: "web",
    async load() {
      try {
        const raw = window.localStorage.getItem(KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (err) {
        return null;
      }
    },
    async save(data) {
      window.localStorage.setItem(KEY, JSON.stringify(data));
      return { ok: true };
    },
    async userDataPath() {
      return "browser";
    },
    async backupBeforeSync() {
      return { ok: true };
    },
    async rate(from, to) {
      if (from === to) return { rate: 1, live: true, date: null };
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(
          "https://api.frankfurter.app/latest?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to),
          { signal: controller.signal }
        );
        clearTimeout(timer);
        const json = await res.json();
        const rate = json && json.rates && Number(json.rates[to]);
        if (rate > 0) return { rate, live: true, date: json.date || null };
      } catch (err) {}
      const a = FALLBACK_PER_DKK[from];
      const b = FALLBACK_PER_DKK[to];
      if (a && b) return { rate: b / a, live: false, date: "2026-11-10" };
      return { rate: null, live: false, date: null };
    },
    onSaveNow() {},
    onTab() {},
  };

  if ("serviceWorker" in navigator && window.location.protocol !== "file:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => {});
    });
  }
})();
