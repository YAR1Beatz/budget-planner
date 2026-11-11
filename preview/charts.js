(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BudgetCharts = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function columnChart(income, expenses, format) {
    const max = Math.max(income, expenses, 1);
    const plot = 160;
    const incomeH = Math.max(10, Math.round((income / max) * plot));
    const expenseH = Math.max(10, Math.round((expenses / max) * plot));
    return [
      '<div class="column-chart" role="img" aria-label="Income against expenses">',
      '  <div class="column-chart-plot">',
      '    <div class="column">',
      '      <div class="column-stack">',
      `        <div class="column-value">${escapeHtml(format(income))}</div>`,
      `        <div class="column-bar income" style="height:${incomeH}px"></div>`,
      "      </div>",
      '      <div class="column-label">Income</div>',
      "    </div>",
      '    <div class="column">',
      '      <div class="column-stack">',
      `        <div class="column-value">${escapeHtml(format(expenses))}</div>`,
      `        <div class="column-bar expense" style="height:${expenseH}px"></div>`,
      "      </div>",
      '      <div class="column-label">Expenses</div>',
      "    </div>",
      "  </div>",
      "</div>",
    ].join("");
  }

  function horizontalBars(bars) {
    if (!bars.length) return "";
    const max = Math.max.apply(null, bars.map((b) => b.value).concat([1]));
    return [
      '<div class="bar-list" role="img" aria-label="Expenses by category">',
      bars
        .map((bar, i) => {
          const pct = Math.max(4, Math.round((bar.value / max) * 100));
          const tone = ["tone-terracotta", "tone-amber", "tone-olive"][i % 3];
          return [
            '<div class="bar-row">',
            '  <div class="bar-row-head">',
            `    <span class="bar-label">${escapeHtml(bar.label)}</span>`,
            `    <span class="bar-amount">${escapeHtml(bar.display)}</span>`,
            "  </div>",
            '  <div class="bar-track">',
            `    <div class="bar-fill ${tone}" style="width:${pct}%"></div>`,
            "  </div>",
            "</div>",
          ].join("");
        })
        .join(""),
      "</div>",
    ].join("");
  }

  return { columnChart, horizontalBars };
});
