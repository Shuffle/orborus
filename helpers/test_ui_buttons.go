package main

import (
	"fmt"
	"os"
	"path/filepath"

	"orborus/pkg/uivalidate"
)

func main() {
	htmlPath := filepath.Join("pkg", "ui", "index.html")
	fmt.Println("🔍 Running Automated Button & UI Handler Tests with Vivaldi Headless...")

	res, err := uivalidate.RunButtonTests(htmlPath)
	if err != nil {
		fmt.Printf("❌ Failed to run button tests: %v\n", err)
		os.Exit(1)
	}

	if len(res.Errors) > 0 {
		fmt.Printf("❌ FAILED: %d error(s) detected across %d buttons and functions!\n", len(res.Errors), res.TotalTested)
		for idx, e := range res.Errors {
			fmt.Printf("   [%d] %s on target '%s': %s\n", idx+1, e.Type, e.Target, e.Message)
			if e.Stack != "" {
				fmt.Printf("       Stack: %s\n", e.Stack)
			}
		}
		os.Exit(1)
	}

	fmt.Printf("✅ SUCCESS: Tested %d buttons and %d handlers (%d total interactive elements) with Vivaldi — 0 errors!\n",
		res.TestedButtons, res.TestedFunctions, res.TotalTested)
}
