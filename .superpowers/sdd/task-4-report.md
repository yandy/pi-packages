# Task 4 Report: ast-grep 搜索执行 + JSON 解析 + 输出格式化

## 实现内容

- `pi-coding-tools/src/ast-grep/search.ts` — `parseSgStdout`, `runAstGrep`, `inferLangFromPath`
- `pi-coding-tools/src/formatters.ts` — `formatSearchResult`
- `pi-coding-tools/tests/ast-grep/search.test.ts` — 3 tests for `parseSgStdout`
- `pi-coding-tools/tests/formatters.test.ts` — 4 tests for `formatSearchResult`

## TDD 证据

### RED — search.test.ts
```
npm test --workspace pi-coding-tools -- search.test
→ FAIL: Cannot find module '../../src/ast-grep/search'
```

### GREEN — search.test.ts
```
npm test --workspace pi-coding-tools -- search.test
→ ✓ tests/ast-grep/search.test.ts (3 tests) 2ms
```

### RED — formatters.test.ts
```
npm test --workspace pi-coding-tools -- formatters.test
→ FAIL: Cannot find module '../src/formatters'
```

### GREEN — formatters.test.ts (initial run: 3/4 pass)
First run had `formatSearchResult` test failure (expected `src/index.ts:11:3` inline, but formatter put file on separate line). Fixed per-match format to include `m.file:loc` prefix.

```
npm test --workspace pi-coding-tools -- formatters.test
→ ✓ tests/formatters.test.ts (4 tests) 1ms
```

### All tests
```
npm test --workspace pi-coding-tools
→ 5 test files, 22 tests passed
```

## Self-Review

| Check | Status |
|-------|--------|
| parseSgStdout: 3 cases (valid array, blank stdout, invalid json) | PASS |
| formatSearchResult: 4 cases (formats matches, groups by file, no matches, error) | PASS |
| search.ts exports parseSgStdout, runAstGrep, inferLangFromPath | PASS |
| formatters.ts exports formatSearchResult | PASS |
| TAB indentation, no `any` | PASS |
| tsc --noEmit | PASS (clean) |
| biome check | PASS (only pre-existing warnings in search-tools.test.ts) |
| Only 4 files created | PASS |

## Concerns

- Format adjustment needed: per-match line changed from `  ${loc}  ${lines}` to `  ${file}:${loc}  ${lines}` to match test expectation of inline file:loc format.
- No other concerns.
