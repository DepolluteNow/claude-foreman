# Foreman Dispatch Playbook — Token-Efficient Workflow

## Goal: Minimize Claude tokens per dispatch cycle

### Phase 1: Dispatch (1 tool call)
```bash
osascript -e 'tell application "System Events"
    tell (first process whose bundle identifier is "BUNDLE_ID")
        set frontmost to true; delay 0.5
        set the clipboard to "PROMPT"
        keystroke "c" using {command down, shift down}
        delay 0.8; keystroke "a" using command down; delay 0.1
        keystroke "v" using command down; delay 0.3; key code 36
    end tell
end tell'
```

### Phase 2: Wait (1 tool call — NOT multiple polls)
```bash
# Smart wait: poll git for a commit touching expected paths
END=$((SECONDS+300))  # 5 min timeout
while [ $SECONDS -lt $END ]; do
    if git log --oneline -1 --since="5 minutes ago" | grep -q "EXPECTED_PATTERN"; then
        echo "DONE"; break
    fi
    sleep 20
done
```

**Anti-pattern:** Multiple `sleep N && curl` calls. Each costs ~300-400 tokens.

### Phase 3: Verify (2 tool calls max)
```bash
# Call 1: diff + compile
git diff HEAD~1 --stat && cd extension/foreman-bridge && npm run compile 2>&1

# Call 2 (only if extension changed): rebuild + install + reload
npx @vscode/vsce package && \
/Applications/Windsurf.app/.../windsurf --install-extension *.vsix --force && \
osascript -e '...reload window...'
```

### Phase 4: Test (1 tool call)
```bash
# Confirm version first, then test endpoints in one shot
curl -s http://127.0.0.1:PORT/status && \
curl -s http://127.0.0.1:PORT/health && \
curl -s http://127.0.0.1:PORT/git
```

### Token Budget Targets
| Phase | Target | Max Tool Calls |
|-------|--------|---------------|
| Dispatch | ~300 tokens | 1 |
| Wait | ~400 tokens | 1 |
| Verify | ~600 tokens | 2 |
| Test | ~300 tokens | 1 |
| **Total** | **~1,600** | **5** |

### Rules
1. **Never poll more than once** — use a loop in a single Bash call
2. **Never read full files** — use `git diff HEAD~1` instead
3. **Always verify version before testing endpoints** — `curl /status` must show expected version
4. **Batch sequential commands** with `&&` — don't use separate tool calls
5. **If extension changed** — always rebuild → install → reload → verify version → test
6. **Skip monitoring entirely for simple file-only tasks** — just wait for the commit

### Cost Comparison
| Approach | Tool Calls | Est. Tokens |
|----------|-----------|-------------|
| Naive (this session) | 14 | ~5,000 |
| Optimized (playbook) | 5 | ~1,600 |
| **Savings** | **64%** | **68%** |
