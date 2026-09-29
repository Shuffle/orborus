package pkg

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/user"
	"runtime"

	"github.com/shuffle/osctrl"
	"github.com/shuffle/shuffle-shared"
)

// CollectSensorStats gathers host telemetry using osctrl and host primitives
func CollectSensorStats(ctx context.Context, cfg *Config) shuffle.OrborusStats {
	var stats shuffle.OrborusStats
	if cfg == nil {
		return stats
	}

	stats.SensorDetails.SensorMode = true
	stats.SensorDetails.Hostname = cfg.Hostname
	stats.SensorDetails.OS = runtime.GOOS
	stats.SensorDetails.Arch = runtime.GOARCH
	stats.SensorDetails.Isolated = os.Getenv("HOST_ISOLATED") == "true"
	stats.SensorDetails.ElevatedAccess = osctrl.IsElevated()
	stats.SensorDetails.Serial = osctrl.GetProfiler()
	stats.SensorDetails.ResponseActions = cfg.SensorMode.ResponseActions

	if u, err := user.Current(); err == nil {
		stats.SensorDetails.User = u.Username
	}

	if cfg.SensorMode.ProcessListEnabled != "false" {
		if procs, err := osctrl.ListProcesses(); err == nil {
			stats.SensorDetails.ProcessList = procs
		} else if cfg.Debug {
			log.Printf("[DEBUG] Failed listing processes: %v", err)
		}
	}

	if cfg.SensorMode.SoftwareListEnabled != "false" {
		stats.SensorDetails.InstalledSoftware = osctrl.ListInstalledSoftware()
	}

	if cfg.SensorMode.CodeScannerEnabled != "false" {
		stats.SensorDetails.CodeScanner = osctrl.ListCodeScannerProjects()
	}

	if cfg.SensorMode.HdEncryptedCheck != "false" {
		stats.SensorDetails.HdEncrypted = fmt.Sprintf("%t", osctrl.IsDiskEncrypted())
	}

	if cfg.SensorMode.ScreenlockCheck != "false" {
		stats.SensorDetails.AutomaticScreenlockEnabled = fmt.Sprintf("%t", osctrl.IsAutomaticScreenlockEnabled())
	}

	if len(cfg.SensorMode.LogForwarding) > 0 && cfg.SensorMode.LogForwarding != "false" {
		stats.SensorDetails.LogForwarding = fmt.Sprintf("configured: %s", cfg.SensorMode.LogForwarding)
	}

	return stats
}
