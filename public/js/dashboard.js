(function () {
  "use strict";

  var ACCENT = "#9a9a9a";
  var GRID = "rgba(255,255,255,0.06)";
  var BG = "#161616";
  var COLORS = ["#5470c6", "#91cc75", "#fac858", "#ee6666", "#73c0de", "#3ba272", "#fc8452", "#9a60b4", "#ea7ccc", "#c4ccd3"];

  var baseTheme = {
    backgroundColor: "transparent",
    textStyle: { fontFamily: "Rajdhani, sans-serif", color: ACCENT },
    grid: { left: "3%", right: "4%", bottom: "3%", top: "12%", containLabel: true },
  };

  // --- Counter animation ---
  function abbreviate(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
    return Number(n).toLocaleString();
  }

  function animateCounter(el, target, suffix) {
    var duration = 1800;
    var start = performance.now();
    function tick(now) {
      var elapsed = now - start;
      var progress = Math.min(elapsed / duration, 1);
      var ease = 1 - Math.pow(1 - progress, 3);
      el.textContent = abbreviate(Math.round(target * ease)) + (suffix || "");
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  // --- Chart rendering ---
  var homeCharts = [];
  var chartsRendered = false;

  window.addEventListener("resize", function () {
    homeCharts.forEach(function (c) { c.resize(); });
  });

  function renderKillsChart(leaderboard) {
    var el = document.getElementById("home-chart-kills");
    if (!el || !leaderboard.length) return;
    var chart = echarts.init(el);
    homeCharts.push(chart);

    var data = leaderboard.slice().reverse();
    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" } },
      xAxis: { type: "value", axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT }, splitLine: { lineStyle: { color: GRID } } },
      yAxis: { type: "category", data: data.map(function (p) { return p.arma_username; }), axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: "#e8e8e8", fontSize: 13, fontWeight: 600 } },
      series: [{
        type: "bar",
        data: data.map(function (p) { return Number(p.kill_count) || 0; }),
        itemStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: "#1a3a5c" },
            { offset: 1, color: "#5470c6" },
          ]),
          borderRadius: [0, 3, 3, 0],
        },
        label: { show: true, position: "right", color: "#e8e8e8", fontSize: 12, fontWeight: 700, fontFamily: "Orbitron, sans-serif" },
        barWidth: "60%",
      }],
    }));
  }

  function renderKDChart(leaderboard) {
    var el = document.getElementById("home-chart-kd");
    if (!el || !leaderboard.length) return;
    var chart = echarts.init(el);
    homeCharts.push(chart);

    var top = leaderboard.slice(0, 10);
    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: { trigger: "axis", backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" } },
      xAxis: { type: "category", data: top.map(function (p) { return p.arma_username; }), axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT, rotate: 35, fontSize: 11 } },
      yAxis: { type: "value", axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT }, splitLine: { lineStyle: { color: GRID } } },
      series: [{
        type: "bar",
        data: top.map(function (p) {
          var kd = parseFloat(p.kdRatio) || 0;
          return { value: kd, itemStyle: { color: kd >= 3 ? "#91cc75" : kd >= 1.5 ? "#fac858" : "#ee6666" } };
        }),
        label: { show: true, position: "top", color: "#e8e8e8", fontSize: 11, fontWeight: 700, fontFamily: "Orbitron, sans-serif" },
        barWidth: "55%",
      }],
    }));
  }

  function renderShotsChart(detailed) {
    var el = document.getElementById("home-chart-shots");
    if (!el || !detailed.length) return;
    var chart = echarts.init(el);
    homeCharts.push(chart);

    var data = detailed.map(function (p) {
      return { name: p.username, value: Number(p.shots_fired) || 0 };
    }).filter(function (d) { return d.value > 0; });

    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: { trigger: "item", backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" }, formatter: function (p) { return p.name + ": " + Number(p.value).toLocaleString() + " shots"; } },
      series: [{
        type: "pie",
        radius: ["40%", "70%"],
        center: ["50%", "55%"],
        data: data,
        label: { color: "#e8e8e8", fontSize: 11, fontWeight: 600 },
        labelLine: { lineStyle: { color: ACCENT } },
        itemStyle: { borderColor: BG, borderWidth: 2 },
        color: COLORS,
      }],
    }));
  }

  // Detect active season tab from URL
  var isAllTime = window.location.search.indexOf("tab=alltime") !== -1;
  var seasonLabel = isAllTime ? "All Time" : "Current Season";

  function getActiveLeaderboard(apiData) {
    return isAllTime ? (apiData.leaderboardAllTime || []) : (apiData.leaderboard || []);
  }

  function renderAllCharts(apiData) {
    // Dispose old charts if re-rendering
    homeCharts.forEach(function (c) { c.dispose(); });
    homeCharts = [];

    var lb = getActiveLeaderboard(apiData);
    renderKillsChart(lb);
    renderKDChart(lb);
    renderShotsChart(apiData.detailedStats || []);

    // Update chart headers to reflect active tab
    var killsHeader = document.querySelector("#leaderboard-graphs .dash-panel-wide .dash-panel-header");
    if (killsHeader) killsHeader.textContent = "Kill Leaderboard \u2014 " + seasonLabel;
  }

  // --- Tab switching ---
  var btnDetail = document.getElementById("btn-detail-view");
  var btnGraph = document.getElementById("btn-graph-view");
  var detailPane = document.getElementById("leaderboard-detail");
  var graphPane = document.getElementById("leaderboard-graphs");
  var cachedApiData = null;

  if (btnDetail && btnGraph) {
    btnDetail.addEventListener("click", function () {
      btnDetail.classList.add("active");
      btnGraph.classList.remove("active");
      detailPane.style.display = "";
      graphPane.style.display = "none";
    });

    btnGraph.addEventListener("click", function () {
      btnGraph.classList.add("active");
      btnDetail.classList.remove("active");
      detailPane.style.display = "none";
      graphPane.style.display = "";

      if (cachedApiData) {
        renderAllCharts(cachedApiData);
        setTimeout(function () {
          homeCharts.forEach(function (c) { c.resize(); });
        }, 50);
      }
    });
  }

  // --- Fetch data ---
  fetch("/api/stats")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      cachedApiData = data;

      // Animate counters
      if (data.serverTotals) {
        document.querySelectorAll("[data-target]").forEach(function (el) {
          var key = el.getAttribute("data-target");
          var suffix = el.getAttribute("data-suffix") || "";
          if (data.serverTotals[key] !== undefined) {
            animateCounter(el, data.serverTotals[key], suffix);
          }
        });
      }

      // If graph view is already visible, render immediately
      if (graphPane && graphPane.style.display !== "none") {
        renderAllCharts(data);
      }
    })
    .catch(function (err) {
      console.error("Dashboard fetch error:", err);
    });
})();
