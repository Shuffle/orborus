package pkg

import _ "embed"

// ShuffleIconPNG contains the 32x32 official Shuffle icon
//
//go:embed shuffle_icon.png
var ShuffleIconPNG []byte

// AppIconPNG contains the 512x512 official Shuffle app icon for Dock and Cmd+Tab
//
//go:embed app_icon.png
var AppIconPNG []byte

// ShuffleIconICO contains the official Shuffle icon formatted for Windows systray
//
//go:embed shuffle_icon.ico
var ShuffleIconICO []byte

