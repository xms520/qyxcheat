// QYXYCheat v1 — 奇遇西游 4.0.0 (cw723u9w.129ys / ShenShengHuaGuoShan) 助手 dylib
// 编译: xcrun -sdk iphoneos clang -arch arm64 -dynamiclib -fobjc-arc
// 注入: TrollStore/ellekit/侧载 dylib（不依赖 CydiaSubstrate，纯 ObjC runtime + dyld interpose）
//
// ===================== 本轮静态实证（可复核） =====================
// IPA=奇遇西游_4.0.0_decrypted.ipa
//   Payload/ShenShengHuaGuoShan.app   CFBundleIdentifier = cw723u9w.129ys
//   主二进制 ShenShengHuaGuoShan  382320 B  arm64  (Swift + SpriteKit + SwiftUI)
//   Frameworks/BKJDeveloperToolsSupportHelper.framework (1018784 B)
//     └ AUJieAnXiaDa.bundle  1849 个 32-hex 命名文件（内容加密，熵 7.7~7.9，非 16 字节对齐）
//   helper 内含: 腾讯 GDT Action SDK(GDTAction*) + 腾讯 TuringShield 反作弊(Turing*ADBC)
//                + BSP* 系列类（BSPXunLei 持有 ivar _webViewModule，导入 WebKit）
//   ⇒ 游戏本体 = WKWebView 承载的加密 Web 资源包（AUJieAnXiaDa.bundle），
//     主二进制的 26 个类全是 UI/模板（PageSegmentView / FBShimmering* / PostCellTableViewCell）
//
//   主二进制符号: 未定义符号含 _CACurrentMediaTime、SKView/SKScene/SKPhysicsBody/SKAction…
//   主二进制 load command: LC_DYLD_CHAINED_FIXUPS（无传统 bind opcode）
//     ⚠️ 因此 fishhook/rebind_symbols 对本目标无效 —— 本 dylib 改用 dyld __interpose + ObjC runtime
//
// ===================== 功能与实现依据 =====================
//  1) 全局加速      : dyld __DATA,__interpose 替换 CACurrentMediaTime
//                     （SpriteKit/SKView 的 CADisplayLink 时间基准 + 主二进制实测导入该符号）
//                     JS 侧再包 requestAnimationFrame/performance.now，覆盖 H5 游戏主循环
//  2) 无敌 / 秒杀   : Web 侧实现。WKWebView 注入 JS，按运行时探测到的引擎
//                     （cocos2d/cc、Laya、Egret、Pixi、Phaser、Unity WebGL、three）与
//                     HP 数值特征做通用处理；未知引擎走 HP 扫描兜底
//                     ⚠️【推测：需人工真机验证】本机静态层无法解析加密资源包，
//                       因此「具体引擎 / 具体字段名」为运行时探测结果，非静态结论
//  3) 探针          : 一键 dump WebView 内 JS 环境（引擎指纹 / window 键 / 场景树 / 发现的 HP 字段）
//                     → Documents/qyxy_probe.txt，回传后即可把 2) 换成精确实现
//  4) 免广告        : 包装平台广告接口（若 JS 侧存在 showAd/playAd/showRewardedVideo 等）
//
// 日志: <沙盒>/Documents/qyxy.log    探针: <沙盒>/Documents/qyxy_probe.txt

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <QuartzCore/QuartzCore.h>
#import <objc/runtime.h>
#import <objc/message.h>
#import <mach-o/dyld.h>
#import <dlfcn.h>
#import <stdarg.h>
#import <string.h>
#import <math.h>
#import <mach/mach_time.h>
#import <TargetConditionals.h>

#pragma mark - ===================== 日志 =====================
static FILE *g_log = NULL;
static void qlog(NSString *fmt, ...) NS_FORMAT_FUNCTION(1,2);
static void qlog(NSString *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    NSString *s = [[NSString alloc] initWithFormat:fmt arguments:ap];
    va_end(ap);
    NSLog(@"[QYXY] %@", s);
    if (!g_log) {
        NSString *p = [NSHomeDirectory() stringByAppendingPathComponent:@"Documents/qyxy.log"];
        g_log = fopen(p.UTF8String, "a");
    }
    if (g_log) { fprintf(g_log, "[QYXY] %s\n", s.UTF8String); fflush(g_log); }
}

#pragma mark - ===================== 全局配置 =====================
static BOOL   g_god        = NO;    // 无敌
static BOOL   g_kill       = NO;    // 秒杀（持续压制敌方血量）
static double g_speed      = 1.0;   // 加速倍数
static BOOL   g_noAd       = NO;    // 免广告
static BOOL   g_probeReq   = NO;    // 探针请求
static NSString *g_lastNote = @"待机";

