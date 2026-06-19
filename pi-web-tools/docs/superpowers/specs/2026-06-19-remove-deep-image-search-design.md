# Remove deep_search and image_search tools

**Date:** 2026-06-19
**Status:** approved

## Summary

Remove `deep_search` and `image_search` tools from pi-web-tools, along with all Aliyun-related infrastructure code that was exclusively used by these two tools. The remaining tools are `web_search` and `web_fetch`.

## Scope

### Files to delete (10 files)

| File | Reason |
|------|--------|
| `src/deep_search/aliyun.ts` | core deep_search implementation |
| `src/deep_search/index.ts` | deep_search re-export |
| `src/deep_search/types.ts` | deep_search types |
| `src/image_search/aliyun.ts` | core image_search implementation |
| `src/image_search/index.ts` | image_search re-export |
| `src/image_search/types.ts` | image_search types |
| `tests/deep_search.test.ts` | deep_search tests |
| `tests/image_search.test.ts` | image_search tests |
| `tests/provider.test.ts` | Aliyun provider resolution tests |
| `src/provider.ts` | Aliyun API key/provider resolution (only used by deep/image search) |
| `src/openai_client.ts` | OpenAI SDK client factory (only used by deep/image search) |

### Files to modify (7 files)

| File | Change |
|------|--------|
| `index.ts` | Remove `deepSearch` and `imageSearch` imports, remove both `pi.registerTool({...})` blocks, remove unused `ExtensionContext` and `loadConfig` imports |
| `src/config.ts` | Remove `deepSearchModel` and `imageSearchModel` fields from `WebToolsConfig` interface |
| `package.json` | Update description to "pi package providing web_search and web_fetch tools", remove `openai` dependency |
| `README.md` | Remove `deep_search` and `image_search` rows from tool table and parameter documentation |
| `README-zh.md` | Same as README.md |
| `docs/superpowers/specs/2026-06-18-pi-web-tools-design.md` | 在文件顶部添加废弃标注，说明 `deep_search` 和 `image_search` 已于 2026-06-19 移除，对应章节不再有效 |
| `docs/superpowers/specs/2026-06-19-deep-image-search-config-split-design.md` | 在文件顶部添加废弃标注，说明 `deep_search` 和 `image_search` 已于 2026-06-19 移除，整篇 spec 不再有效 |

### Historical spec annotation

Two existing spec files reference `deep_search` and `image_search`. Each will get an obsoletion notice prepended:

```markdown
> **OBSOLETED 2026-06-19:** `deep_search` and `image_search` tools have been removed from pi-web-tools.
> The sections below referencing these tools are no longer valid and are kept for historical reference only.
```

## Verification

- `npm run typecheck` — must pass with no errors
- `npm run lint` — no new warnings
- `npm run test` — remaining tests (web_search) must pass
