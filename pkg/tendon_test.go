package pkg

import (
	"os"
	"testing"
)

func TestGetTendonVersion(t *testing.T) {
	// Default
	_ = os.Unsetenv("SHUFFLE_TENDON_VERSION")
	_ = os.Unsetenv("TENDON_VERSION")
	if v := GetTendonVersion(); v != "0.0.1" {
		t.Fatalf("expected default version '0.0.1', got %q", v)
	}

	// Environment override with leading v
	_ = os.Setenv("TENDON_VERSION", "v0.0.1")
	if v := GetTendonVersion(); v != "0.0.1" {
		t.Fatalf("expected stripped version '0.0.1', got %q", v)
	}

	// Specific version
	_ = os.Setenv("SHUFFLE_TENDON_VERSION", "0.2.0")
	if v := GetTendonVersion(); v != "0.2.0" {
		t.Fatalf("expected '0.2.0', got %q", v)
	}
	_ = os.Unsetenv("SHUFFLE_TENDON_VERSION")
	_ = os.Unsetenv("TENDON_VERSION")
}

func TestGetTendonReleaseURLs(t *testing.T) {
	tag := GetTendonReleaseTag("0.0.1")
	if tag != "v0.0.1" {
		t.Fatalf("expected 'v0.0.1', got %q", tag)
	}

	url := GetTendonReleaseURL("0.0.1")
	expected := "https://github.com/Shuffle/tendon/releases/tag/v0.0.1"
	if url != expected {
		t.Fatalf("expected %q, got %q", expected, url)
	}

	downloadBase := GetTendonDownloadBaseURL("0.0.1")
	expectedDownload := "https://github.com/Shuffle/tendon/releases/download/v0.0.1"
	if downloadBase != expectedDownload {
		t.Fatalf("expected %q, got %q", expectedDownload, downloadBase)
	}
}
