//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c -Wno-deprecated-literal-operator
#cgo LDFLAGS: -framework ApplicationServices -framework CoreGraphics -framework CoreFoundation -framework Cocoa -framework WebKit

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <ApplicationServices/ApplicationServices.h>
#include <CoreGraphics/CoreGraphics.h>
#include <CoreFoundation/CoreFoundation.h>

static int CheckAccessibilityTrusted() {
    return AXIsProcessTrusted();
}

static void PromptAccessibility() {
    const void *keys[] = { kAXTrustedCheckOptionPrompt };
    const void *values[] = { kCFBooleanTrue };
    CFDictionaryRef options = CFDictionaryCreate(
        kCFAllocatorDefault,
        keys,
        values,
        1,
        &kCFTypeDictionaryKeyCallBacks,
        &kCFTypeDictionaryValueCallBacks
    );
    AXIsProcessTrustedWithOptions(options);
    if (options) CFRelease(options);
}

static int CheckScreenRecordingPermission() {
    return CGPreflightScreenCaptureAccess();
}

static void PromptScreenRecording() {
    CGRequestScreenCaptureAccess();
}

extern char* HandleBridgeAction(char* action, char* payload);

static id getOrCreateBridgeHandler() {
    Class cls = objc_getClass("ShuffleAgentBridgeHandler");
    if (!cls) {
        cls = objc_allocateClassPair([NSObject class], "ShuffleAgentBridgeHandler", 0);
        class_addProtocol(cls, objc_getProtocol("WKScriptMessageHandlerWithReply"));

        void (^block)(id, WKUserContentController *, WKScriptMessage *, void (^)(id, NSString *)) =
            ^(id self, WKUserContentController *ucc, WKScriptMessage *msg, void (^reply)(id, NSString *)) {
                NSString *action = @"";
                NSString *payload = @"";
                if ([msg.body isKindOfClass:[NSDictionary class]]) {
                    NSDictionary *dict = (NSDictionary *)msg.body;
                    action = [dict objectForKey:@"action"] ?: @"";
                    id p = [dict objectForKey:@"payload"];
                    if ([p isKindOfClass:[NSString class]]) {
                        payload = (NSString *)p;
                    } else if (p != nil) {
                        NSData *data = [NSJSONSerialization dataWithJSONObject:p options:0 error:nil];
                        if (data) {
                            payload = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
                        }
                    }
                }

                NSString *act = [action copy];
                NSString *pay = [payload copy];

                dispatch_async(dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0), ^{
                    char *res = HandleBridgeAction((char *)[act UTF8String], (char *)[pay UTF8String]);
                    NSString *respStr = res ? [NSString stringWithUTF8String:res] : @"";
                    if (res) free(res);

                    dispatch_async(dispatch_get_main_queue(), ^{
                        reply(respStr, nil);
                    });
                });
            };

        SEL sel = sel_registerName("userContentController:didReceiveScriptMessage:replyHandler:");
        IMP imp = imp_implementationWithBlock(block);
        class_addMethod(cls, sel, imp, "v@:@@@?");
        objc_registerClassPair(cls);
    }
    return [[cls alloc] init];
}

static NSWindow *agentWindow = nil;
static WKWebView *agentWebView = nil;

