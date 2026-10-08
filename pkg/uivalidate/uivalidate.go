package uivalidate

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode"
)

// ValidationError describes a syntax or reference error in UI files.
type ValidationError struct {
	File    string
	Line    int
	Col     int
	Message string
}

func (e ValidationError) Error() string {
	if e.File != "" && e.Line > 0 {
		return fmt.Sprintf("[%s:%d:%d] %s", e.File, e.Line, e.Col, e.Message)
	}
	return e.Message
}

type TokenType int

const (
	tokEOF TokenType = iota
	tokIdent
	tokKeyword
	tokNumber
	tokString
	tokRegex
	tokLBrace   // {
	tokRBrace   // }
	tokLParen   // (
	tokRParen   // )
	tokLBracket // [
	tokRBracket // ]
	tokDot      // .
	tokOther    // operators, etc.
)

type Token struct {
	Type TokenType
	Val  string
	Line int
	Col  int
}

// tokenizeJS transforms JS source into tokens, handling comments, strings, regexes, and template literals.
func tokenizeJS(fileName string, src []byte) ([]Token, []ValidationError) {
	var tokens []Token
	var errs []ValidationError

	n := len(src)
	i := 0
	line := 1
	col := 1

	prevCanPrecedeDiv := false // True if previous token can precede a division operator /

	advance := func() byte {
		ch := src[i]
		i++
		if ch == '\n' {
			line++
			col = 1
		} else {
			col++
		}
		return ch
	}

	peek := func() byte {
		if i < n {
			return src[i]
		}
		return 0
	}

	var templateExprStack []bool // true = opened by ${, false = opened by {

	// scanTemplateSlice reads characters inside `...` until `${` or closing `
	scanTemplateSlice := func(startL, startC int) {
		escaped := false
		closed := false

		for i < n {
			cur := advance()
			if escaped {
				escaped = false
				continue
			}
			if cur == '\\' {
				escaped = true
				continue
			}
			if cur == '`' {
				closed = true
				tokens = append(tokens, Token{Type: tokString, Line: startL, Col: startC})
				prevCanPrecedeDiv = true
				break
			}
			if cur == '$' && peek() == '{' {
				advance() // consume '{'
				tokens = append(tokens, Token{Type: tokString, Line: startL, Col: startC})
				tokens = append(tokens, Token{Type: tokLBrace, Val: "${", Line: line, Col: col - 2})
				templateExprStack = append(templateExprStack, true)
				prevCanPrecedeDiv = false
				closed = true
				break
			}
		}

		if !closed {
			errs = append(errs, ValidationError{
				File:    fileName,
				Line:    startL,
				Col:     startC,
				Message: "Unterminated template literal `",
			})
		}
	}

	for i < n {
		startLine := line
		startCol := col
		ch := advance()

		// 1. Whitespace
		if ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' {
			continue
		}

		// 2. Comments
		if ch == '/' && peek() == '/' {
			for i < n && advance() != '\n' {
			}
			continue
		}
		if ch == '/' && peek() == '*' {
			advance()
			closed := false
			for i < n {
				if advance() == '*' && peek() == '/' {
					advance()
					closed = true
					break
				}
			}
			if !closed {
				errs = append(errs, ValidationError{
					File:    fileName,
					Line:    startLine,
					Col:     startCol,
					Message: "Unterminated block comment /* ... */",
				})
			}
			continue
		}

		// 3. Regular Expression vs Division
		if ch == '/' {
			if !prevCanPrecedeDiv {
				// Regular expression literal: /pattern/flags
				inCharClass := false
				escaped := false
				closed := false

				for i < n {
					cur := advance()
					if escaped {
						escaped = false
						continue
					}
					if cur == '\\' {
						escaped = true
						continue
					}
					if cur == '[' {
						inCharClass = true
						continue
					}
					if cur == ']' && inCharClass {
						inCharClass = false
						continue
					}
					if cur == '/' && !inCharClass {
						closed = true
						break
					}
					if cur == '\n' {
						break
					}
				}

				if !closed {
					errs = append(errs, ValidationError{
						File:    fileName,
						Line:    startLine,
						Col:     startCol,
						Message: "Unterminated regular expression literal",
					})
				} else {
					for i < n && unicode.IsLetter(rune(peek())) {
						advance()
					}
					tokens = append(tokens, Token{Type: tokRegex, Line: startLine, Col: startCol})
					prevCanPrecedeDiv = true
				}
				continue
			} else {
				tokens = append(tokens, Token{Type: tokOther, Val: "/", Line: startLine, Col: startCol})
				prevCanPrecedeDiv = false
				continue
			}
		}

		// 4. String Literals ('...' or "...")
		if ch == '\'' || ch == '"' {
			quote := ch
			escaped := false
			closed := false

			for i < n {
				cur := advance()
				if escaped {
					escaped = false
					continue
				}
				if cur == '\\' {
					escaped = true
					continue
				}
				if cur == quote {
					closed = true
					break
				}
				if cur == '\n' && !escaped {
					break
				}
			}

			if !closed {
				errs = append(errs, ValidationError{
					File:    fileName,
					Line:    startLine,
					Col:     startCol,
					Message: fmt.Sprintf("Unterminated string literal %c", quote),
				})
			}
			tokens = append(tokens, Token{Type: tokString, Line: startLine, Col: startCol})
			prevCanPrecedeDiv = true
			continue
		}

		// 5. Template Literals (`...`)
		if ch == '`' {
			scanTemplateSlice(startLine, startCol)
			continue
		}

		// 6. Delimiters
		if ch == '{' {
			templateExprStack = append(templateExprStack, false)
			tokens = append(tokens, Token{Type: tokLBrace, Val: "{", Line: startLine, Col: startCol})
			prevCanPrecedeDiv = false
			continue
		}
		if ch == '}' {
			tokens = append(tokens, Token{Type: tokRBrace, Val: "}", Line: startLine, Col: startCol})
			prevCanPrecedeDiv = true

			// Check if this closes a template interpolation ${ ... }
			if len(templateExprStack) > 0 {
				isTemplateInterpolation := templateExprStack[len(templateExprStack)-1]
				templateExprStack = templateExprStack[:len(templateExprStack)-1]

				if isTemplateInterpolation {
					// Resume reading template characters until next ${ or `
					scanTemplateSlice(line, col)
				}
			}
			continue
		}
		if ch == '(' {
			tokens = append(tokens, Token{Type: tokLParen, Val: "(", Line: startLine, Col: startCol})
			prevCanPrecedeDiv = false
			continue
		}
		if ch == ')' {
			tokens = append(tokens, Token{Type: tokRParen, Val: ")", Line: startLine, Col: startCol})
			prevCanPrecedeDiv = true
			continue
		}
		if ch == '[' {
			tokens = append(tokens, Token{Type: tokLBracket, Val: "[", Line: startLine, Col: startCol})
			prevCanPrecedeDiv = false
			continue
		}
		if ch == ']' {
			tokens = append(tokens, Token{Type: tokRBracket, Val: "]", Line: startLine, Col: startCol})
			prevCanPrecedeDiv = true
			continue
		}
		if ch == '.' {
			tokens = append(tokens, Token{Type: tokDot, Val: ".", Line: startLine, Col: startCol})
			prevCanPrecedeDiv = false
			continue
		}

		// 7. Numbers
		if unicode.IsDigit(rune(ch)) {
			for i < n && (unicode.IsDigit(rune(peek())) || peek() == '.' || peek() == 'x' || peek() == 'X' || peek() == 'b' || peek() == 'o') {
				advance()
			}
			tokens = append(tokens, Token{Type: tokNumber, Line: startLine, Col: startCol})
			prevCanPrecedeDiv = true
			continue
		}

		// 8. Identifiers & Keywords
		if unicode.IsLetter(rune(ch)) || ch == '_' || ch == '$' {
			var sb strings.Builder
			sb.WriteByte(ch)
			for i < n && (unicode.IsLetter(rune(peek())) || unicode.IsDigit(rune(peek())) || peek() == '_' || peek() == '$') {
				sb.WriteByte(advance())
			}
			word := sb.String()

			switch word {
			case "try", "catch", "finally", "function", "if", "else", "for", "while", "do", "switch", "case", "return", "throw":
				tokens = append(tokens, Token{Type: tokKeyword, Val: word, Line: startLine, Col: startCol})
				prevCanPrecedeDiv = false
			default:
				tokens = append(tokens, Token{Type: tokIdent, Val: word, Line: startLine, Col: startCol})
				prevCanPrecedeDiv = true
			}
			continue
		}

		// 9. Other punctuation/operators
		tokens = append(tokens, Token{Type: tokOther, Val: string(ch), Line: startLine, Col: startCol})
		prevCanPrecedeDiv = false
	}

	tokens = append(tokens, Token{Type: tokEOF, Line: line, Col: col})
	return tokens, errs
}