#pragma mark - ===================== 时间加速（dyld interpose） =====================
// 依据：主二进制未定义符号表实测含 _CACurrentMediaTime（SpriteKit 时间基准）。
// 通过 __interpose 重定向，不依赖 bind opcode，故在 LC_DYLD_CHAINED_FIXUPS 目标上依然有效。
static CFTimeInterval g_timeAnchorReal = 0;   // 切换倍数瞬间的真实时间
static CFTimeInterval g_timeAnchorVirt = 0;   // 对应的虚拟时间，保证时间连续
static CFTimeInterval g_timeScale      = 1.0;

static CFTimeInterval qyxy_CACurrentMediaTime(void);

__attribute__((used))
static struct { const void *replacement; const void *replacee; }
qyxy_interpose_CACurrentMediaTime __attribute__((section("__DATA,__interpose"))) = {
    (const void *)qyxy_CACurrentMediaTime,
    (const void *)CACurrentMediaTime
};

static CFTimeInterval qyxy_CACurrentMediaTime(void) {
    // 取真实值：直接读 mach 绝对时间，避开自身递归
    static mach_timebase_info_data_t tb;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ mach_timebase_info(&tb); });
    uint64_t t = mach_absolute_time();
    double real = (double)t * (double)tb.numer / (double)tb.denom / 1e9;

    if (g_speed <= 1.0001) {
        g_timeScale = 1.0;
        g_timeAnchorReal = real;
        g_timeAnchorVirt = real;
        return real;
    }
    if (g_timeScale != g_speed) {          // 倍数切换：锚定，保证连续
        g_timeAnchorReal = real;
        g_timeAnchorVirt = (g_timeAnchorVirt > 0 && g_timeAnchorReal > 0) ? g_timeAnchorVirt : real;
        g_timeScale = g_speed;
    }
    if (g_timeAnchorReal <= 0 || g_timeAnchorVirt <= 0) {
        g_timeAnchorReal = real; g_timeAnchorVirt = real;
    }
    return g_timeAnchorVirt + (real - g_timeAnchorReal) * g_timeScale;
}

#pragma mark - ===================== 内嵌头像（base64 JPEG） =====================
static NSString * const kAvatarB64 = @"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAEAAQADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD4yooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA//2Q==";

static UIImage *qy_avatar(void) {
    static UIImage *img = nil;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSData *d = [[NSData alloc] initWithBase64EncodedString:kAvatarB64 options:0];
        img = [UIImage imageWithData:d];
    });
    return img;
}
static UIColor *qy_c(int r, int g, int b, CGFloat a) {
    return [UIColor colorWithRed:r/255.0 green:g/255.0 blue:b/255.0 alpha:a];
}

#pragma mark - ===================== 注入脚本（CI 内嵌） =====================
#include "qyxy_js.h"   // static const char QYXY_JS[] = {...};  由 gen_js.py 生成

#pragma mark - ===================== 面板 UI（独立 UIWindow + 触达穿透） =====================
#define BALL_SIZE 58.0

static UIWindow *g_win   = nil;
static UIView   *g_ball  = nil;
static UIView   *g_panel = nil;

@interface QYXYPassView : UIView
@end
@implementation QYXYPassView
- (UIView *)hitTest:(CGPoint)pt withEvent:(UIEvent *)event {
    UIView *hit = [super hitTest:pt withEvent:event];
    if (hit == self) return nil;
    return hit;
}
@end

// 独立 window 的根控制器：承载球与面板
@interface QYXYRootVC : UIViewController
@end
@implementation QYXYRootVC
- (void)loadView { self.view = [[QYXYPassView alloc] initWithFrame:[UIScreen mainScreen].bounds]; }
- (BOOL)prefersStatusBarHidden { return YES; }
- (UIInterfaceOrientationMask)supportedInterfaceOrientations { return UIInterfaceOrientationMaskAll; }
@end

#pragma mark - 透传 UIWindow（★ 真机铁律：必须在 window 层重写，子视图层重写无效）
// 仅当「球」或「面板」真正命中时 window 才参与触摸；其余位置 pointInside 返回 NO，
// 事件直接落到下层游戏 window ⇒ 游戏可触摸 + 悬浮球同时可用。
@interface QYXYPassWindow : UIWindow
@end
@implementation QYXYPassWindow

- (BOOL)qy_hitSelfSubviews:(CGPoint)point withEvent:(UIEvent *)event {
    UIView *root = self.rootViewController.view;
    for (UIView *v in root.subviews) {
        if (v.hidden || v.alpha < 0.01 || !v.userInteractionEnabled) continue;
        CGPoint p = [v convertPoint:point fromView:self];
        if ([v pointInside:p withEvent:event]) return YES;   // 交由其自身 hitTest 细分（球/面板/按钮）
    }
    return NO;
}

- (BOOL)pointInside:(CGPoint)point withEvent:(UIEvent *)event {
    return [self qy_hitSelfSubviews:point withEvent:event];
}

- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
    if (![self qy_hitSelfSubviews:point withEvent:event]) return nil;   // 空白区 → 穿透，game window 收事件
    UIView *hit = [super hitTest:point withEvent:event];
    if (hit == self) return nil;
    if (hit == self.rootViewController.view) return nil;
    return hit;
}
@end

static UIView *qy_ball_view(CGFloat size) {
    UIView *wrap = [[UIView alloc] initWithFrame:CGRectMake(0, 0, size, size)];
    wrap.userInteractionEnabled = NO;

    CAGradientLayer *grad = [CAGradientLayer layer];
    grad.frame = wrap.bounds;
    grad.type = kCAGradientLayerConic;      // 抖音同款彩虹环
    grad.colors = @[
        (id)[UIColor colorWithRed:0.10 green:0.90 blue:1.00 alpha:1].CGColor,
        (id)[UIColor colorWithRed:0.45 green:0.30 blue:1.00 alpha:1].CGColor,
        (id)[UIColor colorWithRed:1.00 green:0.15 blue:0.35 alpha:1].CGColor,
        (id)[UIColor colorWithRed:1.00 green:0.55 blue:0.10 alpha:1].CGColor,
        (id)[UIColor colorWithRed:0.10 green:0.90 blue:1.00 alpha:1].CGColor,
    ];
    grad.startPoint = CGPointMake(0.5, 0.5);
    grad.endPoint   = CGPointMake(0.5, 0.0);
    grad.cornerRadius = size / 2.0;
    [wrap.layer addSublayer:grad];

    CGFloat hole = size * 0.84;
    CAShapeLayer *mask = [CAShapeLayer layer];
    CGMutablePathRef p = CGPathCreateMutable();
    CGPathAddEllipseInRect(p, NULL, CGRectMake(0, 0, size, size));
    CGPathAddEllipseInRect(p, NULL, CGRectMake((size-hole)/2.0, (size-hole)/2.0, hole, hole));
    mask.path = p;
    mask.fillRule = kCAFillRuleEvenOdd;
    CGPathRelease(p);
    grad.mask = mask;

    UIImageView *av = [[UIImageView alloc] initWithFrame:CGRectMake((size-hole)/2.0+1, (size-hole)/2.0+1, hole-2, hole-2)];
    av.image = qy_avatar();
    av.contentMode = UIViewContentModeScaleAspectFill;
    av.clipsToBounds = YES;
    av.layer.cornerRadius = (hole-2)/2.0;
    [wrap addSubview:av];
    return wrap;
}

#pragma mark - ===================== WebView JS 桥 =====================
// 记录所有 WKWebView，供每秒写配置 / 读状态
static NSMutableArray <WKWebView *> *g_webs = nil;
static NSLock *g_lock = nil;

static void qy_eval(WKWebView *wv, NSString *js, void (^done)(id, NSError *)) {
    if (!wv) return;
    dispatch_async(dispatch_get_main_queue(), ^{
        [wv evaluateJavaScript:js completionHandler:^(id r, NSError *e) {
            if (done) done(r, e);
        }];
    });
}

static NSMutableArray <NSString *> *g_reports = nil;   // 各 frame 状态汇总

