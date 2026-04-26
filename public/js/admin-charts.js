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

  // Discord — Online Activity History (7 days, 15-min snapshots)
  function renderOnlineHistoryChart(history) {
    var el = document.getElementById("chart-discord-online-history");
    if (!el || !history || !history.length) return;
    var chart = echarts.init(el);
    charts.push(chart);

    var dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var labels = history.map(function (d) {
      var dt = new Date(d.ts);
      return dayNames[dt.getDay()] + " " + String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
    });

    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: {
        trigger: "axis",
        backgroundColor: BG,
        borderColor: GRID,
        textStyle: { color: "#e8e8e8" },
        formatter: function (params) {
          var idx = params[0].dataIndex;
          var d = new Date(history[idx].ts);
          var header = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
          var lines = params.map(function (p) {
            return '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + p.color + ';margin-right:4px;"></span>' + p.seriesName + ": <b>" + p.value + "</b>";
          });
          return header + "<br>" + lines.join("<br>");
        },
      },
      legend: { data: ["Online", "Idle", "DnD", "In Voice"], textStyle: { color: ACCENT, fontFamily: "Rajdhani, sans-serif" }, top: 0 },
      xAxis: {
        type: "category",
        data: labels,
        axisLine: { lineStyle: { color: GRID } },
        axisLabel: {
          color: ACCENT,
          fontSize: 9,
          rotate: 45,
          interval: function (idx) {
            // Show label every ~3 hours (12 snapshots at 15-min intervals)
            return idx % 12 === 0;
          },
        },
        boundaryGap: false,
      },
      yAxis: { type: "value", axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT }, splitLine: { lineStyle: { color: GRID } } },
      dataZoom: [
        { type: "inside", start: 0, end: 100 },
        { type: "slider", start: 0, end: 100, height: 20, bottom: 5, borderColor: GRID, fillerColor: "rgba(88,101,242,0.15)", handleStyle: { color: "#5865F2" } },
      ],
      series: [
        {
          name: "Online",
          type: "line",
          data: history.map(function (d) { return d.online; }),
          smooth: true,
          symbol: "none",
          lineStyle: { color: "#43b581", width: 2 },
          itemStyle: { color: "#43b581" },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: "rgba(67,181,129,0.3)" },
              { offset: 1, color: "rgba(67,181,129,0.02)" },
            ]),
          },
        },
        {
          name: "Idle",
          type: "line",
          data: history.map(function (d) { return d.idle; }),
          smooth: true,
          symbol: "none",
          lineStyle: { color: "#faa61a", width: 1.5 },
          itemStyle: { color: "#faa61a" },
        },
        {
          name: "DnD",
          type: "line",
          data: history.map(function (d) { return d.dnd; }),
          smooth: true,
          symbol: "none",
          lineStyle: { color: "#f04747", width: 1.5 },
          itemStyle: { color: "#f04747" },
        },
        {
          name: "In Voice",
          type: "line",
          data: history.map(function (d) { return d.in_voice; }),
          smooth: true,
          symbol: "none",
          lineStyle: { color: "#5865F2", width: 2, type: "dashed" },
          itemStyle: { color: "#5865F2" },
        },
      ],
    }));
  }

  // Discord — Member Growth chart
  function renderDiscordJoinsChart(joinHistory) {
    var el = document.getElementById("chart-discord-joins");
    if (!el || !joinHistory || !joinHistory.length) return;
    var chart = echarts.init(el);
    charts.push(chart);

    var monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var labels = joinHistory.map(function (d) {
      var parts = d.date.split("-");
      return monthNames[parseInt(parts[1], 10) - 1] + " " + parseInt(parts[2], 10);
    });

    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: { trigger: "axis", backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" } },
      legend: { data: ["Joined", "Left"], textStyle: { color: ACCENT }, top: 0 },
      xAxis: { type: "category", data: labels, axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT, fontSize: 10, rotate: 35 }, boundaryGap: true },
      yAxis: { type: "value", minInterval: 1, axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT }, splitLine: { lineStyle: { color: GRID } } },
      series: [{
        name: "Joined",
        type: "bar",
        data: joinHistory.map(function (d) { return d.joins; }),
        itemStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "#5865F2" },
            { offset: 1, color: "#3a42a0" },
          ]),
          borderRadius: [3, 3, 0, 0],
        },
        barMaxWidth: 20,
      }, {
        name: "Left",
        type: "bar",
        data: joinHistory.map(function (d) { return d.leaves || 0; }),
        itemStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "#ef4444" },
            { offset: 1, color: "#991b1b" },
          ]),
          borderRadius: [3, 3, 0, 0],
        },
        barMaxWidth: 20,
      }],
    }));
  }

  // Discord — Role Breakdown chart
  function renderDiscordRolesChart(topRoles) {
    var el = document.getElementById("chart-discord-roles");
    if (!el || !topRoles || !topRoles.length) return;
    var chart = echarts.init(el);
    charts.push(chart);

    var sorted = topRoles.slice(0, 10).reverse();

    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" } },
      xAxis: { type: "value", axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT }, splitLine: { lineStyle: { color: GRID } } },
      yAxis: { type: "category", data: sorted.map(function (r) { return r.name; }), axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: "#e8e8e8", fontSize: 11, fontWeight: 600 } },
      series: [{
        type: "bar",
        data: sorted.map(function (r) {
          return { value: r.count, itemStyle: { color: r.color === "#000000" ? "#5865F2" : r.color } };
        }),
        label: { show: true, position: "right", color: "#e8e8e8", fontSize: 11, fontWeight: 700 },
        barWidth: "55%",
        itemStyle: { borderRadius: [0, 3, 3, 0] },
      }],
    }));
  }

  // Discord — Online Status donut
  function renderDiscordStatusChart(discord) {
    var el = document.getElementById("chart-discord-status");
    if (!el || !discord) return;
    var chart = echarts.init(el);
    charts.push(chart);

    var data = [
      { name: "Online", value: discord.online || 0 },
      { name: "Idle", value: discord.idle || 0 },
      { name: "DnD", value: discord.dnd || 0 },
      { name: "Offline", value: discord.offline || 0 },
    ].filter(function (d) { return d.value > 0; });

    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: { trigger: "item", backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" } },
      series: [{
        type: "pie",
        radius: ["35%", "65%"],
        center: ["50%", "55%"],
        data: data,
        label: { color: "#e8e8e8", fontSize: 11, fontWeight: 600, formatter: "{b}\n{c} ({d}%)" },
        labelLine: { lineStyle: { color: ACCENT } },
        itemStyle: { borderColor: BG, borderWidth: 2 },
        color: ["#43b581", "#faa61a", "#f04747", "#747f8d"],
      }],
    }));
  }

  // Store — Revenue chart (30 days)
  function renderStoreRevenueChart(dailyRevenue) {
    var el = document.getElementById("chart-store-revenue");
    if (!el || !dailyRevenue || !dailyRevenue.length) return;
    var chart = echarts.init(el);
    charts.push(chart);

    var monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var labels = dailyRevenue.map(function (d) {
      var parts = d.date.split("-");
      return monthNames[parseInt(parts[1], 10) - 1] + " " + parseInt(parts[2], 10);
    });

    chart.setOption(Object.assign({}, baseTheme, {
      tooltip: { trigger: "axis", backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" }, formatter: function(params) {
        var idx = params[0].dataIndex;
        return labels[idx] + "<br>Revenue: <b>$" + dailyRevenue[idx].revenue.toFixed(2) + "</b><br>Orders: <b>" + dailyRevenue[idx].orders + "</b>";
      }},
      xAxis: { type: "category", data: labels, axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT, fontSize: 10, rotate: 35 }, boundaryGap: true },
      yAxis: { type: "value", axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT, formatter: "${value}" }, splitLine: { lineStyle: { color: GRID } } },
      series: [{
        name: "Revenue",
        type: "bar",
        data: dailyRevenue.map(function (d) { return d.revenue; }),
        itemStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "#22c55e" },
            { offset: 1, color: "#166534" },
          ]),
          borderRadius: [3, 3, 0, 0],
        },
        barMaxWidth: 20,
      }],
    }));
  }

  // Trim long product names so they fit in the chart label gutter without overflowing
  function shortName(name, maxLen) {
    if (!name) return "";
    maxLen = maxLen || 28;
    // Strip leading emoji/symbols and "Wasteland Loadout Drop —" prefix
    var clean = String(name)
      .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}\s]+/u, "")
      .replace(/Wasteland Loadout Drop\s*[—\-]\s*/i, "")
      .replace(/\(One time Payment\)/gi, "(OTP)")
      .replace(/\s+\*\*[^*]*\*\*\s*/g, " ")
      .trim();
    // If multiple products bundled with commas, take the first + "+N more"
    if (clean.indexOf(",") !== -1) {
      var parts = clean.split(",").map(function (p) { return p.trim(); }).filter(Boolean);
      if (parts.length > 1) clean = parts[0] + " +" + (parts.length - 1) + " more";
    }
    if (clean.length > maxLen) clean = clean.slice(0, maxLen - 1).trim() + "…";
    return clean;
  }

  // Store — Top Products by Revenue (horizontal bar)
  function renderStoreProductsChart(topProducts) {
    var el = document.getElementById("chart-store-products");
    if (!el || !topProducts || !topProducts.length) return;
    var chart = echarts.init(el);
    charts.push(chart);

    var sorted = topProducts.slice(0, 8).reverse();
    chart.setOption(Object.assign({}, baseTheme, {
      grid: { left: 200, right: 60, top: 10, bottom: 30, containLabel: false },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" },
        formatter: function (params) {
          var p = params[0];
          var fullName = sorted[p.dataIndex].product_name;
          return '<div style="max-width:340px;white-space:normal;"><b>' + fullName + '</b><br/>$' + p.value + '</div>';
        }
      },
      xAxis: { type: "value", axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT, formatter: "${value}" }, splitLine: { lineStyle: { color: GRID } } },
      yAxis: { type: "category", data: sorted.map(function (p) { return shortName(p.product_name, 26); }), axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: "#e8e8e8", fontSize: 11, fontWeight: 600, width: 190, overflow: "truncate" } },
      series: [{
        type: "bar",
        data: sorted.map(function (p) { return parseFloat(p.revenue); }),
        itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: "#166534" }, { offset: 1, color: "#22c55e" }]), borderRadius: [0, 3, 3, 0] },
        label: { show: true, position: "right", color: "#e8e8e8", fontSize: 11, fontWeight: 700, formatter: "${c}" },
        barWidth: "55%",
      }],
    }));
  }

  // Store — Top Products by Quantity (horizontal bar)
  function renderStoreQtyChart(topProducts) {
    var el = document.getElementById("chart-store-qty");
    if (!el || !topProducts || !topProducts.length) return;
    var chart = echarts.init(el);
    charts.push(chart);

    var sorted = topProducts.slice(0, 8).reverse();
    chart.setOption(Object.assign({}, baseTheme, {
      grid: { left: 200, right: 60, top: 10, bottom: 30, containLabel: false },
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, backgroundColor: BG, borderColor: GRID, textStyle: { color: "#e8e8e8" },
        formatter: function (params) {
          var p = params[0];
          var fullName = sorted[p.dataIndex].product_name;
          return '<div style="max-width:340px;white-space:normal;"><b>' + fullName + '</b><br/>' + p.value + ' sold</div>';
        }
      },
      xAxis: { type: "value", minInterval: 1, axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: ACCENT }, splitLine: { lineStyle: { color: GRID } } },
      yAxis: { type: "category", data: sorted.map(function (p) { return shortName(p.product_name, 26); }), axisLine: { lineStyle: { color: GRID } }, axisLabel: { color: "#e8e8e8", fontSize: 11, fontWeight: 600, width: 190, overflow: "truncate" } },
      series: [{
        type: "bar",
        data: sorted.map(function (p) { return p.sold; }),
        itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: "#1e3a5f" }, { offset: 1, color: "#5865F2" }]), borderRadius: [0, 3, 3, 0] },
        label: { show: true, position: "right", color: "#e8e8e8", fontSize: 11, fontWeight: 700 },
        barWidth: "55%",
      }],
    }));
  }

  // Render visitor chart from server-side embedded data
  if (window.__dailyViews) {
    renderVisitorsChart(window.__dailyViews);
  }

  // Render Discord charts when tab becomes visible
  var discordRendered = false;
  function renderDiscordCharts() {
    if (discordRendered || !window.__discord || !window.__discord.joinHistory) return;
    discordRendered = true;
    renderOnlineHistoryChart(window.__onlineHistory || []);
    renderDiscordJoinsChart(window.__discord.joinHistory);
    renderDiscordRolesChart(window.__discord.topRoles);
    renderDiscordStatusChart(window.__discord);
  }

  // Store charts (deferred)
  var storeRendered = false;
  function renderStoreCharts() {
    if (storeRendered || !window.__storeStats || !window.__storeStats.dailyRevenue) return;
    storeRendered = true;
    renderStoreRevenueChart(window.__storeStats.dailyRevenue);
    renderStoreProductsChart(window.__storeStats.topProducts);
    renderStoreQtyChart(window.__storeStats.topProducts);
  }

  // Check if tabs are already visible, otherwise wait for tab switch
  var discordTab = document.getElementById("tab-discord");
  if (discordTab && discordTab.style.display !== "none") {
    renderDiscordCharts();
  }
  var storeTab = document.getElementById("tab-store");
  if (storeTab && storeTab.style.display !== "none") {
    renderStoreCharts();
  }
  // Listen for tab switch
  document.querySelectorAll(".analytics-tab").forEach(function(tab) {
    tab.addEventListener("click", function() {
      if (this.getAttribute("data-tab") === "tab-discord") {
        setTimeout(renderDiscordCharts, 100);
      }
      if (this.getAttribute("data-tab") === "tab-store") {
        setTimeout(renderStoreCharts, 100);
      }
    });
  });

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