// ValidateJSSyntax validates balanced delimiters and try/catch block associations.
func ValidateJSSyntax(fileName string, code []byte) []ValidationError {
	tokens, lexErrs := tokenizeJS(fileName, code)
	if len(lexErrs) > 0 {
		return lexErrs
	}

	var errs []ValidationError

	type parenFrame struct {
		ch   TokenType
		line int
		col  int
	}

	var parenStack []parenFrame

	// Track brace stack for try/catch association
	braceStack := []struct {
		isTryBlock   bool
		isCatchBlock bool
		line         int
		col          int
	}{}

	var lastClosedBlockWasTry bool
	var lastClosedBlockWasCatch bool

	for i := 0; i < len(tokens); i++ {
		tok := tokens[i]

		isDotAccess := false
		if i > 0 && tokens[i-1].Type == tokDot {
			isDotAccess = true
		}

		switch tok.Type {
		case tokLParen:
			parenStack = append(parenStack, parenFrame{ch: tokLParen, line: tok.Line, col: tok.Col})

		case tokRParen:
			if len(parenStack) == 0 || parenStack[len(parenStack)-1].ch != tokLParen {
				errs = append(errs, ValidationError{
					File:    fileName,
					Line:    tok.Line,
					Col:     tok.Col,
					Message: "Unmatched closing parenthesis ')'",
				})
			} else {
				parenStack = parenStack[:len(parenStack)-1]
			}

		case tokLBracket:
			parenStack = append(parenStack, parenFrame{ch: tokLBracket, line: tok.Line, col: tok.Col})

		case tokRBracket:
			if len(parenStack) == 0 || parenStack[len(parenStack)-1].ch != tokLBracket {
				errs = append(errs, ValidationError{
					File:    fileName,
					Line:    tok.Line,
					Col:     tok.Col,
					Message: "Unmatched closing bracket ']'",
				})
			} else {
				parenStack = parenStack[:len(parenStack)-1]
			}

		case tokLBrace:
			parenStack = append(parenStack, parenFrame{ch: tokLBrace, line: tok.Line, col: tok.Col})

			isTry := false
			isCatch := false
			if i > 0 {
				for j := i - 1; j >= 0; j-- {
					if tokens[j].Type == tokKeyword && tokens[j].Val == "try" {
						isTry = true
						break
					}
					if tokens[j].Type == tokKeyword && tokens[j].Val == "catch" {
						isCatch = true
						break
					}
					if tokens[j].Type == tokRBrace || tokens[j].Type == tokLBrace || tokens[j].Type == tokKeyword {
						break
					}
				}
			}

			braceStack = append(braceStack, struct {
				isTryBlock   bool
				isCatchBlock bool
				line         int
				col          int
			}{isTryBlock: isTry, isCatchBlock: isCatch, line: tok.Line, col: tok.Col})

		case tokRBrace:
			if len(parenStack) == 0 || parenStack[len(parenStack)-1].ch != tokLBrace {
				errs = append(errs, ValidationError{
					File:    fileName,
					Line:    tok.Line,
					Col:     tok.Col,
					Message: "Unmatched closing brace '}'",
				})
			} else {
				parenStack = parenStack[:len(parenStack)-1]
			}

			if len(braceStack) > 0 {
				top := braceStack[len(braceStack)-1]
				braceStack = braceStack[:len(braceStack)-1]
				lastClosedBlockWasTry = top.isTryBlock
				lastClosedBlockWasCatch = top.isCatchBlock
			} else {
				lastClosedBlockWasTry = false
				lastClosedBlockWasCatch = false
			}

		case tokKeyword:
			if tok.Val == "catch" && !isDotAccess {
				if !lastClosedBlockWasTry {
					errs = append(errs, ValidationError{
						File:    fileName,
						Line:    tok.Line,
						Col:     tok.Col,
						Message: "Unexpected token 'catch': not preceded by a try block",
					})
				}
			} else if tok.Val == "finally" && !isDotAccess {
				if !lastClosedBlockWasTry && !lastClosedBlockWasCatch {
					errs = append(errs, ValidationError{
						File:    fileName,
						Line:    tok.Line,
						Col:     tok.Col,
						Message: "Unexpected token 'finally': not preceded by a try or catch block",
					})
				}
			}
		}
	}

	for _, p := range parenStack {
		var charStr string
		switch p.ch {
		case tokLParen:
			charStr = "("
		case tokLBracket:
			charStr = "["
		case tokLBrace:
			charStr = "{"
		}
		errs = append(errs, ValidationError{
			File:    fileName,
			Line:    p.line,
			Col:     p.col,
			Message: fmt.Sprintf("Unclosed delimiter '%s'", charStr),
		})
	}

	return errs
}