static void qy_push_config(void) {
    NSArray *list = nil;
    [g_lock lock]; list = [g_webs copy]; [g_lock unlock];
    if (list.count == 0) { g_lastNote = @"未找到 WebView"; return; }

    NSString *js = [NSString stringWithFormat:
        @"(function(){var c=window.__qyxy_cfg;if(!c)return 'QYNOSCRIPT';"
        @"c.god=%@;c.kill=%@;c.noAd=%@;c.speed=%f;c.probe=%@;c.tick=(c.tick||0)+1;"
        @"return window.__qyxy_state?window.__qyxy_state():'QYNOSTATE';})()",
        g_god ? @"true" : @"false",
        g_kill ? @"true" : @"false",
        g_noAd ? @"true" : @"false",
        g_speed,
        g_probeReq ? @"true" : @"false"];
    g_probeReq = NO;

    for (WKWebView *wv in list) {
        qy_eval(wv, js, ^(id r, NSError *e) {
            if (![r isKindOfClass:[NSString class]]) {
                if (e) g_lastNote = [NSString stringWithFormat:@"eval错: %@", e.localizedDescription];
                return;
            }
            NSString *s = (NSString *)r;
            if (![s hasPrefix:@"QYOK::"]) { g_lastNote = [s substringToIndex:MIN((NSUInteger)70, s.length)]; return; }

            NSString *body = [s substringFromIndex:6];
            NSRange pr = [body rangeOfString:@"\nQYPROBE::\n"];
            NSString *state = (pr.location == NSNotFound) ? body : [body substringToIndex:pr.location];
            NSString *probeTxt = (pr.location == NSNotFound) ? nil : [body substringFromIndex:pr.location + pr.length];

            // 摘要：只显示 game=1 的 frame（真游戏层）
            NSString *game = @"";
            for (NSString *line in [state componentsSeparatedByString:@" ;; "]) {
                if ([line rangeOfString:@"|game=1"].location != NSNotFound) { game = line; break; }
            }
            if (game.length == 0) {
                for (NSString *line in [state componentsSeparatedByString:@" ;; "]) {
                    if ([line rangeOfString:@"dl-qyxx"].location != NSNotFound) { game = line; break; }
                }
            }
            NSArray *parts = [(game.length ? game : state) componentsSeparatedByString:@"|"];
            NSString *short_ = @"";
            for (NSString *p in parts) {
                if ([p hasPrefix:@"eng="] || [p hasPrefix:@"laya="] || [p hasPrefix:@"units="] ||
                    [p hasPrefix:@"spd="] || [p hasPrefix:@"ad="] || [p hasPrefix:@"err="] || [p hasPrefix:@"game="]) {
                    short_ = short_.length ? [short_ stringByAppendingFormat:@" %@", p] : p;
                }
            }
            g_lastNote = short_.length ? short_ : @"已注入(未见游戏层)";

            if (probeTxt && probeTxt.length > 20) {
                NSString *p = [NSHomeDirectory() stringByAppendingPathComponent:@"Documents/qyxy_probe.txt"];
                [probeTxt writeToFile:p atomically:YES encoding:NSUTF8StringEncoding error:NULL];
                g_lastNote = @"探针已导出 → qyxy_probe.txt";
            }
        });
    }
}

// 注入（幂等：脚本自带 __qyxy_installed 守卫）
static void qy_inject_webview(WKWebView *wv) {
    if (!wv) return;
    NSString *js = [NSString stringWithUTF8String:QYXY_JS];
    qy_eval(wv, js, ^(id r, NSError *e) {
        if (e) qlog(@"注入失败: %@", e.localizedDescription);
        else   qlog(@"注入成功: %@", r);
    });
}

// 保证「已经创建好配置的」WebView 也能拿到脚本：
// hook -[WKWebView initWithFrame:configuration:]（WKWebView 本类实现，可安全交换）
@interface WKWebView (QYXYHook)
- (instancetype)qyxy_initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)cfg;
- (void)qyxy_register:(WKWebView *)self_;
- (WKNavigation *)qyxy_loadRequest:(NSURLRequest *)req;
- (WKNavigation *)qyxy_loadHTMLString:(NSString *)s baseURL:(NSURL *)u;
- (WKNavigation *)qyxy_loadFileURL:(NSURL *)f allowingReadAccessToURL:(NSURL *)d;
- (WKNavigation *)qyxy_loadData:(NSData *)data MIMEType:(NSString *)mt characterEncodingName:(NSString *)ce baseURL:(NSURL *)u;
@end
@implementation WKWebView (QYXYHook)

- (void)qyxy_register:(WKWebView *)self_ {
    if (!self_) return;
    [g_lock lock];
    if (!g_webs) g_webs = [NSMutableArray array];
    if (![g_webs containsObject:self_]) [g_webs addObject:self_];
    [g_lock unlock];
    __weak WKWebView *weak = self_;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        qy_inject_webview(weak);
    });
}

- (WKNavigation *)qyxy_loadRequest:(NSURLRequest *)req {
    [self qyxy_register:self];
    return [self qyxy_loadRequest:req];      // 交换后 = 原实现
}
- (WKNavigation *)qyxy_loadHTMLString:(NSString *)s baseURL:(NSURL *)u {
    [self qyxy_register:self];
    return [self qyxy_loadHTMLString:s baseURL:u];
}
- (WKNavigation *)qyxy_loadFileURL:(NSURL *)f allowingReadAccessToURL:(NSURL *)d {
    [self qyxy_register:self];
    return [self qyxy_loadFileURL:f allowingReadAccessToURL:d];
}
- (WKNavigation *)qyxy_loadData:(NSData *)data MIMEType:(NSString *)mt characterEncodingName:(NSString *)ce baseURL:(NSURL *)u {
    [self qyxy_register:self];
    return [self qyxy_loadData:data MIMEType:mt characterEncodingName:ce baseURL:u];
}

// 注入 userScript 到即将使用的 configuration
// 交换后 = 原实现
- (instancetype)qyxy_initWithFrame:(CGRect)frame configuration:(WKWebViewConfiguration *)cfg {
    qy_install_userscript_on_config(cfg);
    return [self qyxy_initWithFrame:frame configuration:cfg];
}
@end

