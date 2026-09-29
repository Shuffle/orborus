package pkg

import (
	_ "embed"
)

//go:embed ui/index.html
var EmbeddedAgentHTML string