// ValidateHandlers inspects index.html and all JS files to ensure all buttons and
// inline event handlers (onclick, onchange, etc.) point to existing functions.
func ValidateHandlers(htmlContent string, jsFilesContent map[string]string) []ValidationError {
	var errs []ValidationError

	declaredSymbols := make(map[string]bool)

	declRegexes := []*regexp.Regexp{
		regexp.MustCompile(`(?m)^[ \t]*(?:async[ \t]+)?function[ \t]+([a-zA-Z0-9_$]+)[ \t]*\(`),
		regexp.MustCompile(`(?m)^[ \t]*(?:window\.)([a-zA-Z0-9_$]+)[ \t]*=[ \t]*(?:async[ \t]*)?(?:function|\([^)]*\)[ \t]*=>)`),
		regexp.MustCompile(`(?m)^[ \t]*(?:const|let|var)[ \t]+([a-zA-Z0-9_$]+)[ \t]*=[ \t]*(?:async[ \t]*)?(?:function|\([^)]*\)[ \t]*=>)`),
		regexp.MustCompile(`(?m)^[ \t]*(?:window\.)([a-zA-Z0-9_$]+)[ \t]*=`),
		regexp.MustCompile(`(?m)^[ \t]*(?:var|let|const)[ \t]+([a-zA-Z0-9_$]+)[ \t]*=`),
	}

	for _, content := range jsFilesContent {
		lines := strings.Split(content, "\n")
		for _, line := range lines {
			for _, re := range declRegexes {
				matches := re.FindStringSubmatch(line)
				if len(matches) > 1 {
					declaredSymbols[matches[1]] = true
				}
			}
		}
	}

	// Builtin globals and DOM keywords
	builtins := map[string]bool{
		"this": true, "event": true, "console": true, "alert": true, "confirm": true,
		"prompt": true, "setTimeout": true, "clearTimeout": true, "parseInt": true,
		"parseFloat": true, "encodeURIComponent": true, "decodeURIComponent": true,
		"escapeHtml": true, "String": true, "Number": true, "Boolean": true,
		"Math": true, "JSON": true, "Date": true, "Array": true, "Object": true,
		"preventDefault": true, "stopPropagation": true, "if": true, "for": true,
		"while": true, "switch": true, "return": true, "typeof": true, "window": true,
		"document": true, "localStorage": true, "history": true, "navigator": true,
		"undefined": true, "null": true, "true": true, "false": true,
		"classList": true, "toggle": true, "add": true, "remove": true, "contains": true,
	}

	attrRegex := regexp.MustCompile(`\bon[a-zA-Z]+\s*=\s*(?:\\?["'])([^"'\\]+(?:\\.[^"'\\]*)*)(?:\\?["'])`)
	callRegex := regexp.MustCompile(`(?:^|[^a-zA-Z0-9_$.])(?:window\.)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(`)

	scanForCalls := func(filePath string, text string) {
		lines := strings.Split(text, "\n")
		for lineIdx, line := range lines {
			matches := attrRegex.FindAllStringSubmatch(line, -1)
			for _, m := range matches {
				attrVal := m[1]
				attrVal = strings.ReplaceAll(attrVal, `\"`, `"`)
				attrVal = strings.ReplaceAll(attrVal, `\'`, `'`)

				calls := callRegex.FindAllStringSubmatch(attrVal, -1)
				for _, c := range calls {
					fnName := c[1]
					if builtins[fnName] {
						continue
					}
					if !declaredSymbols[fnName] {
						errs = append(errs, ValidationError{
							File:    filePath,
							Line:    lineIdx + 1,
							Col:     1,
							Message: fmt.Sprintf("Event handler calls undefined function '%s()' (handler: %q)", fnName, attrVal),
						})
					}
				}
			}
		}
	}

	scanForCalls("pkg/ui/src/index.html", htmlContent)
	for name, content := range jsFilesContent {
		scanForCalls(name, content)
	}

	return errs
}