// ★ 安全 swizzle：必须「本类自己实现」的方法才允许交换。
// 原因：class_getInstanceMethod 会沿继承链查找；若命中父类/NSObject 的方法（如 -copy），
//       交换它 = 全局篡改父类行为 → 必崩。此前 swizzle WKWebViewConfiguration 的 -copy
//       正是如此（copy 来自 NSObject），导致「初始化完成」后立刻 SIGSEGV。
static void qy_swizzle(Class c, SEL a, SEL b) {
    if (!c) return;
    Method m1 = class_getInstanceMethod(c, a);
    Method m2 = class_getInstanceMethod(c, b);
    if (!m1 || !m2) { qlog(@"⚠️ swizzle 跳过(方法缺失) %@ / %@", NSStringFromSelector(a), NSStringFromSelector(b)); return; }

    unsigned int n = 0;
    Method *list = class_copyMethodList(c, &n);
    BOOL ownA = NO, ownB = NO;
    for (unsigned int i = 0; i < n; i++) {
        SEL s = method_getName(list[i]);
        if (sel_isEqual(s, a)) ownA = YES;
        if (sel_isEqual(s, b)) ownB = YES;
    }
    free(list);

    if (ownA && ownB) {
        method_exchangeImplementations(m1, m2);
        qlog(@"✔ swizzle %@ %@ <-> %@", NSStringFromClass(c), NSStringFromSelector(a), NSStringFromSelector(b));
    } else {
        qlog(@"⚠️ 拒绝 swizzle %@ %@（非本类实现：ownA=%d ownB=%d）",
             NSStringFromClass(c), NSStringFromSelector(ownA ? b : a), ownA, ownB);
    }
}

#pragma mark - ★ 核心：WKUserScript 全 frame 注入（唯一能穿透跨域 iframe 的手段）
// 已实测架构：平台壳(appack.zkyouxi.com) → iframe(SDK壳) → iframe(dl-qyxx.gzdlm.com=游戏)
// 两层 iframe 均与父页跨域 ⇒ 无法从父页 JS 访问 ⇒ 必须由原生侧 forMainFrameOnly:NO 注入。
static WKUserScript *g_userScript = nil;

static WKUserScript *qy_user_script(void) {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *src = [NSString stringWithUTF8String:QYXY_JS];
        // forMainFrameOnly:NO  →  注入到所有 frame，含跨域 iframe（关键参数）
        g_userScript = [[WKUserScript alloc] initWithSource:src
                                              injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                           forMainFrameOnly:NO];
        qlog(@"WKUserScript 就绪 (%lu 字节, forMainFrameOnly=NO)", (unsigned long)src.length);
    });
    return g_userScript;
}

static void qy_install_userscript_on_config(WKWebViewConfiguration *cfg) {
    if (!cfg) return;
    @try {
        WKUserContentController *ucc = cfg.userContentController;
        if (!ucc) { ucc = [[WKUserContentController alloc] init]; cfg.userContentController = ucc; }
        WKUserScript *s = qy_user_script();
        // 去重：避免每次加载重复加
        BOOL has = NO;
        for (WKUserScript *e in ucc.userScripts) {
            if (e.source.length == s.source.length) { has = YES; break; }
        }
        if (!has) [ucc addUserScript:s];
    } @catch (NSException *e) {
        qlog(@"⚠️ userScript 安装异常: %@", e.reason);
    }
}

static void qy_hook_webview(void) {
    Class c = objc_getClass("WKWebView");
    if (!c) { qlog(@"⚠️ 未找到 WKWebView 类"); return; }

    // 先装一次全局 userScript（保证任何 config 都能拿到）
    qy_user_script();

    // 1) 全 frame 注入的主力：确保每个 WebView 的 configuration 都带 userScript
    qy_swizzle(c, @selector(initWithFrame:configuration:), @selector(qyxy_initWithFrame:configuration:));

    // 2) 记录 WebView + 兜底注入（部分壳自建 config，不经 initWithFrame: 路径）
    qy_swizzle(c, @selector(loadRequest:),            @selector(qyxy_loadRequest:));
    qy_swizzle(c, @selector(loadHTMLString:baseURL:), @selector(qyxy_loadHTMLString:baseURL:));
    qy_swizzle(c, @selector(loadFileURL:allowingReadAccessToURL:), @selector(qyxy_loadFileURL:allowingReadAccessToURL:));
    qy_swizzle(c, @selector(loadData:MIMEType:characterEncodingName:baseURL:), @selector(qyxy_loadData:MIMEType:characterEncodingName:baseURL:));

    qlog(@"WKWebView hook 完成");
}

#pragma mark - ===================== 面板 =====================
static UILabel *g_note = nil;
static UIButton *g_btnGod = nil, *g_btnKill = nil, *g_btnSpeed = nil, *g_btnAd = nil;

