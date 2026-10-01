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

  // god   = 无敌（我方 curLife 持续拉满 + 护盾拉满）
  // kill  = 秒杀（敌方 curLife/hudun 清 0）
  // atkup = 增伤（我方 fightAttrs.attack 拉满 + miaoshaRate=100）
  // nuqi  = 满怒气（我方 nuqi=maxNuqi）
  window.__qyxy_cfg = { god: false, kill: false, noAd: false, atkup: false, nuqi: false,
                        speed: 1.0, probe: false, tick: 0 };
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

  /* ================= 4. 应用：无敌 / 秒杀（v2.2 基于判定源码） =================
   * 依据 MainLevelEnemyEntity.addHurt 源码（实测）：
   *   function addHurt(e,t,i){ if(this.entityData){ ... if(i>0){
   *       this.entityData.life--;                                  // ★ 血量判定字段 = life
   *       if(this.entityData.life<=0){ this.setActionName(D.Dead) } // ★ 死亡判定读 life
   *   }}}
   * 依据 MainLevelHeroEntity.dealwithAttack 源码（实测）：
   *   e.addHurt(hitModel, attackSound, this.entityData.attack)     // ★ 真实攻击力 = entityData.attack
   * 依据 MainLevelHeroEntity.getEnemyData 源码（实测）：
   *   if(!i || i.entityData.life<=0){ ...选新目标... }             // ★ 用 life 判死活
   * ⇒ 血条读 curLife/maxLife；战斗判定读 life / attack  ★两者不同！
   */
  var BIG = 999999999;

  function mgr() {
    try { if (window.hi && window.hi.enemyMap) return window.hi; } catch (e) {}
    try {
      for (var k in window) {
        if (/^(on|webkit|__)/.test(k)) continue;
        var v; try { v = window[k]; } catch (e) { continue; }
        if (v && typeof v === "object" && v.enemyMap && v.heroMap) return v;
      }
    } catch (e) {}
    return null;
  }

  function applyToEntityData(d, cfg) {
    if (!d || typeof d !== "object") return;
    try {
      var isEnemy = false;
      if (typeof d.isEnemy === "boolean") isEnemy = d.isEnemy;
      else if (typeof d.force === "number") isEnemy = (d.force !== 1);

      if (cfg.kill && isEnemy) {
        // ★ 判定字段：life（不是 curLife）
        if (typeof d.life === "number") d.life = 0;
        if (typeof d.curLife === "number") d.curLife = 0;      // 血条同步
        if (typeof d.hudun === "number") d.hudun = 0;
        if (typeof d.hudunNum === "number") d.hudunNum = 0;
        S.kills++;
      }

      if (cfg.god && !isEnemy) {
        // 判定血量拉满
        if (typeof d.life === "number") d.life = BIG;
        if (typeof d.maxLife === "number") {
          if (d.curLife !== d.maxLife) d.curLife = d.maxLife;
        }
        if (typeof d.hudun === "number") d.hudun = BIG;
        if (typeof d.hudunNum === "number") d.hudunNum = BIG;
        S.godHits++;
      }

      // ★ 增伤：真实攻击力字段 = entityData.attack
      if (cfg.atkup && !isEnemy) {
        if (typeof d.attack === "number" && d.attack < BIG) d.attack = BIG;
        // 同步 totalAttr（部分结算可能读它）
        try {
          if (d.totalAttr && typeof d.totalAttr.attack === "number") d.totalAttr.attack = BIG;
          if (d.totalAttr && typeof d.totalAttr.miaoshaRate === "number") d.totalAttr.miaoshaRate = 100;
        } catch (e) {}
      }

      if (cfg.nuqi && !isEnemy) {
        if (typeof d.maxNuqi === "number" && typeof d.nuqi === "number") d.nuqi = d.maxNuqi;
      }
    } catch (e) { S.err = "" + e; }
  }

  function applyToUnit(o, cfg) {
    try {
      var ks = Object.keys(o), hpK = null, maxK = null;
      for (var i = 0; i < ks.length; i++) if (HP_PAT.test(ks[i])) { hpK = ks[i]; break; }
      for (var j = 0; j < ks.length; j++) if (MAXH_PAT.test(ks[j])) { maxK = ks[j]; break; }
      if (cfg.god && hpK) {
        if (maxK && typeof o[maxK] === "number") { if (o[hpK] !== o[maxK]) { o[hpK] = o[maxK]; S.godHits++; } }
      }
      if (cfg.kill && hpK && typeof o[hpK] === "number" && o[hpK] > 0) { o[hpK] = 0; S.kills++; }
    } catch (e) {}
  }

  function applyAll() {
    var cfg = window.__qyxy_cfg || {};
    if (!cfg.god && !cfg.kill && !cfg.nuqi && !cfg.atkup) return;
    var wlog = [];
    var M = mgr();
    var n = 0;
    if (M) {
      ["enemyMap", "heroMap"].forEach(function (mk) {
        var m = null; try { m = M[mk]; } catch (e) {}
        if (!m) return;
        for (var k in m) {
          var e = m[k];
          if (!e) continue;
          var d = null; try { d = e.entityData; } catch (x) {}
          if (!d) continue;
          n++;
          var bLife = d.life, bAtk = d.attack, bNuqi = d.nuqi;
          applyToEntityData(d, cfg);
          if (cfg.kill && d.isEnemy && bLife === d.life && bLife > 0) wlog.push("life写失败(" + bLife + ")");
          if (cfg.atkup && !d.isEnemy && bAtk === d.attack && (d.attack || 0) < 1e8) wlog.push("attack写失败(" + bAtk + ")");
          if (cfg.nuqi && !d.isEnemy && bNuqi === d.nuqi) wlog.push("nuqi写失败(" + bNuqi + ")");
        }
      });
    }
    // 兜底：显示树 ATBEntity.entityData（无管理器时）
    if (n === 0) {
      var ents = collectATBEntities();
      S.units = ents.length;
      for (var i = 0; i < ents.length; i++) {
        var ed = null; try { ed = ents[i].node.entityData; } catch (e) {}
        if (ed) applyToEntityData(ed, cfg);
      }
    } else {
      S.units = n;
    }
    if (wlog.length) S.err = wlog.slice(0, 3).join(";");
    else if (S.err && /写.*失败/.test(S.err)) S.err = "";
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
  function localProbeText() {
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
               " frameRate=" + Laya.stage.frameRate + " timer.scale=" + (Laya.timer && Laya.timer.scale) +
               " designW=" + Laya.stage.designWidth + " designH=" + Laya.stage.designHeight);
        // ★ 显示树转储（3 层）：类名 + 名称 + 子数
        var treeLines = [];
        (function dump(n, d, pa) {
          if (!n || d > 3 || treeLines.length > 120) return;
          var cls = (n.constructor && n.constructor.name) || "?";
          var nm = "";
          try { nm = n.name || ""; } catch (e) {}
          var nk = "";
          try { nk = numKeys(n, 12).join(","); } catch (e) {}
          treeLines.push("      " + pa + cls + (nm ? "(" + nm + ")" : "") + (nk ? " {" + nk + "}" : ""));
          var kids = null;
          try { kids = n._children; } catch (e) {}
          if (kids && kids.length) {
            for (var q = 0; q < kids.length && q < 24; q++) dump(kids[q], d + 1, pa + "  ");
          }
        })(Laya.stage, 0, "");
        o.push("  --- Laya 显示树 ---");
        o.push(treeLines.join("\n"));
        var ls = layaScan();
        o.push("  layaUnits=" + ls.length);
        ls.slice(0, 15).forEach(function (u) {
          o.push("    " + u.path + " <" + u.cls + "> hp=[" + u.hp.join(",") + "] atk=[" + u.atk.join(",") + "] keys=[" + u.keys.join(",") + "]");
        });
      }
    } catch (e) {}
    // Laya 全局管理器 / 游戏模块
    try {
      ["gModBase", "gConfig", "gView", "ZKSDK", "globalVars", "GameData", "gameData", "DataMgr", "ConfigMgr"].forEach(function (n) {
        var v = window[n];
        if (!v) return;
        o.push("  global." + n + " = " + (typeof v) + " keys=" + keysOf(v, 60));
      });
    } catch (e) {}
    // 全局数值对象
    try {
      var gs = globalScan();
      o.push("  globalUnits=" + gs.length);
      gs.slice(0, 10).forEach(function (u) {
        o.push("    " + u.name + " <" + u.cls + "> keys=[" + u.keys.join(",") + "]");
      });
    } catch (e) {}
    // 全局对象枚举（找游戏管理器）
    try {
      var suspects = [];
      for (var kk in window) {
        if (/^(on|webkit|__|\$|_)/.test(kk)) continue;
        var vv;
        try { vv = window[kk]; } catch (e) { continue; }
        if (!vv || typeof vv !== "object") continue;
        if (Array.isArray(vv) && vv.length > 3) {
          var c0 = vv[0];
          suspects.push(kk + "[len=" + vv.length + "]<" + ((c0 && c0.constructor && c0.constructor.name) || "?") + ">");
        } else {
          var nk2 = numKeys(vv, 30);
          if (nk2.length >= 6) suspects.push(kk + "<" + ((vv.constructor && vv.constructor.name) || "?") + "> {" + nk2.slice(0, 14).join(",") + "}");
        }
        if (suspects.length > 40) break;
      }
      if (suspects.length) { o.push("  --- 全局对象候选 ---"); o.push("    " + suspects.join("\n    ")); }
    } catch (e) {}
    o.push("  speed=" + S.speedApplied + " adWrapped=" + JSON.stringify(S.adWrapped) + " err=" + (S.err || "-"));
    return o.join("\n");
  }

  /* ================= 7. 跨 frame 消息总线（postMessage 跨域合法） ================= */
  // 关键：报告必须【逐级向上中继】——游戏帧的父级是 SDK 壳，不是顶层。
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
      if (d.__qyxy_cfg) {
        var c = window.__qyxy_cfg || (window.__qyxy_cfg = {});
        c.god = !!d.__qyxy_cfg.god;
        c.kill = !!d.__qyxy_cfg.kill;
        c.noAd = !!d.__qyxy_cfg.noAd;
        c.atkup = !!d.__qyxy_cfg.atkup;
        c.nuqi = !!d.__qyxy_cfg.nuqi;
        c.speed = d.__qyxy_cfg.speed || 1;
        if (d.__qyxy_cfg.probe) c.probe = true;
        broadcastCfg(d.__qyxy_cfg);
      }
      if (d.__qyxy_report) {
        window.__qyxy_frames = window.__qyxy_frames || {};
        window.__qyxy_frames[d.href] = { state: d.state, probe: d.probe, t: Date.now() };
        // ★ 逐级向上中继，直到顶层
        if (!IS_TOP) {
          try { if (window.parent && window.parent !== window) window.parent.postMessage(d, "*"); } catch (e) {}
        }
      }
    }, false);
  } catch (e) {}

  function aggState() {
    var lines = [localState()];
    var f = window.__qyxy_frames || {};
    for (var k in f) if (f[k] && f[k].state) lines.push(f[k].state);
    return lines.join(" ;; ");
  }
  function aggProbe() {
    var o = [];
    var f = window.__qyxy_frames || {};
    for (var k in f) if (f[k] && f[k].probe) o.push(f[k].probe);
    return o.join("\n\n");
  }

  /* ================= 6b. 深度目标探针（v1.7） ================= */
  // ★ 核心技巧：序列化器/构造函数的 toString() 源码里直接写着字段名 —— 不用猜
  function extractFieldsFromFn(fn, maxNames) {
    var s = "";
    try { s = fn.toString(); } catch (e) { return null; }
    if (!s || s.length < 10) return null;
    var out = [], seen = {};
    // 抽 this.xxx = / .xxx = / "xxx" / 'xxx' / e.xxx
    var re = /(?:^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]{1,32})\s*(?==|:|,|\])/g, m;
    while ((m = re.exec(s)) !== null) {
      var k = m[1];
      if (/^(var|let|const|function|return|new|this|if|else|for|while|typeof|true|false|null|undefined|case|break|switch|default|try|catch)$/.test(k)) continue;
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(k);
      if (out.length >= (maxNames || 60)) break;
    }
    return { len: s.length, fields: out, head: s.slice(0, 420).replace(/\s+/g, " ") };
  }

  // 枚举 Laya.ClassUtils 的真实键名
  function classUtilsKeys() {
    var o = [];
    try {
      var cu = window.Laya && Laya.ClassUtils;
      if (!cu) return ["<无 Laya.ClassUtils>"];
      var ks = [];
      for (var k in cu) ks.push(k + ":" + (typeof cu[k]));
      o.push("ClassUtils keys = " + ks.join(", "));
      // 逐个尝试常见的类表键
      ks.forEach(function (kk) {
        var name = kk.split(":")[0];
        var v = cu[name];
        if (v && typeof v === "object") {
          var n = 0, sample = [];
          for (var q in v) { n++; if (sample.length < 200 && /Battle|Fight|Entity|Unit|Hero|Monster|Mgr|Manager|Model|Data|Buff|Skill|Role|Attr/i.test(q)) sample.push(q); }
          o.push("  " + name + " = object{" + n + "} 战斗相关=" + sample.length);
          if (sample.length) o.push("    " + sample.join("\n    "));
        }
      });
    } catch (e) { o.push("ERR " + e); }
    return o;
  }

  function dumpObj(v, lim) {
    var o = [], n = 0;
    try {
      for (var k in v) {
        var x; try { x = v[k]; } catch (e) { o.push(k + "=<throw>"); continue; }
        var t = typeof x;
        if (t === "number" || t === "string" || t === "boolean") o.push(k + "=" + (t === "string" ? JSON.stringify(String(x).slice(0, 80)) : x));
        else if (t === "function") o.push(k + "=fn");
        else if (x === null) o.push(k + "=null");
        else if (x === undefined) o.push(k + "=undef");
        else if (Array.isArray(x)) o.push(k + "=Array(" + x.length + ")");
        else o.push(k + "=" + ((x && x.constructor && x.constructor.name) || t));
        if (++n >= (lim || 300)) { o.push("...(+" + n + ")"); break; }
      }
    } catch (e) { o.push("ERR " + e); }
    return o.join("\n      ");
  }

  // 从 Laya 容器递归收集「实体对象」（Sprite 子节点上的业务引用）
  function collectEntities() {
    var out = [], seen = [];
    if (!window.Laya || !Laya.stage) return out;
    function findByName(n, name) {
      if (!n) return null;
      try { if ((n.constructor && n.constructor.name) === name) return n; } catch (e) {}
      var kids = null; try { kids = n._children; } catch (e) {}
      if (kids) for (var i = 0; i < kids.length; i++) { var r = findByName(kids[i], name); if (r) return r; }
      return null;
    }
    function walk(n, depth, path) {
      if (!n || depth > 6 || out.length > 60) return;
      if (seen.indexOf(n) >= 0) return;
      seen.push(n);
      // 节点自身的「非 Laya 内部」字段
      var extra = [];
      try {
        var ks = Object.keys(n);
        for (var i = 0; i < ks.length && extra.length < 30; i++) {
          var k = ks[i];
          if (/^(_|$|on[A-Z]|destroyed|name$|visible|zOrder|mouseState|renderType|texture|graphics)/.test(k)) continue;
          var v = n[k], t = typeof v;
          if (t === "number") extra.push(k + "=" + v);
          else if (t === "string") extra.push(k + "=" + JSON.stringify(String(v).slice(0, 40)));
          else if (v && t === "object") extra.push(k + "=" + ((v.constructor && v.constructor.name) || "obj"));
        }
      } catch (e) {}
      if (extra.length) {
        var cls = ""; try { cls = (n.constructor && n.constructor.name) || "?"; } catch (e) {}
        out.push(path + " <" + cls + "> " + extra.join(" "));
      }
      var kids = null; try { kids = n._children; } catch (e) {}
      if (kids) for (var j = 0; j < kids.length && j < 40; j++) walk(kids[j], depth + 1, path + "/" + j);
    }
    try {
      var atb = findByName(Laya.stage, "GameSceneATB");
      if (atb) {
        ["gameMap", "entityContainer", "entityFighttingContainer", "entityFightMark", "entityBottomContainer", "hurtContainer", "viewContainer"].forEach(function (k) {
          var v = null; try { v = atb[k]; } catch (e) {}
          if (!v) return;
          out.push(">> ATB." + k + " <" + ((v.constructor && v.constructor.name) || typeof v) + ">");
          if (v.numChildren !== undefined) out.push("   numChildren=" + v.numChildren);
          walk(v, 0, "ATB." + k);
        });
      }
    } catch (e) { out.push("ATB ERR " + e); }
    return out;
  }

  // 全局对象里找「带战斗单位特征」的对象
  function findBattleContainers() {
    var hits = [];
    try {
      for (var k in window) {
        if (/^(on|webkit|__qyxy)/.test(k)) continue;
        var v; try { v = window[k]; } catch (e) { continue; }
        if (!v || typeof v !== "object") continue;
        var cn = ""; try { cn = (v.constructor && v.constructor.name) || ""; } catch (e) {}
        if (/Battle|Fight|Entity|Unit|Hero|Monster|Enemy|Actor|Team|Army|Scene/i.test(k + cn)) {
          var ks = [];
          try { for (var q in v) { ks.push(q); if (ks.length > 80) break; } } catch (e) {}
          hits.push("GLOBAL " + k + " <" + cn + "> keys=" + ks.join(","));
        }
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object") {
          var ks2 = [], sc = 0;
          try {
            for (var q2 in v[0]) {
              ks2.push(q2);
              if (HP_PAT.test(q2) || MAXH_PAT.test(q2) || ATK_PAT.test(q2)) sc += 3;
              if (ks2.length > 80) break;
            }
          } catch (e) {}
          if (sc >= 3) hits.push("ARRAY " + k + "[len=" + v.length + "] score=" + sc + " keys=" + ks2.join(","));
        }
      }
    } catch (e) {}
    return hits;
  }

  function windowInventory() {
    var rows = [];
    try {
      for (var k in window) {
        if (/^(on|webkit|__qyxy)/.test(k)) continue;
        var v; try { v = window[k]; } catch (e) { continue; }
        if (v === null || v === undefined) continue;
        var t = typeof v;
        if (t === "function") { rows.push(k + ":fn"); continue; }
        if (t !== "object") continue;
        var cn = "?"; try { cn = (v.constructor && v.constructor.name) || "?"; } catch (e) {}
        if (Array.isArray(v)) { rows.push(k + ":" + cn + "[len=" + v.length + "]"); continue; }
        var n = 0; try { for (var q in v) { n++; if (n > 500) break; } } catch (e) {}
        rows.push(k + ":" + cn + "{" + n + "}");
        if (rows.length > 300) break;
      }
    } catch (e) {}
    return rows;
  }

  /* ================= 6c. 实体数据深挖（v1.8） ================= */
  // 找 GameSceneATB 节点
  function findATBNode() {
    var node = null;
    if (!window.Laya || !Laya.stage) return null;
    (function fnd(n, d) {
      if (!n || node || d > 8) return;
      try { if ((n.constructor && n.constructor.name) === "GameSceneATB") { node = n; return; } } catch (e) {}
      var kk = null; try { kk = n._children; } catch (e) {}
      if (kk) for (var i = 0; i < kk.length; i++) fnd(kk[i], d + 1);
    })(Laya.stage, 0);
    return node;
  }

  // 收集 ATBEntity 节点
  function collectATBEntities() {
    var out = [];
    var atb = findATBNode();
    if (!atb) return out;
    ["entityContainer", "entityFighttingContainer", "entityFightMark", "entityBottomContainer"].forEach(function (ck) {
      var c = null; try { c = atb[ck]; } catch (e) {}
      if (!c || !c.numChildren) return;
      for (var i = 0; i < c.numChildren && out.length < 30; i++) {
        var ch = null;
        try { ch = c.getChildAt(i); } catch (e) {}
        if (!ch) continue;
        var cn = ""; try { cn = (ch.constructor && ch.constructor.name) || ""; } catch (e) {}
        if (/ATBEntity|Entity/.test(cn)) out.push({ container: ck, index: i, node: ch, cls: cn });
      }
    });
    return out;
  }

  // 静态字段表：class X { constructor(){ r(this, X.propertys) } }
  function dumpPropertys() {
    var o = [];
    var names = ["SBattleFightEntity", "SBattleEntity", "SBattleInfo", "SBattleArrayData", "SBattleArrayInfo",
                 "SFightAttribute", "SFightAttrs", "SAttribute", "SMiniPlayer", "SPublicPlayer",
                 "TPlayerHero", "TPlayer", "TPlayerRole", "TPlayerExtend", "TPlayerAnimal", "TPlayerZhenFa",
                 "AttrData", "FightHurtData", "HeroData", "HeroMonsterData", "DataEntity", "CLevel"];
    names.forEach(function (n) {
      var f = window[n] || (window.msg && window.msg[n]);
      if (typeof f !== "function") { o.push("  " + n + " = 非函数/" + (typeof f)); return; }
      var p = f.propertys;
      if (p === undefined) {
        // 尝试在原型/自身找
        var cand = null;
        try { for (var k in f) { if (/propert|PROPERT|field|Field/i.test(k)) { cand = f[k]; break; } } } catch (e) {}
        if (cand) p = cand;
      }
      if (p === undefined) { o.push("  " + n + ".propertys = undefined（另有键: " + (function () { try { return Object.keys(f).join(","); } catch (e) { return "?"; } })() + "）"); return; }
      var s = "";
      try { s = JSON.stringify(p); } catch (e) { s = "[" + String(p) + "]"; }
      o.push("  ★ " + n + ".propertys = " + (s || "").slice(0, 3000));
    });
    return o;
  }

  // 真实 entityData 转储
  function dumpEntityData() {
    var o = [];
    var ents = collectATBEntities();
    o.push("  ATBEntity 数 = " + ents.length);
    ents.slice(0, 6).forEach(function (e) {
      var ed = null; try { ed = e.node.entityData; } catch (err) {}
      var cn = "?"; try { cn = (ed && ed.constructor && ed.constructor.name) || typeof ed; } catch (err) {}
      o.push("  -- " + e.container + "[" + e.index + "] <" + e.cls + ">  entityData=<" + cn + ">");
      if (ed && typeof ed === "object") {
        o.push("     keys: " + (function () { try { return Object.keys(ed).join(","); } catch (x) { return "ERR"; } })());
        o.push("     dump:\n       " + dumpObj(ed, 120));
      }
      // 节点自身业务字段
      ["entityData", "attrData", "heroData", "configData", "posIndex", "maxNuQi", "nuQi", "hp", "curHp", "attr"].forEach(function (k) {
        var v = null;
        try { v = e.node[k]; } catch (err) { return; }
        if (v === undefined) return;
        if (typeof v === "object" && v) o.push("     node." + k + " = <" + ((v.constructor && v.constructor.name) || "obj") + ">");
        else o.push("     node." + k + " = " + v);
      });
    });
    return o;
  }

  /* ================= 6d. 战斗引擎定位（v2.0） ================= */
  // 类原型方法清单 —— 直接暴露游戏的钩点 API（hurt/die/checkDead...）
  function protoMethods(name) {
    var c = window[name];
    if (typeof c !== "function") return name + " = 非类(" + (typeof c) + ")";
    var names = [];
    try { names = Object.getOwnPropertyNames(c.prototype || {}); } catch (e) {}
    names = names.filter(function (n) { return n !== "constructor"; });
    return name + " (" + names.length + ") = " + names.join(", ");
  }

  // 在 Laya 显示树里找某类的实例
  function findInstances(clsName, maxDepth) {
    var c = window[clsName];
    if (typeof c !== "function") return [];
    var found = [];
    if (!window.Laya || !Laya.stage) return found;
    var seen = [];
    (function walk(n, d, path) {
      if (!n || d > (maxDepth || 10) || found.length > 12) return;
      if (seen.indexOf(n) >= 0) return;
      seen.push(n);
      try { if (n instanceof c) found.push(path + " <" + ((n.constructor && n.constructor.name) || "?") + ">"); } catch (e) {}
      var kids = null; try { kids = n._children; } catch (e) {}
      if (kids) for (var i = 0; i < kids.length && i < 60; i++) walk(kids[i], d + 1, path + "/" + i);
    })(Laya.stage, 0, "stage");
    return found;
  }

  // 场景里所有出现过的类名清单（看战斗引擎到底在哪）
  function sceneClassInventory() {
    if (!window.Laya || !Laya.stage) return "无 Laya.stage";
    var m = {};
    var seen = [], cnt = 0;
    (function walk(n, d) {
      if (!n || d > 12 || cnt > 6000) return;
      if (seen.indexOf(n) >= 0) return;
      seen.push(n); cnt++;
      var cn = "?"; try { cn = (n.constructor && n.constructor.name) || "?"; } catch (e) {}
      m[cn] = (m[cn] || 0) + 1;
      var kids = null; try { kids = n._children; } catch (e) {}
      if (kids) for (var i = 0; i < kids.length && i < 80; i++) walk(kids[i], d + 1);
    })(Laya.stage, 0);
    var arr = [];
    for (var k in m) arr.push(k + "×" + m[k]);
    arr.sort();
    return "节点总数=" + cnt + " 类数=" + arr.length + "\n    " + arr.join(", ");
  }

  // ATBEntity 节点全键（含 _ 前缀，不筛选）
  function dumpEntityNodeFull() {
    var o = [];
    var ents = collectATBEntities();
    ents.slice(0, 4).forEach(function (e) {
      o.push("  [" + e.container + "/" + e.index + "] <" + e.cls + "> 全键:");
      o.push("    " + dumpObj(e.node, 200));
      // 原型方法
      var pn = [];
      try { pn = Object.getOwnPropertyNames(Object.getPrototypeOf(e.node) || {}); } catch (x) {}
      o.push("    原型方法: " + pn.filter(function (x) { return x !== "constructor"; }).join(", "));
    });
    return o;
  }

  // 战斗属性真实容器（fightAttrs / totalAttr）
  function dumpFightAttr() {
    var o = [];
    var ents = collectATBEntities();
    ents.slice(0, 3).forEach(function (e) {
      var d = null; try { d = e.node.entityData; } catch (x) {}
      if (!d) return;
      o.push("  [" + e.index + "] curLife=" + d.curLife + "/" + d.maxLife + " nuqi=" + d.nuqi + "/" + d.maxNuqi +
             " force=" + d.force + " isEnemy=" + d.isEnemy);
      var fa = d.fightAttrs;
      if (fa) {
        o.push("    fightAttrs <" + ((fa.constructor && fa.constructor.name) || "?") + "> keys=" +
               (function () { try { return Object.keys(fa).join(","); } catch (x) { return "ERR"; } })());
        o.push("    fightAttrs dump:\n      " + dumpObj(fa, 120));
      } else o.push("    fightAttrs = " + fa);
      var ta = d.totalAttr;
      if (ta) {
        o.push("    totalAttr <" + ((ta.constructor && ta.constructor.name) || "?") + "> = " +
               (function () { try { return JSON.stringify(ta).slice(0, 1200); } catch (x) { return "ERR"; } })());
      } else o.push("    totalAttr = " + ta);
    });
    return o;
  }

  // ★ 读关键方法源码 —— 直接看判定逻辑读什么、写什么
  function dumpMethodSource(clsName, methodNames) {
    var o = [];
    var c = window[clsName];
    if (typeof c !== "function") { o.push("  " + clsName + " = 非类"); return o; }
    methodNames.forEach(function (m) {
      var f = null;
      try { f = c.prototype && c.prototype[m]; } catch (e) {}
      if (typeof f !== "function") { o.push("  " + clsName + "." + m + " = 不存在"); return; }
      var s = "";
      try { s = f.toString(); } catch (e) { s = "<无法读取>"; }
      o.push("  ★ " + clsName + "." + m + "  (srcLen=" + s.length + ")");
      o.push("      " + s.replace(/\s+/g, " ").slice(0, 1800));
    });
    return o;
  }

  /* ================= 6e. 判定/伤害方法源码（v2.1） ================= */
  function dumpBattleLogic() {
    var o = [];
    o.push("[ATBEntity 判定与更新]");
    o.push(dumpMethodSource("ATBEntity",
      ["isDeath", "checkDeath", "updateLife", "fightEntityData", "updateNuQi", "updateHuDun", "onAttackFrame"]).join("\n"));
    o.push("\n[MainLevelEntityBase 战斗基类]");
    o.push(dumpMethodSource("MainLevelEntityBase",
      ["dealwithAttack", "onAttackFrame", "canFight", "updateEntityData", "frameLoop"]).join("\n"));
    o.push("\n[MainLevelHeroEntity 我方]");
    o.push(dumpMethodSource("MainLevelHeroEntity",
      ["addHurt", "dealwithAttack", "getEnemyData", "isSameSide", "updateEntityData"]).join("\n"));
    o.push("\n[MainLevelEnemyEntity 敌方]");
    o.push(dumpMethodSource("MainLevelEnemyEntity",
      ["addHurt", "dealwithAttack", "getHeroData", "updateEntityData"]).join("\n"));
    o.push("\n[DisPlayEntity 表现层]");
    o.push(dumpMethodSource("DisPlayEntity",
      ["checkDeath", "isDeath", "showHurt", "updateLife", "render"]).join("\n"));
    return o;
  }

  // 全局找 MainLevel* 实例（不在显示树，可能挂在别的对象上）
  function findLogicInstances() {
    var o = [];
    var cls = {};
    ["MainLevelFightManager", "MainLevelEntityData", "MainLevelEntityBase",
     "MainLevelHeroEntity", "MainLevelEnemyEntity"].forEach(function (n) {
      if (typeof window[n] === "function") cls[n] = window[n];
    });
    var hits = {};
    var scanned = 0, seen = [];
    function scan(obj, path, depth) {
      if (!obj || depth > 3 || scanned > 4000) return;
      var t = typeof obj;
      if (t !== "object" && t !== "function") return;
      if (seen.indexOf(obj) >= 0) return;
      seen.push(obj); scanned++;
      for (var n in cls) {
        try { if (obj instanceof cls[n]) { hits[n] = (hits[n] || 0) + 1; if ((hits[n] || 0) <= 3) o.push("  " + n + " @ " + path); } } catch (e) {}
      }
      if (depth >= 3) return;
      var ks = [];
      try { ks = Object.keys(obj); } catch (e) { return; }
      for (var i = 0; i < ks.length && i < 120; i++) {
        var k = ks[i];
        if (/^(top|parent|self|window|document|location|frames|_children|__)/.test(k)) continue;
        var v; try { v = obj[k]; } catch (e) { continue; }
        if (!v || (typeof v !== "object" && typeof v !== "function")) continue;
        scan(v, path + "." + k, depth + 1);
      }
    }
    try { scan(window, "window", 0); } catch (e) { o.push("  scanERR " + e); }
    o.unshift("  扫描对象数=" + scanned + "  命中=" + JSON.stringify(hits));
    return o;
  }

  /* ================= 6f. 战斗管理器定位（v2.2） ================= */
  // 从源码确认：全局短名 hi = 战斗管理器（enemyMap/heroMap/getEnemyEntity/showFlyText）
  function findBattleMgr() {
    var cands = [];
    // 直接短名
    ["hi", "Me", "D", "tt", "U", "Y", "Ie", "A", "di", "G"].forEach(function (n) {
      try { if (window[n] !== undefined) cands.push(n); } catch (e) {}
    });
    // 特征匹配：含 enemyMap + heroMap 的对象
    var found = null, foundName = null;
    try {
      for (var k in window) {
        if (/^(on|webkit|__)/.test(k)) continue;
        var v; try { v = window[k]; } catch (e) { continue; }
        if (!v || typeof v !== "object") continue;
        if (v.enemyMap && v.heroMap) { found = v; foundName = k; break; }
      }
    } catch (e) {}
    return { shortNames: cands, mgr: found, mgrName: foundName };
  }

  function dumpBattleMgr() {
    var o = [];
    var r = findBattleMgr();
    o.push("  可达短名: " + (r.shortNames.join(",") || "无"));
    o.push("  特征匹配管理器: " + (r.mgrName || "未找到"));

    var M = r.mgr || window[r.mgrName];
    if (!M) {
      // 退一步：试 window.hi
      try { M = window.hi; } catch (e) {}
    }
    if (!M) { o.push("  ⚠️ 无法取得战斗管理器"); return o; }

    o.push("  管理器键: " + (function () { try { return Object.keys(M).join(","); } catch (e) { return "ERR"; } })());
    ["enemyMap", "heroMap"].forEach(function (mk) {
      var m = null; try { m = M[mk]; } catch (e) {}
      if (!m) { o.push("  " + mk + " 不存在"); return; }
      var ks = [];
      try { ks = Object.keys(m); } catch (e) {}
      o.push("  " + mk + " 键数=" + ks.length + " -> " + ks.join(","));
      ks.slice(0, 6).forEach(function (k) {
        var e = m[k];
        if (!e) return;
        var cn = "?"; try { cn = (e.constructor && e.constructor.name) || "?"; } catch (x) {}
        o.push("    [" + k + "] <" + cn + ">");
        var ed = null; try { ed = e.entityData; } catch (x) {}
        if (ed) {
          o.push("      entityData 全键: " + (function () { try { return Object.keys(ed).join(","); } catch (x) { return "ERR"; } })());
          o.push("      关键值: life=" + ed.life + " attack=" + ed.attack + " id=" + ed.id +
                 " curLife=" + ed.curLife + "/" + ed.maxLife + " force=" + ed.force +
                 " isEnemy=" + ed.isEnemy + " posIndex=" + ed.posIndex + " nuqi=" + ed.nuqi + "/" + ed.maxNuqi);
          o.push("      全量 dump:\n        " + dumpObj(ed, 80));
        } else o.push("      entityData = " + ed);
        // 节点自身的关键字段
        o.push("      节点: _actionName=" + (e._actionName || e.actionName) + " x=" + e.x + " y=" + e.y);
      });
    });
    // 动作枚举
    try {
      var D = window.D;
      if (D) {
        o.push("  D(动作枚举) 键: " + Object.keys(D).slice(0, 40).join(","));
        if (D.Dead) o.push("    D.Dead = " + JSON.stringify(D.Dead));
        if (D.isAttackAction) o.push("    D.isAttackAction = fn");
      } else o.push("  window.D 不可达");
    } catch (e) {}
    return o;
  }

  /* ================= 7b. 同源 iframe 递归走访（appack 平台壳可直达 SDK 壳） ================= */
  function walkSameOrigin(w, tag, depth, out) {
    if (!w || depth > 4) return;
    var doc = null;
    try { doc = w.document; } catch (e) { out.push("[" + tag + "] 跨域，无法读取（需 postMessage 上报）"); return; }
    if (!doc) return;
    try { out.push("[" + tag + "] href=" + (w.location && w.location.href)); } catch (e) {}
    var eng = "?";
    try {
      if (w.Laya) eng = "LayaAir " + (w.Laya.__version__ || w.Laya.version || "");
      else if (w.CocosEngine) eng = "CocosCreator " + (CocosEngine.version || "");
      else if (w.cc && w.cc.director) eng = "cocos2d-js";
      else if (w.egret) eng = "Egret";
      else if (w.PIXI) eng = "Pixi";
      else if (w.Phaser) eng = "Phaser";
      else if (w.createUnityInstance) eng = "UnityWebGL";
    } catch (e) {}
    try { out.push("[" + tag + "] engine=" + eng + " canvas=" + doc.querySelectorAll("canvas").length); } catch (e) {}
    try {
      var ks = Object.keys(w).filter(function (k) { return !/^(on|webkit)/.test(k) && typeof w[k] !== "function"; });
      var interesting = ks.filter(function (k) { return /game|Game|mod|Mod|cfg|Cfg|view|View|global|Global|Util|SDK|sdk/.test(k); });
      if (interesting.length) out.push("[" + tag + "] globals=" + interesting.slice(0, 45).join(","));
    } catch (e) {}
    try {
      if (w.Laya && w.Laya.stage) {
        out.push("[" + tag + "] Laya.stage numChildren=" + w.Laya.stage.numChildren +
                 " frameRate=" + w.Laya.stage.frameRate + " timer.scale=" + (w.Laya.timer && w.Laya.timer.scale));
      }
    } catch (e) {}
    var fs = null;
    try { fs = doc.querySelectorAll("iframe"); } catch (e) {}
    if (fs) {
      for (var i = 0; i < fs.length; i++) {
        var src = "";
        try { src = fs[i].src || fs[i].id || "?"; } catch (e) {}
        out.push("[" + tag + "] iframe[" + i + "] " + String(src).slice(0, 150));
        try { walkSameOrigin(fs[i].contentWindow, tag + ".if" + i, depth + 1, out); } catch (e) { out.push("  (不可读)"); }
      }
    }
  }

  /* ================= 8. 状态回读（原生逐 frame 调用 + 子帧定时上报） ================= */
  function localState() {
    detect();                     // ★ 每次重新探测：脚本在 AtDocumentStart 注入时 Laya 尚未加载
    var cfg = window.__qyxy_cfg || {};
    applyAll();
    if (cfg.speed > 1.0001 || cfg.speed < 0.9999) applySpeed(cfg.speed);
    maybeProbe();                 // ★ 子帧也要能生成探针（此前只有顶层 __qyxy_state 处理 probe）
    var hp = "", uN = 0;
    var M = mgr();
    if (M) {
      ["enemyMap", "heroMap"].forEach(function (mk) {
        var m = null; try { m = M[mk]; } catch (e) {}
        if (!m) return;
        for (var k in m) {
          var e = m[k]; if (!e) continue;
          var d = null; try { d = e.entityData; } catch (x) {}
          if (!d) continue;
          uN++;
          if (uN <= 4) hp += (hp ? " " : "") + (d.isEnemy ? "E" : "H") + d.life + "/" + d.curLife;
        }
      });
    }
    if (!uN) {
      var ents = collectATBEntities();
      uN = ents.length;
      if (ents.length) {
        var e0 = null; try { e0 = ents[0].node.entityData; } catch (e) {}
        if (e0) hp = e0.curLife + "/" + e0.maxLife;
      }
    }
    S.units = uN;
    return "href=" + S.href.slice(0, 90) +
           "|eng=" + S.engine + "|laya=" + S.layaVer +
           "|game=" + (S.isGame ? 1 : 0) +
           "|units=" + S.units +
           "|hp=" + (hp || "-") +
           "|spd=" + S.speedApplied +
           "|god=" + (cfg.god ? 1 : 0) + "|kill=" + (cfg.kill ? 1 : 0) +
           "|atk=" + (cfg.atkup ? 1 : 0) + "|nuqi=" + (cfg.nuqi ? 1 : 0) +
           "|ad=" + S.adWrapped.length + "|err=" + (S.err || "-");
  }

  function maybeProbe() {
    var cfg = window.__qyxy_cfg || {};
    if (!cfg.probe) return;
    cfg.probe = false;
    var o = [];
    if (IS_TOP) {
      o.push("=== QYXY probe v4 " + new Date().toISOString() + " ===");
      o.push(localProbeText());
      o.push("\n--- 同源 iframe 递归走访 ---");
      try { walkSameOrigin(window, "top", 0, o); } catch (e) { o.push("walkERR " + e); }
      o.push("\n--- 跨域 frame 上报（postMessage） ---");
      var f = window.__qyxy_frames || {};
      for (var k in f) if (f[k] && f[k].probe) o.push(f[k].probe);
      o.push("\n--- 跨域 frame 状态 ---");
      for (var k2 in f) if (f[k2] && f[k2].state) o.push(f[k2].state);
    } else {
      o.push(localProbeText());
      o.push("  units=" + S.units + " speed=" + S.speedApplied + " ad=" + JSON.stringify(S.adWrapped));
      // ★ 游戏帧专属深挖
      if (S.isGame) {
        o.push("\n--- ★★★ 战斗管理器（hi）与实体地图 ---");
        o.push(dumpBattleMgr().join("\n"));

        o.push("\n--- ★★★ 判定/伤害方法源码 ---");
        o.push(dumpBattleLogic().join("\n"));

        o.push("\n--- ★★ 判定方法源码（补充类） ---");
        ["MainLevelEnemyEntity", "MainLevelHeroEntity", "MainLevelEntityBase"].forEach(function (n) {
          var c = window[n];
          if (typeof c !== "function") return;
          var pn = [];
          try { pn = Object.getOwnPropertyNames(c.prototype || {}).filter(function (x) { return x !== "constructor"; }); } catch (e) {}
          o.push("  " + n + " 全部方法源码:");
          pn.forEach(function (m) {
            var f = null; try { f = c.prototype[m]; } catch (e) {}
            if (typeof f !== "function") return;
            var src = ""; try { src = f.toString(); } catch (e) { return; }
            if (src.length < 20) return;
            o.push("    ▸ " + n + "." + m + " (" + src.length + ") " + src.replace(/\s+/g, " ").slice(0, 700));
          });
        });

        o.push("\n--- ★★ 场景类清单 ---");
        o.push("  " + sceneClassInventory());

        o.push("\n--- ★★ fightAttrs / totalAttr 真实内容 ---");
        o.push(dumpFightAttr().join("\n"));

        o.push("\n--- 序列化器静态字段表 propertys ---");
        o.push(dumpPropertys().join("\n"));

        o.push("\n--- window 类清单（游戏自有类） ---");
        o.push("  " + windowInventory().join("\n  "));
      }
    }
    window.__qyxy_probe = o.join("\n");
  }

  window.__qyxy_state = function () {
    var cfg = window.__qyxy_cfg || {};
    var st = localState();                                   // 内部会处理 probe（含递归走访）
    var pr = window.__qyxy_probe || aggProbe();
    // 让子帧生成各自探针
    broadcastCfg({ god: cfg.god, kill: cfg.kill, noAd: cfg.noAd, atkup: cfg.atkup, nuqi: cfg.nuqi, speed: cfg.speed, probe: true });
    broadcastCfg({ god: cfg.god, kill: cfg.kill, noAd: cfg.noAd, atkup: cfg.atkup, nuqi: cfg.nuqi, speed: cfg.speed, probe: false });
    return "QYOK::" + st + (pr ? "\nQYPROBE::\n" + pr : "");
  };
  if (!IS_TOP) {
    setInterval(report, 700);
    // 子帧若收到 probe 请求，生成后立刻上报（避免等 700ms 周期）
    setInterval(function () {
      var c = window.__qyxy_cfg || {};
      if (c.probe) { localState(); report(); }
    }, 300);
  }

  log("installed isTop=" + IS_TOP + " isGame=" + IS_GAME + " engine=" + S.engine + " " + S.layaVer);
  return localState();
})();
