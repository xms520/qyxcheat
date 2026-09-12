// QYXCheat v1 — 奇遇西行(Replayable) 无敌/秒杀/全局加速
// 逆向定案(2026-09-12, 静态分析 10.3MB arm64 主二进制):
//   游戏引擎: WantingIINKEngine (类名混淆但完整存在)
//   单位模型: AdjusterUnit {double hp, maxHp, shield, def; int64 level, slot, intent...}
//   敌方列表: WantingIINKEngine.sashimiUnits (NSMutableArray, putbackCards 生成敌人 addObject, 战斗遍历 smashesDead 判死)
//   伤害结算: -[WantingIINKEngine centerPartakeClicled:to:from:] imp=0x100069904
//             -(void)centerPartakeClicled:(double)dmg to:(id)victim from:(id)attacker
//             内部: dmg *= awardedTremolo倍率; shield 抵扣; victim.hp = max(0, hp-剩余dmg)
//   主循环: NeedshowController.checkXMPPTimeOutBordersTick (NSTimer 1.0s repeats)
//
// Hook 策略(method_setImplementation, 类不存在则跳过):
//   1) 伤害函数: 无敌=victim 不在 sashimiUnits → 直接 return
//                秒杀=victim 在 sashimiUnits → dmg = hp+shield+1e9
//   2) 主循环: 加速倍数 k → 每 tick 调原实现 k 次(纯数值加速, 不动动画)
// UI: 悬浮球+面板 3 开关(无敌/秒杀/加速xN)
// 日志: /var/mobile/Library/Logs/qyx_cheat.log

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <mach-o/dyld.h>
#import <dlfcn.h>

// ---------- 配置 ----------
static const char *kLogFile = "/var/mobile/Library/Logs/qyx_cheat.log";
static BOOL g_god = NO;      // 无敌
static BOOL g_kill = NO;     // 秒杀
static int  g_speedMult = 1; // 加速倍数 1/2/3/5
static BOOL g_dumped = NO;   // 敌我判定日志只打一次

// ---------- 日志 ----------
static void QYLog(NSString *fmt, ...) {
    va_list args; va_start(args, fmt);
    NSString *msg = [[NSString alloc] initWithFormat:fmt arguments:args];
    va_end(args);
    NSString *line = [NSString stringWithFormat:@"[%@] %@\n",
        [NSDateFormatter localizedStringFromDate:[NSDate date]
                                        dateStyle:NSDateFormatterNoDateStyle
                                        timeStyle:NSDateFormatterMediumStyle], msg];
    dispatch_async(dispatch_get_global_queue(0,0), ^{
        FILE *f = fopen(kLogFile, "a");
        if (f) { fputs(line.UTF8String, f); fclose(f); }
    });
}

// ---------- 悬浮 UI ----------
@interface QYPanelView : UIView
@property (nonatomic, strong) UIButton *godBtn, *killBtn, *spdBtn, *closeBtn;
@end

@interface QYFloatView : UIView
@property (nonatomic, strong) UIButton *ball;
@property (nonatomic, strong) QYPanelView *panel;
- (void)togglePanel;
@end

static UIView *FGKeyWindow(void) {
    for (UIScene *sc in [UIApplication sharedApplication].connectedScenes) {
        if ([sc isKindOfClass:[UIWindowScene class]]) {
            UIWindowScene *ws = (UIWindowScene *)sc;
            for (UIWindow *w in ws.windows)
                if (w.isKeyWindow) return w;
        }
    }
    UIWindow *mw = [UIApplication sharedApplication].keyWindow;
    return mw;
}