static UIButton *qy_mkbtn(NSString *title, UIColor *bg) {
    UIButton *b = [UIButton buttonWithType:UIButtonTypeCustom];
    b.frame = CGRectMake(0, 0, 110, 34);
    b.backgroundColor = bg;
    b.layer.cornerRadius = 10;
    b.layer.borderWidth = 1;
    b.layer.borderColor = qy_c(90, 160, 255, 0.5).CGColor;
    [b setTitle:title forState:UIControlStateNormal];
    b.titleLabel.font = [UIFont boldSystemFontOfSize:14];
    [b setTitleColor:[UIColor whiteColor] forState:UIControlStateNormal];
    return b;
}

@interface QYXYBox : NSObject
- (void)ballTap;
- (void)ballDrag:(UIPanGestureRecognizer *)g;
- (void)panelDrag:(UIPanGestureRecognizer *)g;
- (void)toggleGod;  - (void)toggleKill;  - (void)cycleSpeed;
- (void)toggleAd;   - (void)doProbe;     - (void)closePanel;
- (void)refreshUI;  - (void)tick;
@end

@implementation QYXYBox
+ (instancetype)shared { static QYXYBox *b; static dispatch_once_t o; dispatch_once(&o, ^{ b = [self new]; }); return b; }

- (void)refreshUI {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (g_btnGod)   [g_btnGod   setTitle:(g_god   ? @"无敌 ✅" : @"无敌 ⭕️") forState:UIControlStateNormal];
        if (g_btnKill)  [g_btnKill  setTitle:(g_kill  ? @"秒杀 ✅" : @"秒杀 ⭕️") forState:UIControlStateNormal];
        if (g_btnAd)    [g_btnAd    setTitle:(g_noAd  ? @"免广 ✅" : @"免广 ⭕️") forState:UIControlStateNormal];
        if (g_btnSpeed) [g_btnSpeed setTitle:[NSString stringWithFormat:@"加速 ×%.0f", g_speed] forState:UIControlStateNormal];
        if (g_note)     g_note.text = g_lastNote;
    });
}

- (void)toggleGod  { g_god  = !g_god;  [self refreshUI]; }
- (void)toggleKill { g_kill = !g_kill; [self refreshUI]; }
- (void)toggleAd   { g_noAd = !g_noAd; [self refreshUI]; }
- (void)cycleSpeed {
    double seq[] = {1.0, 2.0, 3.0, 5.0, 8.0};
    int i = 0;
    for (; i < 5; i++) if (fabs(g_speed - seq[i]) < 0.01) break;
    g_speed = seq[(i + 1) % 5];
    [self refreshUI];
}
- (void)doProbe { g_probeReq = YES; g_lastNote = @"探针请求中…"; [self refreshUI]; }

- (void)closePanel { if (g_panel) { [g_panel removeFromSuperview]; g_panel = nil; } }

