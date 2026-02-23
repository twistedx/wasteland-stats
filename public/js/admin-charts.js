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

  var charts = [];
  window.addEventListener("resize", function () {
    charts.forEach(function (c) { c.resize(); });
  });

  // Visitor traffic chart (from server-side data)
  function renderVisitorsChart(dailyViews) {
    var el = document.getElementById("chart-visitors");
    if (!el || !dailyViews || !dailyViews.length) return;
    var chart = echarts.init(el);
    charts.push(chart);

    var labels = dailyViews.map(function (d) {
      var parts = d.date.split("-");
      var monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return monthNames[parseInt(parts[1], 10) - 1] + " " + parseInt(parts[2], 10);
    });

    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: { trigger: "axis", backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" } },
      legend: { data: ["Page Views", "Unique Visitors", "Logged-In Views"], textStyle: { color: ACCENT, fontFamily: "Rajdhani, sans-serif" }, top: 0 },
      xAxis: { type: "category", data: labels, axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT, fontSize: 10, rotate: 35 }, boundaryGap: false },
      yAxis: { type: "value", axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT }, splitLine: { lineStyle: { color: GRID } } },
      series: [
        {
          name: "Page Views",
          type: "line",
          data: dailyViews.map(function (d) { return d.views; }),
          smooth: true,
          symbol: "circle",
          symbolSize: 4,
          lineStyle: { color: "#5470c6", width: 2 },
          itemStyle: { color: "#5470c6" },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(84,112,198,0.3)" },
              { offset: 1, color: "rgba(84,112,198,0.02)" },
            ]),
          },
        },
        {
          name: "Unique Visitors",
          type: "line",
          data: dailyViews.map(function (d) { return d.unique; }),
          smooth: true,
          symbol: "circle",
          symbolSize: 4,
          lineStyle: { color: "#91cc75", width: 2 },
          itemStyle: { color: "#91cc75" },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(145,204,117,0.25)" },
              { offset: 1, color: "rgba(145,204,117,0.02)" },
            ]),
          },
        },
        {
          name: "Logged-In Views",
          type: "line",
          data: dailyViews.map(function (d) { return d.loggedIn || 0; }),
          smooth: true,
          symbol: "circle",
          symbolSize: 4,
          lineStyle: { color: "#fac858", width: 2 },
          itemStyle: { color: "#fac858" },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(250,200,88,0.25)" },
              { offset: 1, color: "rgba(250,200,88,0.02)" },
            ]),
          },
        },
      ],
    }));
  }

  // Ban Activity Over Time (line)
  function renderBansChart(bans) {
    var el = document.getElementById("chart-bans");
    if (!el || !bans.length) return;
    var chart = echarts.init(el);
    charts.push(chart);

    var months = {};
    bans.forEach(function (b) {
      if (!b.time_stamp) return;
      var d = new Date(b.time_stamp);
      var key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
      months[key] = (months[key] || 0) + 1;
    });

    var sorted = Object.keys(months).sort();
    var monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var labels = sorted.map(function (k) {
      var parts = k.split("-");
      return monthNames[parseInt(parts[1], 10) - 1] + " " + parts[0].slice(2);
    });
    var values = sorted.map(function (k) { return months[k]; });

    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: { trigger: "axis", backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" } },
      xAxis: { type: "category", data: labels, axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT, fontSize: 11 }, boundaryGap: false },
      yAxis: { type: "value", axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT }, splitLine: { lineStyle: { color: GRID } } },
      series: [{
        type: "line",
        data: values,
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        lineStyle: { color: "#ee6666", width: 2 },
        itemStyle: { color: "#ee6666" },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(238,102,102,0.35)" },
            { offset: 1, color: "rgba(238,102,102,0.02)" },
          ]),
        },
      }],
    }));
  }

  // Ban Reasons (donut)
  function renderReasonsChart(bans) {
    var el = document.getElementById("chart-reasons");
    if (!el || !bans.length) return;
    var chart = echarts.init(el);
    charts.push(chart);

    var categories = {};
    bans.forEach(function (b) {
      var reason = (b.reason || "Unknown").toLowerCase().trim();
      var cat;
      if (reason.match(/cheat|hack|exploit|script|inject|aimbot|esp/)) cat = "Cheating/Hacking";
      else if (reason.match(/racis|slur|hate|n.word|bigot/)) cat = "Racism/Hate";
      else if (reason.match(/tk|team.?kill|friendly.?fire|intentional/)) cat = "Team Killing";
      else if (reason.match(/evas|evad|ban.?evas|alt.?account/)) cat = "Ban Evasion";
      else if (reason.match(/troll|grief|harass|toxic|abuse/)) cat = "Trolling/Griefing";
      else if (reason.match(/glitch|bug|dupe|duping/)) cat = "Glitching";
      else if (reason.match(/spam|flood|chat/)) cat = "Spam";
      else cat = "Other";
      categories[cat] = (categories[cat] || 0) + 1;
    });

    var data = Object.keys(categories).map(function (k) { return { name: k, value: categories[k] }; })
      .sort(function (a, b) { return b.value - a.value; });

    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: { trigger: "item", backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" } },
      series: [{
        type: "pie",
        radius: ["35%", "65%"],
        center: ["50%", "55%"],
        data: data,
        label: { color: "#e8e8e8", fontSize: 10, fontWeight: 600, formatter: "{b}\n{d}%" },
        labelLine: { lineStyle: { color: ACCENT } },
        itemStyle: { borderColor: BG, borderWidth: 2 },
        color: ["#ee6666", "#fac858", "#fc8452", "#9a60b4", "#73c0de", "#91cc75", "#5470c6", "#c4ccd3"],
      }],
    }));
  }

  // Top Admins (horizontal bar)
  function renderAdminsChart(bans) {
    var el = document.getElementById("chart-admins");
    if (!el || !bans.length) return;
    var chart = echarts.init(el);
    charts.push(chart);

    var admins = {};
    bans.forEach(function (b) {
      var name = b.admin_name || "Unknown";
      admins[name] = (admins[name] || 0) + 1;
    });

    var sorted = Object.entries(admins).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 10).reverse();

    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" } },
      xAxis: { type: "value", axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT }, splitLine: { lineStyle: { color: GRID } } },
      yAxis: { type: "category", data: sorted.map(function (a) { return a[0]; }), axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: "#e8e8e8", fontSize: 12, fontWeight: 600 } },
      series: [{
        type: "bar",
        data: sorted.map(function (a) { return a[1]; }),
        itemStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
            { offset: 0, color: "#3a1a3a" },
            { offset: 1, color: "#9a60b4" },
          ]),
          borderRadius: [0, 3, 3, 0],
        },
        label: { show: true, position: "right", color: "#e8e8e8", fontSize: 11, fontWeight: 700 },
        barWidth: "55%",
      }],
    }));
  }

  // Render visitor chart from server-side embedded data
  if (window.__dailyViews) {
    renderVisitorsChart(window.__dailyViews);
  }

  // Fetch game stats and render charts
  fetch("/api/stats")
    .then(function (res) { return res.json(); })
    .then(function (data) {
      renderBansChart(data.bans || []);
      renderReasonsChart(data.bans || []);
      renderAdminsChart(data.bans || []);
    })
    .catch(function (err) {
      console.error("Admin charts fetch error:", err);
    });
})();