@implementation QYPanelView
- (instancetype)initWithFrame:(CGRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    self.backgroundColor = [UIColor colorWithWhite:0 alpha:0.72];
    self.layer.cornerRadius = 14;
    self.layer.masksToBounds = YES;

    UILabel *title = [[UILabel alloc] initWithFrame:CGRectMake(12, 10, frame.size.width-24, 18)];
    title.text = @"奇遇西行";
    title.textColor = [UIColor whiteColor];
    title.font = [UIFont boldSystemFontOfSize:14];
    [self addSubview:title];

    _godBtn = [self btn:@"🛡 无敌" y:34];
    _killBtn = [self btn:@"⚔ 秒杀" y:44+46];
    _spdBtn = [self btn:@"⏩ 加速" y:54+92];
    _closeBtn = [self btn:@"✕ 关闭面板" y:64+138];
    [self refresh];
    return self;
}
- (UIButton *)btn:(NSString *)t y:(CGFloat)y {
    UIButton *b = [UIButton buttonWithType:UIButtonTypeSystem];
    b.frame = CGRectMake(10, y, self.frame.size.width-20, 40);
    b.titleLabel.font = [UIFont boldSystemFontOfSize:13];
    [b setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];
    b.backgroundColor = [UIColor colorWithWhite:1 alpha:0.12];
    b.layer.cornerRadius = 8;
    [b setTitle:t forState:UIControlStateNormal];
    [self addSubview:b];
    return b;
}
- (void)refresh {
    _godBtn.backgroundColor = g_god ? [UIColor colorWithRed:0.2 green:0.5 blue:1 alpha:0.85] : [UIColor colorWithWhite:1 alpha:0.12];
    _killBtn.backgroundColor = g_kill ? [UIColor colorWithRed:1 green:0.3 blue:0.3 alpha:0.85] : [UIColor colorWithWhite:1 alpha:0.12];
    _spdBtn.backgroundColor = (g_speedMult>1) ? [UIColor colorWithRed:1 green:0.7 blue:0.1 alpha:0.85] : [UIColor colorWithWhite:1 alpha:0.12];
    _spdBtn.titleLabel.numberOfLines = 1;
    [_spdBtn setTitle:[NSString stringWithFormat:@"⏩ 加速 x%d", g_speedMult] forState:UIControlStateNormal];
}
@end

@implementation QYFloatView
- (instancetype)initWithFrame:(CGRect)frame {
    self = [super initWithFrame:frame];
    if (!self) return nil;
    self.userInteractionEnabled = YES;
    self.backgroundColor = [UIColor clearColor];

    _ball = [UIButton buttonWithType:UIButtonTypeSystem];
    _ball.frame = self.bounds;
    _ball.titleLabel.font = [UIFont boldSystemFontOfSize:14];
    [_ball setTitle:@"🎮" forState:UIControlStateNormal];
    _ball.backgroundColor = [UIColor colorWithWhite:0.1 alpha:0.65];
    _ball.layer.cornerRadius = 22;
    _ball.layer.masksToBounds = YES;
    [self addSubview:_ball];

    _panel = [[QYPanelView alloc] initWithFrame:CGRectMake(0, 0, 160, 250)];
    _panel.center = CGPointMake(CGRectGetMidX([UIScreen mainScreen].bounds), CGRectGetMidY([UIScreen mainScreen].bounds));
    _panel.hidden = YES;
    _panel.alpha = 0;
    [_panel.godBtn addTarget:self action:@selector(toggleGod) forControlEvents:UIControlEventTouchUpInside];
    [_panel.killBtn addTarget:self action:@selector(toggleKill) forControlEvents:UIControlEventTouchUpInside];
    [_panel.spdBtn addTarget:self action:@selector(cycleSpd) forControlEvents:UIControlEventTouchUpInside];
    [_panel.closeBtn addTarget:self action:@selector(closePanel) forControlEvents:UIControlEventTouchUpInside];
    [_ball addTarget:self action:@selector(togglePanel) forControlEvents:UIControlEventTouchUpInside];
    return self;
}
- (void)toggleGod { g_god = !g_god; [_panel refresh]; QYLog(@"ui god=%d kill=%d spd=%d", g_god, g_kill, g_speedMult); }
- (void)toggleKill { g_kill = !g_kill; [_panel refresh]; QYLog(@"ui god=%d kill=%d spd=%d", g_god, g_kill, g_speedMult); }
- (void)cycleSpd {
    if (g_speedMult == 1) g_speedMult = 2;
    else if (g_speedMult == 2) g_speedMult = 3;
    else if (g_speedMult == 3) g_speedMult = 5;
    else g_speedMult = 1;
    [_panel refresh];
    QYLog(@"ui god=%d kill=%d spd=%d", g_god, g_kill, g_speedMult);
}
- (void)closePanel { _panel.hidden = YES; }
- (void)togglePanel {
    if (_panel.hidden) {
        [_panel removeFromSuperview];
        UIView *w = FGKeyWindow(); if (!w) return;
        _panel.center = CGPointMake(w.bounds.size.width/2, w.bounds.size.height/2);
        [w addSubview:_panel];
        _panel.hidden = NO;
        _panel.alpha = 0;
        [UIView animateWithDuration:0.18 animations:^{ _panel.alpha = 1; }];
    } else {
        _panel.hidden = YES;
    }
}
@end

// ---------- Hook: 伤害函数 ----------
// -(void)centerPartakeClicled:(double)damage to:(id)victim from:(id)attacker
// v40@0:8d16@24@32
typedef void (*QYDamageFn)(id, SEL, double, id, id);
static QYDamageFn g_origDamage = NULL;

