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

static NSImage *globalAppIcon = nil;

static inline void SetupAppMenu() {
    dispatch_async(dispatch_get_main_queue(), ^{
        if ([NSApp mainMenu] == nil || [[NSApp mainMenu] numberOfItems] == 0) {
            NSMenu *menubar = [[NSMenu alloc] init];
            NSMenuItem *appMenuItem = [[NSMenuItem alloc] init];
            [menubar addItem:appMenuItem];
            [NSApp setMainMenu:menubar];

            NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"Shuffle Agent"];
            [appMenuItem setTitle:@"Shuffle Agent"];

            NSMenuItem *hideItem = [[NSMenuItem alloc] initWithTitle:@"Hide Shuffle Agent"
                                                              action:@selector(hide:)
                                                       keyEquivalent:@"h"];
            [appMenu addItem:hideItem];

            NSMenuItem *hideOthers = [[NSMenuItem alloc] initWithTitle:@"Hide Others"
                                                                action:@selector(hideOtherApplications:)
                                                         keyEquivalent:@"h"];
            [hideOthers setKeyEquivalentModifierMask:(NSEventModifierFlagOption | NSEventModifierFlagCommand)];
            [appMenu addItem:hideOthers];

            NSMenuItem *showAll = [[NSMenuItem alloc] initWithTitle:@"Show All"
                                                             action:@selector(unhideAllApplications:)
                                                      keyEquivalent:@""];
            [appMenu addItem:showAll];

            [appMenu addItem:[NSMenuItem separatorItem]];

            NSMenuItem *quitItem = [[NSMenuItem alloc] initWithTitle:@"Quit Shuffle Agent"
                                                              action:@selector(terminate:)
                                                       keyEquivalent:@"q"];
            [appMenu addItem:quitItem];
            [appMenuItem setSubmenu:appMenu];

            // Edit Menu for Cut, Copy, Paste, Select All (Cmd+A), Undo, Redo
            NSMenuItem *editMenuItem = [[NSMenuItem alloc] init];
            [menubar addItem:editMenuItem];
            NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
            [editMenuItem setTitle:@"Edit"];

            [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
            NSMenuItem *redoItem = [editMenu addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
            [redoItem setKeyEquivalentModifierMask:(NSEventModifierFlagShift | NSEventModifierFlagCommand)];
            [editMenu addItem:[NSMenuItem separatorItem]];
            [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
            [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
            [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
            [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
            [editMenuItem setSubmenu:editMenu];

            // Window Menu for Minimize, Zoom, Close
            NSMenuItem *windowMenuItem = [[NSMenuItem alloc] init];
            [menubar addItem:windowMenuItem];
            NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"Window"];
            [windowMenuItem setTitle:@"Window"];
            [windowMenu addItemWithTitle:@"Minimize" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
            [windowMenu addItemWithTitle:@"Zoom" action:@selector(performZoom:) keyEquivalent:@""];
            [windowMenu addItem:[NSMenuItem separatorItem]];
            [windowMenu addItemWithTitle:@"Close Window" action:@selector(performClose:) keyEquivalent:@"w"];
            [windowMenuItem setSubmenu:windowMenu];
        }
    });
}

static inline void ApplyAppIdentity(const void *iconData, int iconLen) {
    [[NSProcessInfo processInfo] setProcessName:@"Shuffle Agent"];

    if (iconData != NULL && iconLen > 0) {
        NSData *data = [NSData dataWithBytes:iconData length:iconLen];
        dispatch_async(dispatch_get_main_queue(), ^{
            globalAppIcon = [[NSImage alloc] initWithData:data];
            if (globalAppIcon != nil) {
                [NSApp setApplicationIconImage:globalAppIcon];
                [[NSApp dockTile] display];
            }
        });
    }
    SetupAppMenu();
}

static NSWindow *agentWindow = nil;
static WKWebView *agentWebView = nil;

static void ensureAgentWindowCreated(const char *htmlContent) {
    if (agentWindow != nil) return;

    NSRect frame = NSMakeRect(200, 200, 950, 700);
    NSUInteger style = NSWindowStyleMaskTitled |
                       NSWindowStyleMaskFullSizeContentView |
                       NSWindowStyleMaskClosable |
                       NSWindowStyleMaskMiniaturizable |
                       NSWindowStyleMaskResizable;
    agentWindow = [[NSWindow alloc] initWithContentRect:frame
                                              styleMask:style
                                                backing:NSBackingStoreBuffered
                                                  defer:NO];
    [agentWindow setTitle:@"Shuffle Agent"];
    [agentWindow setTitleVisibility:NSWindowTitleHidden];
    [agentWindow setTitlebarAppearsTransparent:YES];
    [[agentWindow standardWindowButton:NSWindowCloseButton] setHidden:YES];
    [[agentWindow standardWindowButton:NSWindowMiniaturizeButton] setHidden:YES];
    [[agentWindow standardWindowButton:NSWindowZoomButton] setHidden:YES];
    [agentWindow setMovableByWindowBackground:YES];
    [agentWindow setReleasedWhenClosed:NO];
    [agentWindow setMinSize:NSMakeSize(640, 480)];
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
        "window.runPrompt = function(prompt, bypass, convId) { return window.bridgeCall('runPrompt', JSON.stringify({prompt: prompt, bypass: bypass, conversation_id: convId || ''})); };"
        "window.respondApproval = function(id, approved) { return window.bridgeCall('respondApproval', JSON.stringify({id: id, approved: approved})); };"
        "window.respondApprovalWithOptions = function(id, option, commandPrefix, scope, scopeId) { return window.bridgeCall('respondApprovalWithOptions', JSON.stringify({id: id, option: option, command_prefix: commandPrefix, scope: scope, scope_id: scopeId})); };"
        "window.getApprovalRules = function() { return window.bridgeCall('getApprovalRules', ''); };"
        "window.addApprovalRule = function(rule) { return window.bridgeCall('addApprovalRule', JSON.stringify(rule)); };"
        "window.revokeApprovalRule = function(id) { return window.bridgeCall('revokeApprovalRule', id); };"
        "window.clearApprovalRules = function() { return window.bridgeCall('clearApprovalRules', ''); };"
        "window.setPinnedConversations = function(pinned) { return window.bridgeCall('setPinnedConversations', JSON.stringify(pinned)); };"
        "window.takeScreenshot = function() { return window.bridgeCall('takeScreenshot', ''); };"
        "window.inspectUI = function() { return window.bridgeCall('inspectUI', ''); };"
        "window.requestOSPermission = function(perm) { return window.bridgeCall('requestOSPermission', perm); };"
        "window.updateAuth = function(authData) { return window.bridgeCall('updateAuth', JSON.stringify(authData)); };"
        "window.setAiConfig = function(url, key, policy, model) { return window.bridgeCall('setAiConfig', JSON.stringify({url: url, key: key, permission_policy: policy || '', model: model || ''})); };"
        "window.startOAuthLogin = function(url) { return window.bridgeCall('startOAuthLogin', url || ''); };"
        "window.setOAuthToken = function(token, org, env) { return window.bridgeCall('setOAuthToken', JSON.stringify({token: token, org: org, env: env})); };"
        "window.windowAction = function(act) { return window.bridgeCall('windowAction', act); };"
        "window.chooseDirectory = function() { return window.bridgeCall('chooseDirectory', ''); };"
        "window.clearHistory = function() { return window.bridgeCall('clearHistory', ''); };"
        "window.saveAllSettings = function(settings) { return window.bridgeCall('saveAllSettings', JSON.stringify(settings)); };"
        "window.setProjectPermissions = function(project, perms) { return window.bridgeCall('setProjectPermissions', JSON.stringify({project: project, permissions: perms})); };";

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

static inline void WindowAction(const char *action) {
    if (action == NULL) return;
    NSString *act = [NSString stringWithUTF8String:action];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (agentWindow == nil) return;
        if ([act isEqualToString:@"close"] || [act isEqualToString:@"exit"]) {
            [agentWindow orderOut:nil];
        } else if ([act isEqualToString:@"minimize"] || [act isEqualToString:@"lower"]) {
            [agentWindow miniaturize:nil];
        } else if ([act isEqualToString:@"maximize"] || [act isEqualToString:@"expand"]) {
            [agentWindow zoom:nil];
        }
    });
}

static char* ChooseFolderDialog() {
    __block char *result = NULL;
    dispatch_sync(dispatch_get_main_queue(), ^{
        NSOpenPanel *panel = [NSOpenPanel openPanel];
        [panel setCanChooseFiles:NO];
        [panel setCanChooseDirectories:YES];
        [panel setAllowsMultipleSelection:NO];
        [panel setPrompt:@"Select"];
        [panel setMessage:@"Select Project Directory"];
        if (agentWindow != nil) {
            [panel setLevel:[agentWindow level] + 1];
        } else {
            [panel setLevel:NSFloatingWindowLevel];
        }
        [NSApp activateIgnoringOtherApps:YES];
        if ([panel runModal] == NSModalResponseOK) {
            NSURL *url = [[panel URLs] firstObject];
            if (url != nil) {
                const char *path = [[url path] UTF8String];
                if (path != NULL) {
                    result = strdup(path);
                }
            }
        }
    });
    return result;
}

static char* ChooseFileDialog() {
    __block char *result = NULL;
    dispatch_sync(dispatch_get_main_queue(), ^{
        NSOpenPanel *panel = [NSOpenPanel openPanel];
        [panel setCanChooseFiles:YES];
        [panel setCanChooseDirectories:NO];
        [panel setAllowsMultipleSelection:NO];
        [panel setPrompt:@"Select"];
        [panel setMessage:@"Select File to Attach"];
        if (agentWindow != nil) {
            [panel setLevel:[agentWindow level] + 1];
        } else {
            [panel setLevel:NSFloatingWindowLevel];
        }
        [NSApp activateIgnoringOtherApps:YES];
        if ([panel runModal] == NSModalResponseOK) {
            NSURL *url = [[panel URLs] firstObject];
            if (url != nil) {
                const char *path = [[url path] UTF8String];
                if (path != NULL) {
                    result = strdup(path);
                }
            }
        }
    });
    return result;
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
            if (globalAppIcon != nil) {
                [NSApp setApplicationIconImage:globalAppIcon];
                [[NSApp dockTile] display];
            }
            SetupAppMenu();
            [agentWindow setIsVisible:YES];
            [agentWindow makeKeyAndOrderFront:nil];
            if (agentWebView != nil) {
                [agentWindow makeFirstResponder:agentWebView];
            }
            [agentWindow orderFrontRegardless];
            [NSApp activateIgnoringOtherApps:YES];
        } else {
            NSLog(@"[ERROR] agentWindow could not be created");
        }
    });
}

static inline void EvaluateJSInAgentWindow(const char *jsCode) {
    if (jsCode == NULL) return;
    NSString *js = [NSString stringWithUTF8String:jsCode];
    dispatch_async(dispatch_get_main_queue(), ^{
        if (agentWebView != nil) {
            [agentWebView evaluateJavaScript:js completionHandler:nil];
        }
    });
}
*/
import "C"

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"runtime"
	"strings"
	"unsafe"

	"fyne.io/systray"
	"orborus/pkg"
)

