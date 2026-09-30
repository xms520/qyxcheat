/* QYXY_inject.js — 奇遇西游助手 Web 侧注入脚本
 * 由 gen_js.py 转成 C 字符串头文件后编入 dylib，运行时 evaluateJavaScript 注入。
 * 设计原则：引擎无关（运行时探测）+ 只做高置信度的通用改写，其余交给探针。
 */
(function () {
  if (window.__qyxy_installed) { window.__qyxy_cfg && (window.__qyxy_cfg.reload = true); return "already"; }
  window.__qyxy_installed = true;

  var S = {
    version: "1.0",
    engine: "unknown",
    engineDetail: "",
    hpKeys: [],
    units: 0,
    kills: 0,
    godHits: 0,
    adWrapped: [],
    lastErr: "",
    notes: ""
  };
  // 原生侧每秒写一次
  window.__qyxy_cfg = { god: false, kill: false, noAd: false, speed: 1.0, probe: false, tick: 0 };

  function log(s) { try { console.log("[QYXY] " + s); } catch (e) {} }

  /* ---------------- 1. 加速：包 requestAnimationFrame / performance.now ---------------- */
  var realRAF = window.requestAnimationFrame ? window.requestAnimationFrame.bind(window) : null;
  var realNow = window.performance && performance.now ? performance.now.bind(performance) : null;
  var speed = 1.0;
  var lastReal = realNow ? realNow() : Date.now();
  var virtElapsed = 0;

  window.requestAnimationFrame = function (cb) {
    if (!realRAF) return 0;
    if (speed <= 1.0001) return realRAF(cb);
    // 倍数越高，同一帧内重复回调次数越多 —— 时间轴整体前移
    var factor = Math.min(16, Math.max(1, Math.round(speed)));
    var rafId = 0;
    var first = true;
    rafId = realRAF(function step(ts) {
      if (first) { cb(ts); first = false; }
      else {
        for (var i = 1; i < factor; i++) { try { cb(ts) } catch (e) { S.lastErr = "" + e; break; } }
      }
    });
    return rafId;
  };

  if (window.performance && realNow) {
    var origPerfNow = window.performance.now;
    try {
      window.performance.now = function () {
        var r = realNow();
        if (speed <= 1.0001) { lastReal = r; virtElapsed = 0; return r; }
        var d = r - lastReal; lastReal = r;
        virtElapsed += d * speed;
        return r + virtElapsed * 0; // 保持单调；真实时间由 RAF 放大
      };
    } catch (e) {}
    void origPerfNow;
  }

  /* ---------------- 2. 引擎探测 ---------------- */
  function detectEngine() {
    var w = window, hits = [];
    if (w.cc && (w.cc.game || w.cc.director)) { S.engine = "cocos2d-js"; }
    else if (w.Laya) { S.engine = "Laya"; }
    else if (w.egret) { S.engine = "Egret"; }
    else if (w.PIXI) { S.engine = "Pixi"; }
    else if (w.Phaser) { S.engine = "Phaser"; }
    else if (w.THREE) { S.engine = "three"; }
    else if (w.createUnityInstance || w.unityFramework || w.UnityLoader) { S.engine = "UnityWebGL"; }
    else if (w.GameGlobal || w.Laya || w.fgui) { S.engine = "Laya/FGUI"; }
    else if (w.CocosEngine) { S.engine = "CocosCreator"; }
    else if (w.__globalAdapter) { S.engine = "unknown(adapter)"; }

    // 细分
    try {
      if (w.CocosEngine) {
        var v = w.CocosEngine.version || "";
        S.engineDetail = "cocos " + v +
          (w.cc && w.cc.director ? " director=yes" : "") +
          (w.cc && w.cc.game ? " game=yes" : "");
      } else if (w.egret && w.egret.sys) {
        S.engineDetail = "egret sys=" + (w.egret.sys ? 1 : 0) +
          " capi=" + (w.egret.Capabilities ? JSON.stringify(w.egret.Capabilities.runtimeType) : "?");
      } else if (w.Laya && w.Laya.version) {
        S.engineDetail = "laya " + w.Laya.version;
      }
    } catch (e) {}

    for (var k in w) {
      if (/game|engine|main|player|render|scene/i.test(k) && typeof w[k] === "object" && w[k]) hits.push(k);
      if (hits.length > 40) break;
    }
    S.notes = hits.join(",");
    return S.engine;
  }
  detectEngine();

  /* ---------------- 3. HP 字段发现（引擎无关） ---------------- */
  // 策略：从全局对象里找「对象集合」，抽查元素的数值字段，选出像 hp 的键。
  var HP_PAT   = /^(hp|Hp|HP|health|Health|life|Life|blood|Blood|curHp|curHP|maxHp|maxHP|hpmax|hpMax|nowHp|hp_now)$/;
  var MAXH_PAT = /^(maxHp|maxHP|maxhp|hpMax|hpmax|maxHealth|totalHp|fullHp)$/;
  var ATK_PAT  = /^(atk|Atk|ATK|attack|Attack|damage|Damage|hurt|Hurt|power|Power|dmg)$/;

  function sampleKeys(obj, depth) {
    // 返回 obj 中数值型字段名
    var out = [];
    try {
      for (var k in obj) {
        if (k === "parent" || k === "children" || k === "scene" || k === "world") continue;
        var v = obj[k];
        if (typeof v === "number" && isFinite(v)) out.push(k);
        if (out.length > 60) break;
      }
    } catch (e) {}
    void depth;
    return out;
  }

  function scanForUnits() {
    var cands = [];
    var roots = [];
    // 常见挂载点
    if (window.cc && cc.director && cc.director.getScene) roots.push(["cc.scene", cc.director.getScene()]);
    if (window.egret && egret.DisplayObjectContainer) {
      try { if (egret.MainContext && egret.MainContext.instance) roots.push(["egret.stage", egret.MainContext.instance.stage]); } catch (e) {}
    }
    if (window.Laya && Laya.stage) roots.push(["laya.stage", Laya.stage]);
    if (window.game && game.scene) roots.push(["game.scene", game.scene]);
    // 全局数组
    for (var k in window) {
      try {
        var v = window[k];
        if (!v) continue;
        if (Array.isArray(v) && v.length > 0) cands.push([k, v]);
        else if (typeof v === "object" && v.__classname__ && v.length > 0) cands.push([k, v]);
      } catch (e) {}
      if (cands.length > 30) break;
    }
    return { roots: roots, arrays: cands };
  }

  function inferHpKeys() {
    var found = {};
    var sc = scanForUnits();
    var pools = sc.arrays.concat(sc.roots.map(function (r) {
      var o = r[1], acc = [];
      try { if (o && o.children) { for (var i = 0; i < o.children.length && i < 200; i++) acc.push(o.children[i]); } } catch (e) {}
      return [r[0] + ".children", acc];
    }));
    pools.forEach(function (p) {
      var arr = p[1];
      if (!arr || !arr.length) return;
      var n = Math.min(arr.length, 30), checked = 0;
      for (var i = 0; i < n; i++) {
        var o = arr[i]; if (!o || typeof o !== "object") continue;
        checked++;
        sampleKeys(o).forEach(function (k) {
          if (HP_PAT.test(k)) found[k] = (found[k] || 0) + 1;
        });
      }
      if (checked) S.units = Math.max(S.units, checked);
    });
    S.hpKeys = Object.keys(found);
    return S.hpKeys;
  }
  inferHpKeys();

  /* ---------------- 4. 每帧应用：无敌 / 秒杀 ---------------- */
  var godHooked = false, killHooked = false;

  function patchUnit(obj, cfg) {
    // 无敌：把玩家单位 hp 抬回最大值
    try {
      if (cfg.god) {
        for (var i = 0; i < S.hpKeys.length; i++) {
          var k = S.hpKeys[i];
          if (MAXH_PAT.test(k)) continue;
          var maxK = null;
          for (var j = 0; j < S.hpKeys.length; j++) if (MAXH_PAT.test(S.hpKeys[j])) { maxK = S.hpKeys[j]; break; }
          if (maxK && typeof obj[maxK] === "number" && typeof obj[k] === "number") {
            if (obj[k] !== obj[maxK]) { obj[k] = obj[maxK]; S.godHits++; }
          }
        }
      }
      if (cfg.kill) {
        for (var m = 0; m < S.hpKeys.length; m++) {
          var kk = S.hpKeys[m];
          if (MAXH_PAT.test(kk)) continue;
          if (typeof obj[kk] === "number" && obj[kk] > 0) { obj[kk] = 0; S.kills++; }
        }
      }
    } catch (e) { S.lastErr = "" + e; }
  }

  function applyEachFrame() {
    var cfg = window.__qyxy_cfg || {};
    speed = cfg.speed > 1 ? cfg.speed : 1.0;
    if (!cfg.god && !cfg.kill) return;
    var sc = scanForUnits();
    sc.arrays.forEach(function (p) {
      var arr = p[1];
      try {
        for (var i = 0; i < Math.min(arr.length, 120); i++) {
          var o = arr[i];
          if (o && typeof o === "object") patchUnit(o, cfg);
        }
      } catch (e) {}
    });
    sc.roots.forEach(function (r) {
      try {
        var o = r[1];
        if (o && o.children) for (var i = 0; i < Math.min(o.children.length, 120); i++) patchUnit(o.children[i], cfg);
      } catch (e) {}
    });
    void godHooked; void killHooked;
  }

  /* ---------------- 5. 免广告 ---------------- */
  function wrapAdOnce() {
    ["showAd", "playAd", "showRewardedVideo", "showRewardAd", "playVideo", "showInterstitial",
     "showVideoAd", "loadAd", "requestAd", "showVideo"].forEach(function (name) {
      try {
        var o = window[name];
        if (typeof o === "function" && !o.__qyxy_wrapped) {
          window[name] = function () {
            var cfg = window.__qyxy_cfg || {};
            if (cfg.noAd) {
              var done = null;
              for (var i = arguments.length - 1; i >= 0; i--) {
                if (typeof arguments[i] === "function") { done = arguments[i]; break; }
              }
              try { if (done) done({ ok: true, result: 1, isEnded: true, success: true }); } catch (e) {}
              setTimeout(function () { try { if (done) done({ ok: true, result: 1, isEnded: true, success: true }); } catch (e) {} }, 30);
              return;
            }
            return o.apply(window, arguments);
          };
          window[name].__qyxy_wrapped = true;
          S.adWrapped.push(name);
        }
      } catch (e) {}
    });
    // 平台对象
    try {
      if (window.platform) {
        ["showRewardAd", "showAd", "showVideoAd"].forEach(function (n) {
          var f = window.platform[n];
          if (typeof f === "function" && !f.__qyxy_wrapped) {
            window.platform[n] = function () {
              var cfg = window.__qyxy_cfg || {};
              if (cfg.noAd) {
                try { if (window.Promise) return Promise.resolve({ result: 1, isEnded: true, ok: true }); } catch (e) {}
                return { result: 1, isEnded: true };
              }
              return f.apply(window.platform, arguments);
            };
            window.platform[n].__qyxy_wrapped = true;
            S.adWrapped.push("platform." + n);
          }
        });
      }
    } catch (e) {}
  }
  wrapAdOnce();

  /* ---------------- 6. 探针 ---------------- */
  function probe() {
    var out = [];
    out.push("=== QYXY probe " + new Date().toISOString() + " ===");
    out.push("engine=" + S.engine + "  detail=" + S.engineDetail);
    out.push("hpKeys=" + JSON.stringify(S.hpKeys));
    out.push("units=" + S.units + "  adWrapped=" + JSON.stringify(S.adWrapped));
    out.push("url=" + location.href);
    out.push("ua=" + navigator.userAgent);
    try { out.push("globalKeys=" + Object.keys(window).slice(0, 400).join(",")); } catch (e) {}
    try {
      if (window.cc && cc.director && cc.director.getScene) {
        var scn = cc.director.getScene();
        out.push("cc.scene=" + (scn && scn.name));
        if (scn && scn.children) out.push("cc.scene.children=" + scn.children.map(function (c) { return c.name || (c.__classname__ || "?"); }).join("|"));
      }
    } catch (e) {}
    try {
      if (window.egret && egret.MainContext && egret.MainContext.instance) {
        var st = egret.MainContext.instance.stage;
        out.push("egret.stage.children=" + (st && st.$children ? st.$children.length : "?"));
      }
    } catch (e) {}
    try {
      if (window.Laya && Laya.stage) out.push("laya.children=" + Laya.stage.numChildren);
    } catch (e) {}
    // 采样一个 unit
    try {
      var sc = scanForUnits();
      for (var i = 0; i < sc.arrays.length && i < 3; i++) {
        var arr = sc.arrays[i][1];
        if (arr && arr.length) {
          var o = arr[0];
          if (o && typeof o === "object") {
            var ks = [];
            for (var k in o) if (k !== "parent" && k !== "children") ks.push(k);
            out.push("sample[" + sc.arrays[i][0] + "][" + (o.__classname__ || typeof o) + "] keys=" + ks.slice(0, 60).join(","));
          }
        }
      }
    } catch (e) {}
    out.push("=== end ===");
    S.notes = out.join("\n");
    return S.notes;
  }

  /* ---------------- 7. 状态回读（原生每秒调用） ---------------- */
  window.__qyxy_state = function () {
    var cfg = window.__qyxy_cfg || {};
    applyEachFrame();
    if (cfg.probe) {
      cfg.probe = false;
      try { return "PROBE::" + probe(); } catch (e) { return "PROBE::ERR " + e; }
    }
    return "eng=" + S.engine + "|hp=" + S.hpKeys.length + "|units=" + S.units +
           "|god=" + (cfg.god ? "1" : "0") + "|kill=" + (cfg.kill ? "1" : "0") +
           "|ad=" + S.adWrapped.length + "|err=" + (S.lastErr || "-");
  };

  log("installed; engine=" + S.engine + " hpKeys=" + JSON.stringify(S.hpKeys));
  return window.__qyxy_state();
})();