// ValidateEntireUI performs all syntax and reference checks on the UI source tree.
func ValidateEntireUI(srcDir string) []ValidationError {
	var allErrs []ValidationError

	// 1. Read index.html
	htmlBytes, err := os.ReadFile(filepath.Join(srcDir, "index.html"))
	if err != nil {
		return []ValidationError{{File: "index.html", Message: err.Error()}}
	}

	// 2. Read and validate all JS files
	jsFiles := []string{
		"state.js",
		"titlebar.js",
		"sidebar.js",
		"settings.js",
		"history.js",
		"chat.js",
		"approvals.js",
		"app.js",
	}

	jsContents := make(map[string]string)
	for _, f := range jsFiles {
		p := filepath.Join(srcDir, "js", f)
		bytes, err := os.ReadFile(p)
		if err != nil {
			allErrs = append(allErrs, ValidationError{File: f, Message: err.Error()})
			continue
		}
		jsContents[f] = string(bytes)

		// Check JS syntax, braces, strings, try/catch
		fileErrs := ValidateJSSyntax(f, bytes)
		allErrs = append(allErrs, fileErrs...)
	}

	// 3. Check handler references
	handlerErrs := ValidateHandlers(string(htmlBytes), jsContents)
	allErrs = append(allErrs, handlerErrs...)

	// 4. Check that all direct function calls resolve to declared functions or builtins
	callErrs := ValidateFunctionCalls(jsContents)
	allErrs = append(allErrs, callErrs...)

	return allErrs
}

