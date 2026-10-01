/* =========================================================
   VerifiedPulse — Chart Renderer (Chart.js)
   Responsive + label-visibility optimized
   All data comes from /api/metrics; no preloaded sample data.
   ========================================================= */
(function () {
  'use strict';

  if (typeof Chart === 'undefined') {
    console.error('Chart.js failed to load from CDN.');
    return;
  }

  // Shared palette (matches CSS variables)
  var COLORS = {
    navy:   '#0f1a41',
    blue:   '#0057b8',
    cyan:   '#2dd4bf',
    true:   '#22c55e',
    false:  '#ef4444',
    warn:   '#f59e0b',
    muted:  '#5b6478',
    purple: '#8b5cf6',
    pink:   '#ec4899'
  };

  // Detect small screen
  var isMobile = function () { return window.innerWidth < 768; };

  // Global Chart.js defaults
  Chart.defaults.font.family = "'Segoe UI', system-ui, sans-serif";
  Chart.defaults.color = COLORS.muted;
  Chart.defaults.responsive = true;
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.plugins.legend.display = false; // custom legends
  Chart.defaults.plugins.tooltip.backgroundColor = COLORS.navy;
  Chart.defaults.plugins.tooltip.titleColor = '#fff';
  Chart.defaults.plugins.tooltip.bodyColor = '#fff';
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;

  var CATEGORY_LABELS = {
    'likely-fabrication': 'Likely fabrication',
    'unsupported-claim': 'Unsupported claim',
    'possible-misinterpretation': 'Misinterpretation',
    'insufficient-evidence': 'Insufficient evidence',
    'uncorroborated-official': 'Uncorroborated official',
    'verified': 'Verified'
  };
  var CATEGORY_COLORS = {
    'likely-fabrication': '#ef4444',
    'unsupported-claim': '#f97316',
    'possible-misinterpretation': '#a855f7',
    'insufficient-evidence': '#f59e0b',
    'uncorroborated-official': '#2dd4bf',
    'verified': '#22c55e'
  };

  var SOURCE_COLORS = {
    'Government Agencies': '#22c55e',
    'International News': '#0057b8',
    'Scientific/Technical': '#f59e0b',
    'Fact-Checking Orgs': '#ef4444'
  };

  var RISK_LABELS = ['High Risk', 'Medium Risk', 'Low Risk'];
  var RISK_COLORS = [COLORS.false, COLORS.warn, COLORS.true];

  // Draws a centered placeholder when a chart has no data yet
  var emptyStatePlugin = {
    id: 'emptyState',
    afterDraw: function (chart) {
      var hasData = chart.data.datasets.some(function (ds) {
        return ds.data && ds.data.length > 0;
      });
      if (hasData) return;
      if (chart.canvas.height === 0 || chart.canvas.width === 0) return;
      var ctx = chart.ctx;
      var x = (chart.chartArea.left + chart.chartArea.right) / 2;
      var y = (chart.chartArea.top + chart.chartArea.bottom) / 2;
      ctx.save();
      ctx.fillStyle = COLORS.muted;
      ctx.font = "600 13px 'Segoe UI', system-ui, sans-serif";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data available yet', x, y);
      ctx.font = "11px 'Segoe UI', system-ui, sans-serif";
      ctx.fillText('Run a few fact-checks to populate this chart', x, y + 22);
      ctx.restore();
    }
  };
  Chart.register(emptyStatePlugin);

  var charts = {};
  var lastMetrics = null;

  function el(id) { return document.getElementById(id); }

  function legendItem(color, label) {
    return '<span class="chart-legend-item"><span class="chart-legend-dot" style="background:' +
      color + '"></span>' + label + '</span>';
  }

  function renderLegend(id, items) {
    var box = el(id);
    if (!box) return;
    box.innerHTML = items.map(function (it) { return legendItem(it[0], it[1]); }).join('');
  }

  function legendIntoCard(canvasId, items) {
    var canvas = el(canvasId);
    var card = canvas && canvas.closest ? canvas.closest('.card') : null;
    var box = card ? card.querySelector('.chart-legend') : null;
    if (!box) return;
    box.innerHTML = items.map(function (it) { return legendItem(it[0], it[1]); }).join('');
  }

  /* ---------- 1. TREND (Line + Area) ---------- */
  function buildTrend() {
    renderLegend('legendTrend', [[COLORS.blue, 'Total claims'], [COLORS.true, 'Verified']]);
    charts.trend = new Chart(el('chartTrend'), {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Claims Checked',
            data: [],
            borderColor: COLORS.blue,
            backgroundColor: 'rgba(0,87,184,0.15)',
            fill: true,
            tension: 0.35,
            pointRadius: isMobile() ? 3 : 5,
            borderWidth: 2.5
          },
          {
            label: 'Verified',
            data: [],
            borderColor: COLORS.true,
            backgroundColor: 'rgba(34,197,94,0.12)',
            fill: true,
            tension: 0.35,
            pointRadius: isMobile() ? 3 : 5,
            borderWidth: 2.5
          }
        ]
      },
      options: {
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            grid: { display: false },
            ticks: { font: { weight: '600' }, color: COLORS.navy }
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(15,26,65,0.06)' },
            ticks: { color: COLORS.muted }
          }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  /* ---------- 2. RISK DISTRIBUTION (Donut) ---------- */
  function buildRisk() {
    charts.risk = new Chart(el('chartRisk'), {
      type: 'doughnut',
      data: {
        labels: RISK_LABELS.slice(),
        datasets: [{
          label: 'Risk',
          data: [],
          backgroundColor: RISK_COLORS,
          borderColor: '#fff',
          borderWidth: 3,
          hoverOffset: 8
        }]
      },
      options: {
        cutout: '62%',
        plugins: {
          legend: {
            display: true,
            position: isMobile() ? 'bottom' : 'right',
            labels: { padding: 12, color: COLORS.navy, font: { weight: '600' }, usePointStyle: true }
          },
          tooltip: {
            callbacks: {
              label: function (ctx) {
                var total = ctx.dataset.data.reduce(function (a, b) { return a + b; }, 0);
                var pct = total ? Math.round((ctx.parsed / total) * 100) : 0;
                return ' ' + ctx.label + ': ' + ctx.parsed + ' (' + pct + '%)';
              }
            }
          }
        }
      }
    });
  }

  /* ---------- 3. TRUSTED SOURCES (Horizontal Bar) ---------- */
  function buildSources() {
    charts.sources = new Chart(el('chartSources'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Citations',
          data: [],
          backgroundColor: COLORS.blue,
          borderRadius: 6,
          borderSkipped: false
        }]
      },
      options: {
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, grid: { color: 'rgba(15,26,65,0.06)' } },
          y: {
            grid: { display: false },
            ticks: {
              color: COLORS.navy,
              font: { weight: '700', size: isMobile() ? 11 : 13 },
              autoSkip: false
            }
          }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  /* ---------- 4. CATEGORY (Horizontal Bar) ---------- */
  function buildCategory() {
    charts.category = new Chart(el('chartCategory'), {
      type: 'bar',
      data: {
        labels: [],
        datasets: [{
          label: 'Flagged',
          data: [],
          backgroundColor: COLORS.false,
          borderRadius: 6
        }]
      },
      options: {
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, grid: { color: 'rgba(15,26,65,0.06)' } },
          y: { grid: { display: false }, ticks: { color: COLORS.navy, font: { weight: '700' } } }
        },
        plugins: { legend: { display: false } }
      }
    });
  }

  function init() {
    if (!el('chartTrend')) return;
    buildTrend();
    buildRisk();
    buildSources();
    buildCategory();
    if (lastMetrics) applyData(lastMetrics);
  }

  /* ---------- Data binding from /api/metrics ---------- */
  function setData(chart, labels, datasets) {
    if (!chart) return;
    chart.data.labels = labels;
    datasets.forEach(function (d) {
      for (var i = 0; i < chart.data.datasets.length; i++) {
        if (chart.data.datasets[i].label === d.label) {
          chart.data.datasets[i].data = d.data;
          return;
        }
      }
    });
    chart.update();
  }

  function update(data) {
    lastMetrics = data;
    if (!charts.trend) return;
    applyData(data);
  }

  function applyData(data) {
    if (!data) return;
    var m = data.misinformation || {};

    setData(charts.trend, [], []);
    setData(charts.risk, RISK_LABELS, [{ label: 'Risk', data: [] }]);
    setData(charts.sources, [], [{ label: 'Citations', data: [] }]);
    setData(charts.category, [], [{ label: 'Flagged', data: [] }]);

    if (data.weekly && data.weekly.length > 0) {
      setData(charts.trend,
        data.weekly.map(function (w) { return w.date; }),
        [
          { label: 'Claims Checked', data: data.weekly.map(function (w) { return w.count || 0; }) },
          { label: 'Verified', data: data.weekly.map(function (w) { return w.verified || 0; }) }
        ]);
    }

    if (m.riskDistribution) {
      var rd = m.riskDistribution;
      setData(charts.risk, RISK_LABELS, [
        { label: 'Risk', data: [rd.high || 0, rd.medium || 0, rd.low || 0] }
      ]);
    }

    if (data.trustedSources && data.trustedSources.length > 0) {
      var ts = data.trustedSources;
      setData(charts.sources, ts.map(function (s) { return s.category; }),
        [{ label: 'Citations', data: ts.map(function (s) { return s.count || 0; }) }]);
      charts.sources.data.datasets[0].backgroundColor = ts.map(function (s) {
        return SOURCE_COLORS[s.category] || COLORS.blue;
      });
    }

    if (m.categories && m.categories.length > 0) {
      var catLabels = m.categories.map(function (c) { return CATEGORY_LABELS[c.category] || c.category; });
      setData(charts.category, catLabels, [
        { label: 'Flagged', data: m.categories.map(function (c) { return c.count || 0; }) }
      ]);
      charts.category.data.datasets[0].backgroundColor = m.categories.map(function (c) {
        return CATEGORY_COLORS[c.category] || COLORS.blue;
      });
    }
  }

  function resize() {
    Object.keys(charts).forEach(function (k) {
      var chart = charts[k];
      if (!chart) return;
      var opts = chart.options;
      var xScale = opts.scales && opts.scales.x;
      if (xScale && xScale.ticks) {
        xScale.ticks.font = Object.assign({}, xScale.ticks.font, { size: isMobile() ? 10 : 12 });
      }
      chart.resize();
    });
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 200);
  });

  window.VerifiedPulseCharts = { init: init, update: update, resize: resize };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();