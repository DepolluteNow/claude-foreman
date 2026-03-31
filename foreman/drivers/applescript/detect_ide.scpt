-- Detects which VS Code fork IDE is running
-- Uses bundle identifiers (process names are all "Electron")
-- Returns: "Windsurf", "Antigravity", "Cursor", "none"

on run
    tell application "System Events"
        set bundleIDs to bundle identifier of every process
        if bundleIDs contains "com.exafunction.windsurf" then
            return "Windsurf"
        else if bundleIDs contains "com.google.antigravity" then
            return "Antigravity"
        else if bundleIDs contains "com.todesktop.230313mzl4w4u92" then
            return "Cursor"
        else
            return "none"
        end if
    end tell
end run
