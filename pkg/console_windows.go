//go:build windows

package pkg

import (
	"os"
	"syscall"
	"unsafe"
)

// ConfigureWindowsConsole configures the Windows console and process execution flags:
// 1. Enables Virtual Terminal (VT) processing on stdout/stderr for ANSI escape codes.
// 2. Disables QuickEdit Mode and Mouse Input on stdin so clicking or switching window focus never suspends the process.
// 3. Disables Windows Process Power Throttling (EcoQoS) so background execution runs at full speed when the window loses focus.
func ConfigureWindowsConsole() {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	setConsoleMode := kernel32.NewProc("SetConsoleMode")
	getConsoleMode := kernel32.NewProc("GetConsoleMode")
	getStdHandle := kernel32.NewProc("GetStdHandle")

	// 1. Enable VT Mode on stdout and stderr
	for _, handle := range []syscall.Handle{syscall.Handle(os.Stdout.Fd()), syscall.Handle(os.Stderr.Fd())} {
		var mode uint32
		r, _, _ := getConsoleMode.Call(uintptr(handle), uintptr(unsafe.Pointer(&mode)))
		if r != 0 {
			// ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
			_, _, _ = setConsoleMode.Call(uintptr(handle), uintptr(mode|0x0004))
		}
	}

	// 2. Disable QuickEdit mode and Mouse Input on stdin to prevent process suspension on click/unfocus
	const (
		STD_INPUT_HANDLE       = uint32(0xfffffff6) // (DWORD)-10
		ENABLE_QUICK_EDIT_MODE = 0x0040
		ENABLE_EXTENDED_FLAGS  = 0x0080
		ENABLE_MOUSE_INPUT     = 0x0010
	)
	hIn, _, _ := getStdHandle.Call(uintptr(STD_INPUT_HANDLE))
	if hIn != 0 && hIn != uintptr(syscall.InvalidHandle) {
		var inMode uint32
		r, _, _ := getConsoleMode.Call(hIn, uintptr(unsafe.Pointer(&inMode)))
		if r != 0 {
			inMode &^= (ENABLE_QUICK_EDIT_MODE | ENABLE_MOUSE_INPUT)
			inMode |= ENABLE_EXTENDED_FLAGS
			_, _, _ = setConsoleMode.Call(hIn, uintptr(inMode))
		}
	}

	// 3. Disable Windows Process Power Throttling (EcoQoS) so background execution is never throttled when unfocused
	setProcessInformation := kernel32.NewProc("SetProcessInformation")
	if setProcessInformation.Find() == nil {
		currentProcess, err := syscall.GetCurrentProcess()
		if err == nil {
			type processPowerThrottlingState struct {
				Version     uint32
				ControlMask uint32
				StateMask   uint32
			}
			state := processPowerThrottlingState{
				Version:     1,
				ControlMask: 0x1, // PROCESS_POWER_THROTTLING_EXECUTION_SPEED
				StateMask:   0,   // disable throttling
			}
			_, _, _ = setProcessInformation.Call(
				uintptr(currentProcess),
				4, // ProcessPowerThrottling
				uintptr(unsafe.Pointer(&state)),
				uintptr(unsafe.Sizeof(state)),
			)
		}
	}
}