var globalBridge *pkg.AgentBridge

//export HandleBridgeAction
func HandleBridgeAction(cAction *C.char, cPayload *C.char) *C.char {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("[ERROR] Recovered from panic in HandleBridgeAction: %v", r)
		}
	}()

	if cAction == nil {
		return C.CString(`{"error": "nil action"}`)
	}
	action := C.GoString(cAction)
	payload := ""
	if cPayload != nil {
		payload = C.GoString(cPayload)
	}

	if globalBridge == nil {
		return C.CString(`{"error": "bridge not initialized"}`)
	}

	isDebug := strings.EqualFold(os.Getenv("DEBUG"), "true") || os.Getenv("DEBUG") == "1" ||
		(globalBridge != nil && globalBridge.GetConfig() != nil && globalBridge.GetConfig().Debug)
	if isDebug {
		log.Printf("[DEBUG] HandleBridgeAction: %s (payload: %s)", action, payload)
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
			Prompt         string `json:"prompt"`
			Bypass         bool   `json:"bypass"`
			ConversationID string `json:"conversation_id"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err != nil {
			req.Prompt = payload
		}
		return C.CString(globalBridge.RunPrompt(req.Prompt, req.Bypass, req.ConversationID))

	case "respondApproval":
		var req struct {
			ID            string `json:"id"`
			Approved      bool   `json:"approved"`
			Option        int    `json:"option"`
			CommandPrefix string `json:"command_prefix"`
			Scope         string `json:"scope"`
			ScopeID       string `json:"scope_id"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			if req.Option > 0 {
				return C.CString(globalBridge.RespondApprovalWithOptions(req.ID, req.Option, req.CommandPrefix, req.Scope, req.ScopeID))
			}
			return C.CString(globalBridge.RespondApproval(req.ID, req.Approved))
		}
		return C.CString(`{"error": "invalid payload"}`)

	case "respondApprovalWithOptions":
		var req struct {
			ID            string `json:"id"`
			Option        int    `json:"option"`
			CommandPrefix string `json:"command_prefix"`
			Scope         string `json:"scope"`
			ScopeID       string `json:"scope_id"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			return C.CString(globalBridge.RespondApprovalWithOptions(req.ID, req.Option, req.CommandPrefix, req.Scope, req.ScopeID))
		}
		return C.CString(`{"error": "invalid payload"}`)

	case "getApprovalRules":
		return C.CString(globalBridge.GetApprovalRules())

	case "addApprovalRule":
		return C.CString(globalBridge.AddApprovalRule(payload))

	case "revokeApprovalRule":
		return C.CString(globalBridge.RevokeApprovalRule(payload))

	case "clearApprovalRules":
		return C.CString(globalBridge.ClearApprovalRules())

	case "setPinnedConversations":
		return C.CString(globalBridge.SetPinnedConversations(payload))

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

	case "setAiConfig":
		var req struct {
			URL              string `json:"url"`
			Key              string `json:"key"`
			Model            string `json:"model"`
			PermissionPolicy string `json:"permission_policy"`
		}
		_ = json.Unmarshal([]byte(payload), &req)
		if req.PermissionPolicy != "" {
			globalBridge.SetPermissionPolicy(req.PermissionPolicy)
		}
		return C.CString(globalBridge.SetAiConfig(req.URL, req.Key, req.Model))

	case "windowAction":
		cAct := C.CString(payload)
		defer C.free(unsafe.Pointer(cAct))
		C.WindowAction(cAct)
		return C.CString(`{"status": "ok"}`)

	case "chooseDirectory":
		cPath := C.ChooseFolderDialog()
		if cPath != nil {
			path := C.GoString(cPath)
			C.free(unsafe.Pointer(cPath))
			resp, _ := json.Marshal(map[string]interface{}{"status": "ok", "path": path})
			return C.CString(string(resp))
		}
		return C.CString(`{"status": "cancelled", "path": ""}`)

	case "chooseFile":
		cPath := C.ChooseFileDialog()
		if cPath != nil {
			path := C.GoString(cPath)
			C.free(unsafe.Pointer(cPath))
			resp, _ := json.Marshal(map[string]interface{}{"status": "ok", "path": path})
			return C.CString(string(resp))
		}
		return C.CString(`{"status": "cancelled", "path": ""}`)

	case "clearHistory":
		return C.CString(globalBridge.ClearHistory())

	case "saveAllSettings":
		return C.CString(globalBridge.SaveAllSettings(payload))

	case "setProjectPermissions":
		var req struct {
			Project     string                `json:"project"`
			Permissions pkg.ProjectPermission `json:"permissions"`
		}
		if err := json.Unmarshal([]byte(payload), &req); err == nil {
			return C.CString(globalBridge.SetProjectPermissions(req.Project, req.Permissions))
		}
		return C.CString(`{"error": "invalid payload"}`)

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
	isDebugStartup := strings.EqualFold(os.Getenv("DEBUG"), "true") || os.Getenv("DEBUG") == "1" || appConfig.Debug
	if isDebugStartup {
		log.Printf("[DEBUG] Verbose debug logging enabled via DEBUG=true (Standalone: %v, BaseURL: %s, Environment: %s)", appConfig.IsStandalone, appConfig.BaseURL, appConfig.Environment)
	}
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
	globalBridge.SetOnAuthUpdated(func(stateJSON string) {
		js := fmt.Sprintf("if (window.onAuthUpdated) { window.onAuthUpdated(%s); }", stateJSON)
		cJs := C.CString(js)
		defer C.free(unsafe.Pointer(cJs))
		C.EvaluateJSInAgentWindow(cJs)
	})

	// Pre-warm the native agent window so opening it is instantaneous
	htmlStr := C.CString(pkg.EmbeddedAgentHTML)
	C.InitAgentWindow(htmlStr)

	// Apply app identity (Process Name "Shuffle Agent" and 512x512 Shuffle Logo for Cmd+Tab and Dock)
	if len(pkg.AppIconPNG) > 0 {
		cIcon := C.CBytes(pkg.AppIconPNG)
		defer C.free(cIcon)
		C.ApplyAppIdentity(cIcon, C.int(len(pkg.AppIconPNG)))
	} else if len(pkg.ShuffleIconPNG) > 0 {
		cIcon := C.CBytes(pkg.ShuffleIconPNG)
		defer C.free(cIcon)
		C.ApplyAppIdentity(cIcon, C.int(len(pkg.ShuffleIconPNG)))
	}

	// Show only the Shuffle icon in the top menu bar
	systray.SetTooltip("Shuffle Agent")

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

	mPerms := systray.AddMenuItem("Check / Request Permissions", "Prompt for Accessibility and Screen Recording")

	systray.AddSeparator()

	mQuit := systray.AddMenuItem("Quit Shuffle Agent", "Exit the agent runner")

	// Handle Menu Events
	go func() {
		for {
			select {
			case <-mOpenWindow.ClickedCh:
				log.Println("[INFO] Top bar clicked: Open Agent Window")
				if len(pkg.AppIconPNG) > 0 {
					cIcon := C.CBytes(pkg.AppIconPNG)
					C.ApplyAppIdentity(cIcon, C.int(len(pkg.AppIconPNG)))
					C.free(cIcon)
				}
				winHtmlStr := C.CString(pkg.EmbeddedAgentHTML)
				C.ShowAgentWindow(winHtmlStr)

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
