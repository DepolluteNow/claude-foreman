-- Detects which VS Code fork IDE is running
-- Returns: "Windsurf", "Antigravity", "none"

on run
    tell application "System Events"
        set runningApps to name of every process
        if runningApps contains "Windsurf" then
            return "Windsurf"
        else if runningApps contains "Antigravity" then
            return "Antigravity"
        else
            return "none"
        end if
    end tell
end run
