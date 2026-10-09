package uivalidate

import (
	"testing"
)

func TestValidateJSSyntax_CatchWithoutTry(t *testing.T) {
	badCode := []byte(`
function test() {
  const a = 1;
  } catch (err) {
    console.error(err);
  }
}
`)
	errs := ValidateJSSyntax("bad.js", badCode)
	if len(errs) == 0 {
		t.Fatalf("Expected error for catch without try, got none")
	}
	found := false
	for _, e := range errs {
		if e.Message != "" {
			found = true
			t.Logf("Detected: %s", e)
		}
	}
	if !found {
		t.Fatalf("Did not find expected catch error")
	}
}

func TestValidateJSSyntax_UnclosedBacktick(t *testing.T) {
	badCode := []byte("const msg = `hello world;\nconsole.log(msg);")
	errs := ValidateJSSyntax("bad_backtick.js", badCode)
	if len(errs) == 0 {
		t.Fatalf("Expected error for unclosed backtick, got none")
	}
	t.Logf("Detected: %s", errs[0])
}

func TestValidateHandlers_UndefinedFunction(t *testing.T) {
	html := `<button onclick="nonExistentFunction(123)">Click</button>`
	js := map[string]string{
		"test.js": `function existingFunction() {}`,
	}
	errs := ValidateHandlers(html, js)
	if len(errs) == 0 {
		t.Fatalf("Expected error for undefined function in onclick, got none")
	}
	t.Logf("Detected: %s", errs[0])
}

func TestValidateEntireUI_CurrentCodebase(t *testing.T) {
	errs := ValidateEntireUI("../../pkg/ui/src")
	if len(errs) > 0 {
		for _, e := range errs {
			t.Errorf("Validation error in actual UI: %s", e)
		}
	}
}

func TestValidateFunctionCalls_UndefinedFunction(t *testing.T) {
	js := map[string]string{
		"test.js": `
function doSomething() {
  callNonExistentFunction(42);
}
`,
	}
	errs := ValidateFunctionCalls(js)
	if len(errs) == 0 {
		t.Fatalf("Expected error for callNonExistentFunction, got none")
	}
	t.Logf("Successfully caught undefined function call: %s", errs[0])
}