- (void)togglePanel {
    if (g_panel) { [self closePanel]; return; }
    CGFloat pw = 262, ph = 400;
    UIView *root = g_win.rootViewController.view;
    CGFloat bx = g_ball.center.x, by = g_ball.center.y;
    CGFloat px = bx + BALL_SIZE/2 + 8, py = by - ph/2.0;
    if (px + pw > root.bounds.size.width  - 8) px = bx - BALL_SIZE/2 - 8 - pw;
    if (px < 8) px = 8;
    if (py < 8) py = 8;
    if (py + ph > root.bounds.size.height - 8) py = root.bounds.size.height - 8 - ph;

    g_panel = [[UIView alloc] initWithFrame:CGRectMake(px, py, pw, ph)];
    g_panel.backgroundColor = qy_c(16, 18, 26, 0.97);
    g_panel.layer.cornerRadius = 16;
    g_panel.layer.borderWidth = 1;
    g_panel.layer.borderColor = qy_c(70, 140, 255, 0.45).CGColor;

    UIView *av = qy_ball_view(40);
    av.frame = CGRectMake(12, 12, 40, 40);
    [g_panel addSubview:av];

    UILabel *t = [[UILabel alloc] initWithFrame:CGRectMake(60, 14, pw - 100, 22)];
    t.text = @"✦ 奇遇西游助手 ✦";
    t.textColor = qy_c(255, 210, 90, 1);
    t.font = [UIFont boldSystemFontOfSize:16];
    [g_panel addSubview:t];

    UIButton *x = [UIButton buttonWithType:UIButtonTypeCustom];
    x.frame = CGRectMake(pw - 40, 10, 30, 30);
    [x setTitle:@"✕" forState:UIControlStateNormal];
    [x setTitleColor:qy_c(200, 200, 210, 1) forState:UIControlStateNormal];
    [x addTarget:self action:@selector(closePanel) forControlEvents:UIControlEventTouchUpInside];
    [g_panel addSubview:x];

    g_btnGod   = qy_mkbtn(@"无敌 ⭕️", qy_c(38, 44, 62, 1));
    g_btnKill  = qy_mkbtn(@"秒杀 ⭕️", qy_c(38, 44, 62, 1));
    g_btnSpeed = qy_mkbtn(@"加速 ×1",  qy_c(38, 44, 62, 1));
    g_btnAd    = qy_mkbtn(@"免广 ⭕️", qy_c(38, 44, 62, 1));
    UIButton *bProbe = qy_mkbtn(@"JS探针", qy_c(52, 40, 66, 1));
    UIButton *bHide  = qy_mkbtn(@"收起面板", qy_c(30, 36, 52, 1));

    NSArray *row1 = @[g_btnGod, g_btnKill];
    NSArray *row2 = @[g_btnSpeed, g_btnAd];
    NSArray *row3 = @[bProbe, bHide];
    CGFloat y = 62;
    for (NSArray *row in @[row1, row2, row3]) {
        CGFloat x0 = 14;
        for (UIButton *b in row) {
            b.frame = CGRectMake(x0, y, 112, 34);
            x0 += 122;
            [g_panel addSubview:b];
        }
        y += 42;
    }
    [g_btnGod   addTarget:self action:@selector(toggleGod)   forControlEvents:UIControlEventTouchUpInside];
    [g_btnKill  addTarget:self action:@selector(toggleKill)  forControlEvents:UIControlEventTouchUpInside];
    [g_btnSpeed addTarget:self action:@selector(cycleSpeed)  forControlEvents:UIControlEventTouchUpInside];
    [g_btnAd    addTarget:self action:@selector(toggleAd)    forControlEvents:UIControlEventTouchUpInside];
    [bProbe     addTarget:self action:@selector(doProbe)     forControlEvents:UIControlEventTouchUpInside];
    [bHide      addTarget:self action:@selector(closePanel)  forControlEvents:UIControlEventTouchUpInside];

    UILabel *noteTitle = [[UILabel alloc] initWithFrame:CGRectMake(14, y + 4, pw - 28, 16)];
    noteTitle.text = @"状态（探针结果 / 引擎 / HP字段）";
    noteTitle.textColor = qy_c(150, 160, 190, 1);
    noteTitle.font = [UIFont systemFontOfSize:11];
    [g_panel addSubview:noteTitle];

    g_note = [[UILabel alloc] initWithFrame:CGRectMake(14, y + 22, pw - 28, ph - y - 34)];
    g_note.numberOfLines = 0;
    g_note.textColor = qy_c(120, 230, 170, 1);
    g_note.font = [UIFont systemFontOfSize:10];
    g_note.text = g_lastNote;
    [g_panel addSubview:g_note];

    UIPanGestureRecognizer *pd = [[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(panelDrag:)];
    [g_panel addGestureRecognizer:pd];

    [root addSubview:g_panel];
    [self refreshUI];
}

#pragma mark 手势
static CGPoint g_ballStart, g_panelStart;
static BOOL g_ballMoved = NO;

- (void)ballTap { [self togglePanel]; }

- (void)ballDrag:(UIPanGestureRecognizer *)g {
    UIView *root = g_win.rootViewController.view;
    CGPoint t = [g translationInView:root];
    if (g.state == UIGestureRecognizerStateBegan) {
        g_ballStart = g_ball.center; g_ballMoved = NO;
    } else if (g.state == UIGestureRecognizerStateChanged) {
        CGPoint c = CGPointMake(g_ballStart.x + t.x, g_ballStart.y + t.y);
        // 位移阈值：>10pt 才算拖动（历次真机教训：手抖会吃掉点击判定）
        if (fabs(t.x) > 10 || fabs(t.y) > 10) g_ballMoved = YES;
        CGFloat half = BALL_SIZE / 2;
        c.x = MAX(half + 2, MIN(root.bounds.size.width  - half - 2, c.x));
        c.y = MAX(half + 2, MIN(root.bounds.size.height - half - 2, c.y));
        g_ball.center = c;
    } else if (g.state == UIGestureRecognizerStateEnded ||
               g.state == UIGestureRecognizerStateCancelled) {
        if (!g_ballMoved) [self togglePanel];
    }
}

- (void)panelDrag:(UIPanGestureRecognizer *)g {
    UIView *root = g_win.rootViewController.view;
    CGPoint t = [g translationInView:root];
    if (g.state == UIGestureRecognizerStateBegan) g_panelStart = g_panel.center;
    else if (g.state == UIGestureRecognizerStateChanged) {
        CGPoint c = CGPointMake(g_panelStart.x + t.x, g_panelStart.y + t.y);
        CGFloat hw = g_panel.bounds.size.width/2, hh = g_panel.bounds.size.height/2;
        c.x = MAX(hw, MIN(root.bounds.size.width - hw, c.x));
        c.y = MAX(hh, MIN(root.bounds.size.height - hh, c.y));
        g_panel.center = c;
    }
}

- (void)tick { qy_push_config(); }
@end

#pragma mark - ===================== 安装 =====================
static UIWindowScene *qy_active_scene(void) {
    if (@available(iOS 13.0, *)) {
        for (UIScene *sc in [UIApplication sharedApplication].connectedScenes) {
            if ([sc isKindOfClass:[UIWindowScene class]] &&
                sc.activationState == UISceneActivationStateForegroundActive) {
                return (UIWindowScene *)sc;
            }
        }
        for (UIScene *sc in [UIApplication sharedApplication].connectedScenes) {
            if ([sc isKindOfClass:[UIWindowScene class]] &&
                sc.activationState != UISceneActivationStateUnattached) {
                return (UIWindowScene *)sc;
            }
        }
    }
    return nil;
}

static void qy_install_window(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        // 保活：window 被摘除 / 球被移除 / windowScene 丢失 → 重建
        BOOL alive = (g_win && !g_win.hidden && g_win.windowScene != nil && g_ball.superview != nil);
        if (alive) return;
        if (g_win) { g_win = nil; g_ball = nil; g_panel = nil; g_note = nil; }

        g_win = [[QYXYPassWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
        g_win.windowLevel = UIWindowLevelAlert + 100;   // 独立窗口，高于游戏层但不至于 CGFLOAT_MAX
        g_win.rootViewController = [[QYXYRootVC alloc] init];
        g_win.backgroundColor = [UIColor clearColor];
        // 显式绑定 windowScene（iOS 13+ 不绑定则窗口不参与触摸派发/不显示）
        UIWindowScene *scene = qy_active_scene();
        if (scene) g_win.windowScene = scene;
        g_win.hidden = NO;
        // 刻意不调用 makeKeyAndVisible：键窗口必须留给游戏，否则会抢走输入焦点
        [g_win setHidden:NO];
        qlog(@"window 挂载 level=%.0f scene=%@", g_win.windowLevel, scene ? @"有" : @"无");

        UIView *root = g_win.rootViewController.view;
        g_ball = [[UIView alloc] initWithFrame:CGRectMake(root.bounds.size.width - 74, 120, BALL_SIZE, BALL_SIZE)];
        UIView *ring = qy_ball_view(BALL_SIZE);
        ring.frame = g_ball.bounds;
        [g_ball addSubview:ring];
        g_ball.userInteractionEnabled = YES;
        g_ball.layer.cornerRadius = BALL_SIZE/2;
        g_ball.backgroundColor = [UIColor clearColor];
        g_ball.layer.shadowColor = qy_c(0, 0, 0, 0.5).CGColor;
        g_ball.layer.shadowRadius = 6;
        g_ball.layer.shadowOpacity = 1;
        g_ball.layer.shadowOffset = CGSizeMake(0, 2);

        UIPanGestureRecognizer *pan = [[UIPanGestureRecognizer alloc] initWithTarget:[QYXYBox shared] action:@selector(ballDrag:)];
        [g_ball addGestureRecognizer:pan];
        UITapGestureRecognizer *tap = [[UITapGestureRecognizer alloc] initWithTarget:[QYXYBox shared] action:@selector(ballTap)];
        [g_ball addGestureRecognizer:tap];

        [root addSubview:g_ball];
        qlog(@"悬浮球已挂载  %@", NSStringFromCGRect(g_ball.frame));
    });
}

#pragma mark - ===================== dylib 入口 =====================
__attribute__((constructor))
static void qyxy_init(void) {
    g_lock = [NSLock new];
    qlog(@"=========== QYXYCheat v1 加载 base=%p ===========", (void *)&qyxy_init);

    // 1) WebView 注入桥
    Class wv = objc_getClass("WKWebView");
    if (wv) {
        qy_hook_webview();
    } else {
        qlog(@"⚠️ 本进程未加载 WebKit（延迟重试）");
    }

    // 2) 面板 + 悬浮球
    qy_install_window();

    // 3) 每秒：写配置 / 读状态 / 保活重建
    NSTimer *t = [NSTimer timerWithTimeInterval:1.0 repeats:YES block:^(NSTimer *tm) {
        [[QYXYBox shared] tick];
        [[QYXYBox shared] refreshUI];
        qy_install_window();     // 游戏重建 keyWindow 时自动复位
    }];
    [[NSRunLoop mainRunLoop] addTimer:t forMode:NSRunLoopCommonModes];

    // 4) 兜底：若启动时 WebKit 未就绪，稍后重试 hook
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.0 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
        if (!g_webs || g_webs.count == 0) qy_hook_webview();
    });

    qlog(@"初始化完成  加速=%g  无敌=%d  秒杀=%d", g_speed, g_god, g_kill);
}