// ValidateFunctionCalls verifies that all standalone function calls foo(...) point to defined symbols or JS builtins.
func ValidateFunctionCalls(jsFilesContent map[string]string) []ValidationError {
	var errs []ValidationError

	declared := make(map[string]bool)
	declRegexes := []*regexp.Regexp{
		regexp.MustCompile(`(?m)^[ \t]*(?:async[ \t]+)?function[ \t]+([a-zA-Z0-9_$]+)[ \t]*\(`),
		regexp.MustCompile(`(?m)^[ \t]*(?:window\.)([a-zA-Z0-9_$]+)[ \t]*=[ \t]*(?:async[ \t]*)?(?:function|\([^)]*\)[ \t]*=>)`),
		regexp.MustCompile(`(?m)^[ \t]*(?:const|let|var)[ \t]+([a-zA-Z0-9_$]+)[ \t]*=[ \t]*(?:async[ \t]*)?(?:function|\([^)]*\)[ \t]*=>)`),
		regexp.MustCompile(`(?m)^[ \t]*(?:window\.)([a-zA-Z0-9_$]+)[ \t]*=`),
		regexp.MustCompile(`(?m)^[ \t]*(?:var|let|const)[ \t]+([a-zA-Z0-9_$]+)[ \t]*=`),
	}

	for _, content := range jsFilesContent {
		for _, re := range declRegexes {
			matches := re.FindAllStringSubmatch(content, -1)
			for _, m := range matches {
				if len(m) > 1 {
					declared[m[1]] = true
				}
			}
		}
	}

	builtins := map[string]bool{
		"this": true, "event": true, "console": true, "alert": true, "confirm": true,
		"prompt": true, "setTimeout": true, "clearTimeout": true, "setInterval": true, "clearInterval": true,
		"parseInt": true, "parseFloat": true, "isNaN": true, "isFinite": true,
		"encodeURIComponent": true, "decodeURIComponent": true, "btoa": true, "atob": true,
		"String": true, "Number": true, "Boolean": true, "Math": true, "JSON": true,
		"Date": true, "Array": true, "Object": true, "Promise": true, "RegExp": true,
		"Error": true, "TypeError": true, "Map": true, "Set": true, "Symbol": true,
		"fetch": true, "requestAnimationFrame": true, "cancelAnimationFrame": true,
		"structuredClone": true, "CustomEvent": true, "Event": true, "MutationObserver": true,
		"FileReader": true, "Blob": true, "URL": true, "FormData": true, "Headers": true,
		"Request": true, "Response": true, "AbortController": true, "crypto": true,
		"typeof": true, "void": true, "delete": true, "super": true, "import": true,
		"if": true, "for": true, "while": true, "switch": true, "catch": true, "async": true,
		"eval": true, "unescape": true, "escape": true,
	}

	for fName, content := range jsFilesContent {
		tokens, _ := tokenizeJS(fName, []byte(content))
		for i := 0; i < len(tokens)-1; i++ {
			if tokens[i].Type == tokIdent && tokens[i+1].Type == tokLParen {
				if i > 0 && tokens[i-1].Type == tokDot {
					continue
				}
				fn := tokens[i].Val
				if builtins[fn] || declared[fn] {
					continue
				}
				errs = append(errs, ValidationError{
					File:    fName,
					Line:    tokens[i].Line,
					Col:     tokens[i].Col,
					Message: fmt.Sprintf("Call to undefined function '%s()'", fn),
				})
			}
		}
	}

	return errs
}
