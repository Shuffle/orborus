//go:build windows

package main

import (
	"os"
	"testing"

	"orborus/pkg"
	"vllm-client/executor"
)

func TestAssembleUI(t *testing.T) {
	html, err := pkg.AssembleUI("pkg/ui/src")
	if err != nil {
		t.Fatalf("pkg.AssembleUI failed: %v", err)
	}
	if err := os.WriteFile("pkg/ui/index.html", []byte(html), 0644); err != nil {
		t.Fatalf("Failed to write pkg/ui/index.html: %v", err)
	}
}

func TestLocalExecutorHardwareDiscovery(t *testing.T) {
	disco, err := executor.Discover()
	if err != nil {
		t.Fatalf("executor.Discover failed: %v", err)
	}

	t.Logf("Discovery: OS=%s, GPUFound=%v, GPUName=%s, VRAMTotalMB=%d, VRAMFreeMB=%d, Accel=%s",
		disco.OS, disco.GPUFound, disco.GPUName, disco.VRAMTotalMB, disco.VRAMFreeMB, disco.AccelerationType)

	if !disco.GPUFound {
		t.Logf("Warning: GPU not detected directly via WMI/NVML, check driver")
	}
}

func TestLocalExecutorManagerInit(t *testing.T) {
	mgr := newLocalExecutorManager()
	if mgr == nil {
		t.Fatal("newLocalExecutorManager returned nil")
	}

	if mgr.disco == nil {
		t.Fatal("expected discovery data in manager")
	}
}