static void ensureAgentWindowCreated(const char *htmlContent) {
    if (agentWindow != nil) return;

    NSRect frame = NSMakeRect(200, 200, 950, 700);
    NSUInteger style = NSWindowStyleMaskTitled |
                       NSWindowStyleMaskClosable |
                       NSWindowStyleMaskMiniaturizable |
                       NSWindowStyleMaskResizable;
    agentWindow = [[NSWindow alloc] initWithContentRect:frame
                                              styleMask:style
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    [agentWindow setTitle:@"Shuffle Agent Runner"];
    [agentWindow setReleasedWhenClosed:NO];
    [agentWindow center];

    agentWindow.backgroundColor = [NSColor colorWithCalibratedRed:0.035 green:0.051 blue:0.086 alpha:1.0];

    WKWebViewConfiguration *config = [[WKWebViewConfiguration alloc] init];

    NSString *bridgeScript = @""
        "window.bridgeCall = function(action, payload) {"
        "    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge) {"
        "        return window.webkit.messageHandlers.bridge.postMessage({ action: action, payload: payload });"
        "    }"
        "    return Promise.reject('Bridge not available');"
        "};"
        "window.getInitialState = function() { return window.bridgeCall('getInitialState', ''); };"
        "window.listProjects = function() { return window.bridgeCall('listProjects', ''); };"
        "window.selectProject = function(path) { return window.bridgeCall('selectProject', path); };"
        "window.setPermissionPolicy = function(policy) { return window.bridgeCall('setPermissionPolicy', policy); };"
        "window.runPrompt = function(prompt, bypass) { return window.bridgeCall('runPrompt', JSON.stringify({prompt: prompt, bypass: bypass})); };"
        "window.respondApproval = function(id, approved) { return window.bridgeCall('respondApproval', JSON.stringify({id: id, approved: approved})); };"
        "window.takeScreenshot = function() { return window.bridgeCall('takeScreenshot', ''); };"
        "window.inspectUI = function() { return window.bridgeCall('inspectUI', ''); };"
        "window.requestOSPermission = function(perm) { return window.bridgeCall('requestOSPermission', perm); };"
        "window.updateAuth = function(authData) { return window.bridgeCall('updateAuth', JSON.stringify(authData)); };"
        "window.startOAuthLogin = function(url) { return window.bridgeCall('startOAuthLogin', url || ''); };"
        "window.setOAuthToken = function(token, org, env) { return window.bridgeCall('setOAuthToken', JSON.stringify({token: token, org: org, env: env})); };";

    WKUserScript *userScript = [[WKUserScript alloc] initWithSource:bridgeScript
                                                      injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                                   forMainFrameOnly:YES];
    [config.userContentController addUserScript:userScript];

    @try {
        id bridgeHandler = getOrCreateBridgeHandler();
        [config.userContentController addScriptMessageHandlerWithReply:bridgeHandler
                                                          contentWorld:[WKContentWorld pageWorld]
                                                                  name:@"bridge"];
        NSLog(@"[INFO] WebKit bridge handler registered");
    } @catch (NSException *e) {
        NSLog(@"[ERROR] Failed to register WebKit bridge: %@", e);
    }

    agentWebView = [[WKWebView alloc] initWithFrame:[agentWindow.contentView bounds] configuration:config];
    [agentWebView setAutoresizingMask:(NSViewWidthSizable | NSViewHeightSizable)];
    [agentWebView setValue:@NO forKey:@"drawsBackground"];
    [agentWindow.contentView addSubview:agentWebView];

    if (htmlContent != NULL && strlen(htmlContent) > 0) {
        NSString *html = [NSString stringWithUTF8String:htmlContent];
        [agentWebView loadHTMLString:html baseURL:nil];
    }
}

static inline void InitAgentWindow(char *htmlContent) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (agentWindow == nil) {
            NSLog(@"[INFO] Pre-warming agentWindow during boot");
            ensureAgentWindowCreated(htmlContent);
        }
        if (htmlContent != NULL) {
            free(htmlContent);
        }
    });
}

static inline void ShowAgentWindow(char *htmlContent) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (agentWindow == nil) {
            NSLog(@"[INFO] agentWindow was nil in ShowAgentWindow, creating now");
            ensureAgentWindowCreated(htmlContent);
        }
        if (htmlContent != NULL) {
            free(htmlContent);
        }
        if (agentWindow != nil) {
            [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
            [agentWindow setIsVisible:YES];
            [agentWindow makeKeyAndOrderFront:nil];
            [agentWindow orderFrontRegardless];
            [NSApp activateIgnoringOtherApps:YES];
            NSLog(@"[INFO] agentWindow presented, visible: %d", [agentWindow isVisible]);
        } else {
            NSLog(@"[ERROR] agentWindow could not be created");
        }
    });
}
*/
import "C"