static void QYDamageHook(id self, SEL _cmd, double dmg, id victim, id attacker) {
    @try {
        if ((g_god || g_kill) && victim) {
            NSArray *enemies = objc_msgSend(self, sel_registerName("sashimiUnits"));
            BOOL isEnemy = [enemies containsObject:victim];

            // 一次性判定日志(验证敌我表正确性)
            if (!g_dumped) {
                g_dumped = YES;
                double hp = ((double(*)(id,SEL))objc_msgSend)(victim, sel_registerName("hp"));
                double mx = ((double(*)(id,SEL))objc_msgSend)(victim, sel_registerName("maxHp"));
                NSString *nm = objc_msgSend(victim, sel_registerName("name"));
                QYLog(@"[dmg1st] cls=%@ name=%@ hp=%.0f/%.0f dmg=%.1f enemy=%d enemies=%d\nvictim=%@ attacker=%@",
                      NSStringFromClass([victim class]), nm, hp, mx, dmg, isEnemy, (int)enemies.count,
                      enemies.count ? [NSString stringWithFormat:@"%@", enemies.firstObject] : @"nil",
                      NSStringFromClass([attacker class]));
            }

            if (g_kill && isEnemy) {
                double hp = ((double(*)(id,SEL))objc_msgSend)(victim, sel_registerName("hp"));
                double sh = ((double(*)(id,SEL))objc_msgSend)(victim, sel_registerName("shield"));
                dmg = hp + sh + 1e9;   // 必死伤害
            } else if (g_god && !isEnemy) {
                return;                // 我方单位免伤
            }
        }
    } @catch (NSException *e) {
        QYLog(@"[dmg-err] %@", e);
    }
    // 调原实现
    QYDamageFn orig = g_origDamage;
    if (!orig) return;
    orig(self, _cmd, dmg, victim, attacker);
}

// ---------- Hook: 主循环 tick ----------
// -(void)checkXMPPTimeOutBordersTick
typedef void (*QYTickFn)(id, SEL);
static QYTickFn g_origTick = NULL;

static void QYTickHook(id self, SEL _cmd) {
    QYTickFn orig = g_origTick;
    if (!orig) return;
    int n = g_speedMult > 1 ? g_speedMult : 1;
    for (int i = 0; i < n; i++) orig(self, _cmd);
}

// ---------- 安装 ----------
static void QYInstallHooks(void) {
    // 1) 伤害函数
    Class eng = objc_getClass("WantingIINKEngine");
    if (eng) {
        Method m = class_getInstanceMethod(eng, sel_registerName("centerPartakeClicled:to:from:"));
        if (m) {
            g_origDamage = (QYDamageFn)method_getImplementation(m);
            method_setImplementation(m, (IMP)QYDamageHook);
            QYLog(@"hook ok: -[WantingIINKEngine centerPartakeClicled:to:from:] orig=%p", g_origDamage);
        } else {
            QYLog(@"hook MISS: centerPartakeClicled:to:from: 未找到(类存在)");
        }
    } else QYLog(@"class MISS: WantingIINKEngine");

    // 2) 主循环
    Class nc = objc_getClass("NeedshowController");
    if (nc) {
        Method t = class_getInstanceMethod(nc, sel_registerName("checkXMPPTimeOutBordersTick"));
        if (t) {
            g_origTick = (QYTickFn)method_getImplementation(t);
            method_setImplementation(t, (IMP)QYTickHook);
            QYLog(@"hook ok: -[NeedshowController checkXMPPTimeOutBordersTick] orig=%p", g_origTick);
        } else QYLog(@"hook MISS: checkXMPPTimeOutBordersTick(类存在)");
    } else QYLog(@"class MISS: NeedshowController");
}

// ---------- 启动 ----------
__attribute__((constructor))
static void QYInit(void) {
    QYLog(@"=== QYXCheat v1 loaded (bid=%@) ===", [[NSBundle mainBundle] bundleIdentifier]);
    // 等游戏类注册完成再装 hook
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.0 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{
        // 悬浮球
        QYFloatView *fv = [[QYFloatView alloc] initWithFrame:CGRectMake(0, 0, 44, 44)];
        UIView *w = FGKeyWindow();
        if (w) {
            fv.center = CGPointMake(w.bounds.size.width - 34, 120);
            [w addSubview:fv];
            QYLog(@"float ball ok");
        } else QYLog(@"float ball MISS: no keyWindow");
        QYInstallHooks();
    });
}
