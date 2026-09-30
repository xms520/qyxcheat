/* QYXY_inject.js v2 — 奇遇西游助手 Web 侧注入（多 frame 版）
 * 关键：本脚本会被注入到【每一个 frame】（含跨域 iframe），每个 frame 独立执行。
 * 已确认架构（2026-09-30 实测）：
 *   App → WKWebView(appack.zkyouxi.com 平台壳) → iframe(SDK壳) → iframe(dl-qyxx.gzdlm.com 游戏)
 *   引擎 = LayaAir 2.13.3 + FairyGUI + qyscript
 */
(function () {
  if (window.__qyxy_installed) { window.__qyxy_cfg && (window.__qyxy_cfg.reload = true); return "already"; }
  window.__qyxy_installed = true;

  var IS_TOP = (function () { try { return window === window.top; } catch (e) { return false; } })();
  var IS_GAME = /dl-qyxx|gzdlm\.com\/game|gameID=/.test(location.href) ||
                (typeof Laya !== "undefined" && !!Laya.stage);

  var S = {
    v: "2.0",
    href: location.href,
    isTop: IS_TOP,
    isGame: IS_GAME,
    engine: "?",
    layaVer: "",
    fgui: false,
    units: 0,
    unitSample: "",
    hpFields: [],
    godHits: 0,
    kills: 0,
    adWrapped: [],
    speedApplied: 0,
    err: "",
    probe: ""
  };

  window.__qyxy_cfg = { god: false, kill: false, noAd: false, speed: 1.0, probe: false, tick: 0 };
  window.__qyxy_probe = "";

  function log(s) { try { console.log("[QYXY] " + s); } catch (e) {} }

  /* ================= 1. 引擎探测 ================= */
  function detect() {
    try {
      if (window.Laya) {
        S.engine = "LayaAir";
        S.layaVer = (Laya.__version__ || (Laya.version) || "") + " " + (window.Laya3D ? "3D" : "2D");
        if (Laya.Stage && Laya.Stage.__version) S.layaVer += " stageV=" + Laya.Stage.__version;
      } else if (window.fairygui || window.fgui) {
        S.engine = "FairyGUI-only";
      } else if (window.CocosEngine) {
        S.engine = "CocosCreator " + (window.CocosEngine.version || "");
      } else if (window.cc) {
        S.engine = "cocos2d-js";
      } else if (window.egret) { S.engine = "Egret"; }
      else if (window.PIXI) { S.engine = "Pixi"; }
      else if (window.Phaser) { S.engine = "Phaser"; }
      else if (window.createUnityInstance) { S.engine = "UnityWebGL"; }
    } catch (e) {}
    try { S.fgui = !!(window.fairygui || window.fgui || (window.Laya && Laya.Browser && Laya.Browser.window.fairygui)); } catch (e) {}
    return S.engine;
  }
  detect();

  /* ================= 2. 加速（Laya 原生计时器倍率 + RAF 兜底） ================= */
  var realRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
  var speed = 1.0;

  window.requestAnimationFrame = function (cb) {
    if (!realRAF) return 0;
    if (speed <= 1.0001) return realRAF(cb);
    var factor = Math.min(16, Math.max(1, Math.round(speed)));
    return realRAF(function (ts) {
      cb(ts);
      for (var i = 1; i < factor; i++) { try { cb(ts); } catch (e) { S.err = "" + e; break; } }
    });
  };

  function applySpeed(mult) {
    speed = mult > 1 ? mult : 1.0;
    S.speedApplied = speed;
    try {
      // ★ LayaAir 官方全局时间缩放：定时器（loop/timerLoop/frameLoop 调度）总闸
      if (window.Laya && Laya.timer) {
        Laya.timer.scale = speed;
      }
      // 帧率档位（影响渲染与 frameLoop 频率）
      if (window.Laya && Laya.stage && Laya.Stage) {
        Laya.stage.frameRate = speed >= 3 ? Laya.Stage.FRAME_FAST
                             : speed >= 2 ? ("fast")
                             : Laya.Stage.FRAME_SLOW;
      }
      // Laya 内部时间轴（tween）
      if (window.Laya && Laya.Tween && Laya.Tween.prototype) {
        if (!Laya.Tween.prototype.__qyxy_scaled) {
          var origUpdate = Laya.Tween.prototype.update;
          Laya.Tween.prototype.update = function (dt) {
            var cfg = window.__qyxy_cfg || {};
            var m = cfg.speed > 1 ? cfg.speed : 1;
            return origUpdate.call(this, dt * m);
          };
          Laya.Tween.prototype.__qyxy_scaled = true;
        }
      }
    } catch (e) { S.err = "" + e; }
  }

  /* ================= 3. 战斗单位扫描（Laya 场景树 + 全局对象） ================= */
  var HP_PAT   = /^(hp|Hp|HP|Health|health|life|Life|blood|Blood|curHp|curHP|nowHp|hp_now|hpCur)$/;
  var MAXH_PAT = /^(maxHp|maxHP|maxhp|hpMax|hpmax|hp_max|maxHealth|totalHp|fullHp|hpMaxValue)$/;
  var ATK_PAT  = /^(atk|Atk|ATK|attack|Attack|damage|Damage|hurt|Hurt|dmg|Dmg|power|Power|atkValue)$/;
  var SPEED_PAT= /^(speed|Speed|moveSpeed|moveSpd|atkSpeed|attackSpeed|spd)$/;

  function numKeys(o, lim) {
    var out = [];
    try {
      var ks = Object.keys(o);
      for (var i = 0; i < ks.length && out.length < (lim || 40); i++) {
        var k = ks[i], v = o[k];
        if (typeof v === "number" && isFinite(v)) out.push(k);
      }
    } catch (e) {}
    return out;
  }

  // 在 Laya stage 显示树上找「像战斗单位」的节点
  function layaScan() {
    var acc = [], seen = [], scanned = 0;
    if (!window.Laya || !Laya.stage) return acc;
    function walk(n, path, depth) {
      if (!n || depth > 9 || acc.length > 80 || scanned > 3000) return;
      if (seen.indexOf(n) >= 0) return;
      seen.push(n); scanned++;
      var nk = numKeys(n, 40);
      var score = 0, hpF = [], atkF = [];
      for (var i = 0; i < nk.length; i++) {
        if (HP_PAT.test(nk[i])) { score += 3; hpF.push(nk[i]); }
        if (MAXH_PAT.test(nk[i])) { score += 3; hpF.push(nk[i]); }
        if (ATK_PAT.test(nk[i])) { score += 2; atkF.push(nk[i]); }
      }
      if (score >= 3) {
        var cls = (n.constructor && n.constructor.name) || "(anon)";
        acc.push({ path: path, cls: cls, keys: nk, hp: hpF, atk: atkF, obj: n });
      }
      var kids = null;
      try { kids = n._children; } catch (e) {}
      if (kids && kids.length) {
        for (var j = 0; j < kids.length; j++) walk(kids[j], path + "/" + j, depth + 1);
      } else if (typeof n.numChildren === "number" && n.numChildren > 0) {
        for (var m = 0; m < n.numChildren; m++) {
          try { walk(n.getChildAt(m), path + "/" + m, depth + 1); } catch (e) {}
        }
      }
    }
    walk(Laya.stage, "stage", 0);
    return acc;
  }

  // 全局对象兜底（很多 Laya 游戏把管理器挂 window）
  function globalScan() {
    var acc = [];
    try {
      for (var k in window) {
        if (acc.length > 40) break;
        if (/^(top|parent|self|window|document|location|history|navigator|Laya|fairygui|fgui|jQuery|\$)$/.test(k)) continue;
        var o;
        try { o = window[k]; } catch (e) { continue; }
        if (!o || typeof o !== "object") continue;
        if (Array.isArray(o)) {
          if (o.length && typeof o[0] === "object" && o[0]) {
            var nk = numKeys(o[0], 30), sc = 0;
            for (var i = 0; i < nk.length; i++) if (HP_PAT.test(nk[i]) || MAXH_PAT.test(nk[i]) || ATK_PAT.test(nk[i])) sc += 3;
            if (sc >= 3) acc.push({ name: k + "[" + o.length + "]", cls: (o[0].constructor && o[0].constructor.name) || "?", keys: nk, arr: o });
          }
        } else {
          var nk2 = numKeys(o, 30), sc2 = 0;
          for (var j = 0; j < nk2.length; j++) if (HP_PAT.test(nk2[j]) || MAXH_PAT.test(nk2[j]) || ATK_PAT.test(nk2[j])) sc2 += 3;
          if (sc2 >= 3) acc.push({ name: k, cls: (o.constructor && o.constructor.name) || "?", keys: nk2, obj: o });
        }
      }
    } catch (e) {}
    return acc;
  }

  /* ================= 4. 应用：无敌 / 秒杀 ================= */
  function applyToUnit(o, cfg) {
    try {
      var ks = Object.keys(o);
      var hpK = null, maxK = null;
      for (var i = 0; i < ks.length; i++) {
        if (HP_PAT.test(ks[i])) { hpK = ks[i]; break; }
      }
      for (var j = 0; j < ks.length; j++) {
        if (MAXH_PAT.test(ks[j])) { maxK = ks[j]; break; }
      }
      if (cfg.god) {
        if (hpK && maxK && typeof o[maxK] === "number") {
          if (o[hpK] !== o[maxK]) { o[hpK] = o[maxK]; S.godHits++; }
        } else if (hpK && typeof o[hpK] === "number") {
          var snap = "__qyxy_hp0";
          if (o[snap] === undefined) o[snap] = o[hpK];
          if (o[hpK] < o[snap]) { o[hpK] = o[snap]; S.godHits++; }
        }
      }
      if (cfg.kill) {
        if (hpK && typeof o[hpK] === "number" && o[hpK] > 0) { o[hpK] = 0; S.kills++; }
      }
    } catch (e) { S.err = "" + e; }
  }

  function applyAll() {
    var cfg = window.__qyxy_cfg || {};
    if (!cfg.god && !cfg.kill) return;
    var ls = layaScan(), gs = globalScan();
    S.units = ls.length + gs.length;
    ls.forEach(function (u) { if (u.obj) applyToUnit(u.obj, cfg); });
    gs.forEach(function (u) {
      if (u.obj) applyToUnit(u.obj, cfg);
      else if (u.arr) {
        for (var i = 0; i < Math.min(u.arr.length, 200); i++) {
          if (u.arr[i] && typeof u.arr[i] === "object") applyToUnit(u.arr[i], cfg);
        }
      }
    });
  }

  /* ================= 5. 免广告 ================= */
  function wrapAds() {
    ["showAd", "playAd", "showRewardedVideo", "showRewardAd", "showVideoAd", "showInterstitial",
     "playVideo", "loadAd", "requestAd", "showVideo", "showRewarded"].forEach(function (n) {
      try {
        var f = window[n];
        if (typeof f === "function" && !f.__qyxy_w) {
          window[n] = function () {
            var cfg = window.__qyxy_cfg || {};
            if (cfg.noAd) {
              var done = null;
              for (var i = arguments.length - 1; i >= 0; i--) if (typeof arguments[i] === "function") { done = arguments[i]; break; }
              try { if (done) done({ ok: true, result: 1, isEnded: true, success: true }); } catch (e) {}
              setTimeout(function () { try { if (done) done({ ok: true, result: 1, isEnded: true, success: true }); } catch (e) {} }, 30);
              return;
            }
            return f.apply(window, arguments);
          };
          window[n].__qyxy_w = true;
          S.adWrapped.push(n);
        }
      } catch (e) {}
    });
    try {
      if (window.platform) {
        ["showRewardAd", "showAd", "showVideoAd", "playAd"].forEach(function (n) {
          var f = window.platform[n];
          if (typeof f === "function" && !f.__qyxy_w) {
            window.platform[n] = function () {
              var cfg = window.__qyxy_cfg || {};
              if (cfg.noAd) { try { return Promise.resolve({ result: 1, isEnded: true, ok: true }); } catch (e) { return { result: 1, isEnded: true }; } }
              return f.apply(window.platform, arguments);
            };
            window.platform[n].__qyxy_w = true;
            S.adWrapped.push("platform." + n);
          }
        });
      }
    } catch (e) {}
  }
  if (IS_GAME || !IS_TOP) wrapAds();

  /* ================= 6. 探针 ================= */
  function probe() {
    var o = [];
    o.push("### frame: " + S.href);
    o.push("  isTop=" + S.isTop + " isGame=" + S.isGame);
    o.push("  engine=" + S.engine + " laya=" + S.layaVer + " fgui=" + S.fgui);
    o.push("  title=" + (document.title || ""));
    try { o.push("  canvas=" + document.querySelectorAll("canvas").length); } catch (e) {}
    try {
      o.push("  iframes=" + document.querySelectorAll("iframe").length + " -> " +
        Array.prototype.map.call(document.querySelectorAll("iframe"), function (f) { return (f.src || f.id || "?").slice(0, 120); }).join(" | "));
    } catch (e) {}
    // 已加载脚本
    try {
      var res = performance.getEntriesByType("resource") || [];
      var js = [];
      res.forEach(function (r) { if (/\.js(\?|$)/.test(r.name)) js.push(r.name.split("/").slice(-1)[0] + ":" + Math.round(r.transferSize || 0)); });
      if (js.length) o.push("  js(" + js.length + ")=" + js.join(" "));
    } catch (e) {}
    // Laya 场景树
    try {
      if (window.Laya && Laya.stage) {
        o.push("  Laya.stage numChildren=" + Laya.stage.numChildren +
               " frameRate=" + Laya.stage.frameRate + " timer.scale=" + (Laya.timer && Laya.timer.scale));
        var ls = layaScan();
        o.push("  layaUnits=" + ls.length);
        ls.slice(0, 12).forEach(function (u) {
          o.push("    " + u.path + " <" + u.cls + "> hp=[" + u.hp.join(",") + "] atk=[" + u.atk.join(",") + "] keys=[" + u.keys.join(",") + "]");
        });
      }
    } catch (e) {}
    // 全局数值对象
    try {
      var gs = globalScan();
      o.push("  globalUnits=" + gs.length);
      gs.slice(0, 10).forEach(function (u) {
        o.push("    " + u.name + " <" + u.cls + "> keys=[" + u.keys.join(",") + "]");
      });
    } catch (e) {}
    o.push("  speed=" + S.speedApplied + " adWrapped=" + JSON.stringify(S.adWrapped) + " err=" + (S.err || "-"));
    return o.join("\n");
  }

  /* ================= 7. 跨 frame 消息总线（postMessage 跨域合法） ================= */
  // 子 frame 把状态上报给父 frame；父 frame 下发配置给所有子 frame。
  var lastReport = "";
  function report() {
    var st = localState();
    lastReport = st;
    try {
      if (!IS_TOP && window.parent && window.parent !== window) {
        window.parent.postMessage({ __qyxy_report: 1, href: location.href, state: st, probe: window.__qyxy_probe }, "*");
      }
    } catch (e) {}
    return st;
  }
  function broadcastCfg(cfg) {
    try {
      for (var i = 0; i < window.frames.length; i++) {
        try { window.frames[i].postMessage({ __qyxy_cfg: cfg }, "*"); } catch (e) {}
      }
    } catch (e) {}
  }
  try {
    window.addEventListener("message", function (ev) {
      var d = ev.data;
      if (!d || typeof d !== "object") return;
      if (d.__qyxy_cfg) {                       // 父 frame 下发配置
        var c = window.__qyxy_cfg || (window.__qyxy_cfg = {});
        c.god = !!d.__qyxy_cfg.god;
        c.kill = !!d.__qyxy_cfg.kill;
        c.noAd = !!d.__qyxy_cfg.noAd;
        c.speed = d.__qyxy_cfg.speed || 1;
        if (d.__qyxy_cfg.probe) c.probe = true;
        broadcastCfg(d.__qyxy_cfg);             // 继续往下传
      }
      if (d.__qyxy_report && IS_TOP) {          // 子 frame 上报
        window.__qyxy_frames = window.__qyxy_frames || {};
        window.__qyxy_frames[d.href] = { state: d.state, probe: d.probe, t: Date.now() };
      }
    }, false);
  } catch (e) {}

  function aggState() {
    var lines = [];
    lines.push(localState());
    var f = window.__qyxy_frames || {};
    for (var k in f) if (f[k] && f[k].state) lines.push(f[k].state);
    return lines.join(" ;; ");
  }
  function aggProbe() {
    var o = [];
    for (var k in (window.__qyxy_frames || {})) {
      var fr = window.__qyxy_frames[k];
      if (fr && fr.probe) o.push(fr.probe);
    }
    return o.join("\n\n");
  }

  /* ================= 8. 状态回读（原生逐 frame 调用） ================= */
  function localState() {
    var cfg = window.__qyxy_cfg || {};
    applyAll();
    if (cfg.speed > 1.0001 || cfg.speed < 0.9999) applySpeed(cfg.speed);
    S.units = layaScan().length + globalScan().length;
    return "href=" + S.href.slice(0, 120) +
           "|eng=" + S.engine + "|laya=" + S.layaVer +
           "|game=" + (S.isGame ? 1 : 0) +
           "|top=" + (S.isTop ? 1 : 0) +
           "|units=" + S.units +
           "|spd=" + S.speedApplied +
           "|god=" + (cfg.god ? 1 : 0) + "|kill=" + (cfg.kill ? 1 : 0) +
           "|ad=" + S.adWrapped.length + "|err=" + (S.err || "-");
  }

  window.__qyxy_state = function () {
    var cfg = window.__qyxy_cfg || {};
    if (cfg.probe) {
      cfg.probe = false;
      try { window.__qyxy_probe = probe(); } catch (e) { window.__qyxy_probe = "PROBEERR " + e; }
      broadcastCfg({ god: cfg.god, kill: cfg.kill, noAd: cfg.noAd, speed: cfg.speed, probe: true });
    }
    broadcastCfg({ god: cfg.god, kill: cfg.kill, noAd: cfg.noAd, speed: cfg.speed, probe: false });
    var st = aggState();
    var pr = window.__qyxy_probe || aggProbe();
    return "QYOK::" + st + (pr ? "\nQYPROBE::\n" + pr : "");
  };
  if (!IS_TOP) setInterval(report, 700);

  log("installed isTop=" + IS_TOP + " isGame=" + IS_GAME + " engine=" + S.engine + " " + S.layaVer);
  return localState();
})();