import (
	"context"
	"encoding/json"
	"log"
	"runtime"
	"time"

	"fyne.io/systray"
	"github.com/shuffle/osctrl"
	"orborus/pkg"
)

var globalBridge *pkg.AgentBridge

//export HandleBridgeAction
func HandleBridgeAction(cAction *C.char, cPayload *C.char) *C.char {
	action := C.GoString(cAction)
	payload := C.GoString(cPayload)

	if globalBridge == nil {
		return C.CString(`{"error": "bridge not initialized"}`)
	}

	switch action {
	case "getInitialState":
		return C.CString(globalBridge.GetInitialState())

	case "listProjects":
		return C.CString(globalBridge.ListProjects())

	case "selectProject":
		return C.CString(globalBridge.SelectProject(payload))

	case "setPermissionPolicy":
		return C.CString(globalBridge.SetPermissionPolicy(payload))

	case "runPrompt":
		var req struct {
			Prompt string `json:"prompt"`
			Bypass bool   `json:"bypass"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err != nil {
			req.Prompt = payload
		}
		return C.CString(globalBridge.RunPrompt(req.Prompt, req.Bypass))

	case "respondApproval":
		var req struct {
			ID       string `json:"id"`
			Approved bool   `json:"approved"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			return C.CString(globalBridge.RespondApproval(req.ID, req.Approved))
		}
		return C.CString(`{"error": "invalid payload"}`)

	case "takeScreenshot":
		return C.CString(globalBridge.TakeScreenshot())

	case "inspectUI":
		return C.CString(globalBridge.InspectUI())

	case "requestOSPermission":
		if payload == "accessibility" {
			C.PromptAccessibility()
		} else if payload == "screen" {
			C.PromptScreenRecording()
		}
		return C.CString(`{"status": "ok"}`)

	case "updateAuth":
		return C.CString(globalBridge.UpdateAuth(payload))

	case "startOAuthLogin":
		return C.CString(globalBridge.StartOAuthLogin(payload))

	case "setOAuthToken":
		var req struct {
			Token string `json:"token"`
			Org   string `json:"org"`
			Env   string `json:"env"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		return C.CString(globalBridge.SetOAuthToken(req.Token, req.Org, req.Env))

	default:
		log.Printf("[WARN] Unknown bridge action: %s", action)
		return C.CString(`{"error": "unknown action"}`)
	}
}

func init() {
	runtime.LockOSThread()
}

func main() {
	appConfig := pkg.LoadConfig()
	log.Printf("[INFO] Starting Shuffle Agent Runner (Darwin Native Starter)")
	if appConfig.IsStandalone {
		log.Printf("[INFO] Running in FULL STANDALONE mode (no base_url). No background workers started.")
	} else {
		log.Printf("[INFO] Running in REMOTE mode (BaseURL: %s)", appConfig.BaseURL)
	}
	log.Printf("[INFO] Hostname: %s|%s", appConfig.Hostname, appConfig.MachineID)

	isAccessTrusted := C.CheckAccessibilityTrusted() != 0
	hasScreenAccess := C.CheckScreenRecordingPermission() != 0
	log.Printf("[INFO] macOS Accessibility Trust: %v", isAccessTrusted)
	log.Printf("[INFO] macOS Screen Recording Access: %v", hasScreenAccess)

	if !appConfig.IsStandalone {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		go func() {
			err := pkg.StartAgentLoop(ctx, appConfig, nil)
			if err != nil && ctx.Err() == nil {
				log.Printf("[ERROR] Remote queue worker failed: %v", err)
			}
		}()
	}

	systray.Run(func() {
		onReady(appConfig)
	}, onExit)
}

func onReady(cfg *pkg.Config) {
	log.Println("[INFO] Systray event loop initialized on main thread")

	globalBridge = pkg.NewAgentBridge(cfg)

	// Pre-warm the native agent window so opening it is instantaneous
	htmlStr := C.CString(pkg.EmbeddedAgentHTML)
	C.InitAgentWindow(htmlStr)

	// Show only the Shuffle icon in the top menu bar
	systray.SetTooltip("Shuffle Agent Runner")

	if len(pkg.ShuffleIconPNG) > 0 {
		systray.SetIcon(pkg.ShuffleIconPNG)
	}

	// Status line
	statusTitle := "Status: Standalone (Local)"
	if !cfg.IsStandalone {
		statusTitle = "Status: Connected to " + cfg.BaseURL
	}
	mStatus := systray.AddMenuItem(statusTitle, "Agent status")
	mStatus.Disable()

	modeTitle := "Mode: Full Standalone (Zero Ports)"
	if !cfg.IsStandalone {
		modeTitle = "Mode: Remote Queue Worker"
	}
	mMode := systray.AddMenuItem(modeTitle, "Execution mode")
	mMode.Disable()

	systray.AddSeparator()

	// On-Demand Window Tool
	mOpenWindow := systray.AddMenuItem("Open Agent Window", "Launch the desktop dashboard")

	systray.AddSeparator()

	// Direct OS Actions
	mScreenshot := systray.AddMenuItem("Take Screenshot", "Capture display screenshot")
	mInspectUI := systray.AddMenuItem("Inspect Focused UI", "Introspect focused UI accessibility elements")
	mTelemetry := systray.AddMenuItem("Log Host Telemetry", "Gather host specs & compliance")

	systray.AddSeparator()

	mPerms := systray.AddMenuItem("Check / Request Permissions", "Prompt for Accessibility and Screen Recording")

	systray.AddSeparator()

	mQuit := systray.AddMenuItem("Quit Shuffle", "Exit the agent runner")

	// Handle Menu Events
	go func() {
		for {
			select {
			case <-mOpenWindow.ClickedCh:
				log.Println("[INFO] Top bar clicked: Open Agent Window")
				winHtmlStr := C.CString(pkg.EmbeddedAgentHTML)
				C.ShowAgentWindow(winHtmlStr)

			case <-mScreenshot.ClickedCh:
				log.Println("[INFO] Top bar clicked: Take Screenshot")
				screens, err := osctrl.ScreenshotAllDisplaysMacos()
				if err != nil {
					log.Printf("[ERROR] Screenshot failed: %v", err)
				} else {
					log.Printf("[INFO] Screenshot captured successfully (%d displays)", len(screens))
				}

			case <-mInspectUI.ClickedCh:
				log.Println("[INFO] Top bar clicked: Inspect Focused UI")
				elements, err := osctrl.FetchFocusedElement(1, 4)
				if err != nil {
					log.Printf("[ERROR] Inspect UI failed: %v", err)
				} else {
					log.Printf("[INFO] Inspect UI returned %d elements", len(elements))
				}

			case <-mTelemetry.ClickedCh:
				log.Println("[INFO] Top bar clicked: Log Host Telemetry")
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				stats := pkg.CollectSensorStats(ctx, cfg)
				cancel()
				log.Printf("[INFO] Host OS: %s, User: %s, Elevated: %v, Encrypted: %s",
					stats.SensorDetails.OS, stats.SensorDetails.User, stats.SensorDetails.ElevatedAccess, stats.SensorDetails.HdEncrypted)

			case <-mPerms.ClickedCh:
				log.Println("[INFO] Top bar clicked: Request Permissions")
				C.PromptAccessibility()
				C.PromptScreenRecording()

			case <-mQuit.ClickedCh:
				log.Println("[INFO] Top bar clicked: Quit")
				systray.Quit()
				return
			}
		}
	}()
}

func onExit() {
	log.Println("[INFO] Exiting Shuffle Agent Runner")
}
