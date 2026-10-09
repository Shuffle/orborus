package pkg

import (
	"bytes"
	"io"
	"log"
	"os"
	"strings"
)

// ANSI Color constants
const (
	colorReset   = "\033[0m"
	colorRed     = "\033[1;31m"
	colorYellow  = "\033[1;33m"
	colorCyan    = "\033[1;36m"
	colorMagenta = "\033[1;35m"
	colorDim     = "\033[2m"
)

// ColorWriter wraps an io.Writer and injects ANSI colors into [ERROR], [WARNING], [INFO], and [DEBUG] prefixes
type ColorWriter struct {
	w io.Writer
}

func NewColorWriter(w io.Writer) *ColorWriter {
	ConfigureWindowsConsole()
	return &ColorWriter{w: w}
}

func (cw *ColorWriter) Write(p []byte) (n int, err error) {
	s := string(p)

	// Normalize [WARN] to [WARNING]
	if strings.Contains(s, "[WARN]") {
		s = strings.ReplaceAll(s, "[WARN]", "[WARNING]")
	}

	// Apply vibrant ANSI colors
	if strings.Contains(s, "[ERROR]") {
		s = strings.Replace(s, "[ERROR]", colorRed+"[ERROR]"+colorReset, 1)
	} else if strings.Contains(s, "[WARNING]") {
		s = strings.Replace(s, "[WARNING]", colorYellow+"[WARNING]"+colorReset, 1)
	} else if strings.Contains(s, "[INFO]") {
		s = strings.Replace(s, "[INFO]", colorCyan+"[INFO]"+colorReset, 1)
	} else if strings.Contains(s, "[DEBUG]") {
		s = strings.Replace(s, "[DEBUG]", colorMagenta+"[DEBUG]"+colorReset, 1)
	}

	_, err = cw.w.Write([]byte(s))
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

// StripColorWriter ensures log files on disk do not contain ANSI escape codes
type StripColorWriter struct {
	w io.Writer
}

func NewStripColorWriter(w io.Writer) *StripColorWriter {
	return &StripColorWriter{w: w}
}

func (sw *StripColorWriter) Write(p []byte) (n int, err error) {
	clean := stripAnsi(p)
	_, err = sw.w.Write(clean)
	if err != nil {
		return 0, err
	}
	return len(p), nil
}

func stripAnsi(b []byte) []byte {
	var buf bytes.Buffer
	inEscape := false
	for i := 0; i < len(b); i++ {
		if b[i] == 0x1b { // ESC
			inEscape = true
			continue
		}
		if inEscape {
			if (b[i] >= 'A' && b[i] <= 'Z') || (b[i] >= 'a' && b[i] <= 'z') {
				inEscape = false
			}
			continue
		}
		buf.WriteByte(b[i])
	}
	return buf.Bytes()
}

// SetupLogging initializes standard logger with color output for terminal and clean output for disk
func SetupLogging(logFilePath string) (cleanup func()) {
	ConfigureWindowsConsole()
	termWriter := NewColorWriter(os.Stdout)

	if logFilePath != "" {
		if file, err := os.OpenFile(logFilePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644); err == nil {
			cleanFileWriter := NewStripColorWriter(file)
			log.SetOutput(io.MultiWriter(termWriter, cleanFileWriter))
			return func() {
				_ = file.Close()
			}
		}
	}

	log.SetOutput(termWriter)
	return func() {}
}
