//go:build !windows

package pkg

// ConfigureWindowsConsole is a no-op on non-Windows platforms.
func ConfigureWindowsConsole() {}
