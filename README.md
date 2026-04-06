# Planner Extension

A plan mode extension for pi that applies configurable tool restrictions, helping you think through implementation before coding.

## Commands

- `/planner` - Toggle plan mode on/off
- `/planner on` - Enable plan mode
- `/planner off` - Disable plan mode
- `/planner status` - Check current plan mode status
- `/planner_execute` - Exit plan mode with confirmation dialog and resume implementation
- `Ctrl+Space` - Toggle plan mode

## Settings

Configure the planner extension in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "planner": {
    "enabled": true,
    "defaultMode": "plan",
    "showPlanModePrefix": true,
    "whitelistedCommands": ["cat", "ls", "grep", "rg", "find", "head", "tail", "wc", "pwd", "echo", "printf", "git", "file", "stat", "du", "df", "which", "type", "env", "printenv", "uname", "whoami", "date"],
    "blockedTools": ["write", "edit"],
    "planModelProvider": "google",
    "planModelId": "gemini-2.5-flash",
    "planThinkingLevel": "minimal",
    "clarificationOptions": [
      "Unclear requirements or scope",
      "Missing technical details",
      "Edge cases to consider",
      "Dependencies or prerequisites",
      "Other concerns"
    ],
    "systemPromptAdditions": ""
  }
}
```

### Settings Reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the planner extension |
| `defaultMode` | string | `"plan"` | Default mode on startup: `"plan"` or `"implement"` |
| `showPlanModePrefix` | boolean | `true` | Prepend `[PLAN MODE ACTIVE]` to user messages |
| `systemPrompt` | string \| null | `null` | Override entire system prompt (null = use defaults + additions) |
| `systemPromptAdditions` | string | `""` | Append to default system prompt (ignored if systemPrompt is set) |
| `whitelistedCommands` | string[] | (see above) | Bash commands allowed in plan mode |
| `blockedTools` | string[] | `["write", "edit"]` | Tools blocked in plan mode |
| `planModelProvider` | string \| null | `null` | Provider to switch to when plan mode is enabled |
| `planModelId` | string \| null | `null` | Model ID to switch to when plan mode is enabled |
| `planThinkingLevel` | string \| null | `null` | Thinking level to apply in plan mode |
| `clarificationOptions` | string[] | (see above) | Options shown when user declines execution |

If `planModelProvider`, `planModelId`, or `planThinkingLevel` are not set, plan mode keeps using the current session model/thinking. If you change the model or thinking level while plan mode is active, that becomes the session's plan-mode override. Exiting plan mode restores the model and thinking level that were active before plan mode was enabled.

## Tools

- `planner_ask` - Ask structured questions to the user
- `planner_execute` - Exit plan mode and resume implementation (for LLM to call)
