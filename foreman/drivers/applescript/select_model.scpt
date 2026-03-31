-- select_model.scpt
-- Usage: osascript select_model.scpt <bundle_id> <model_name>
-- Selects a model in Windsurf/Antigravity/Cursor Cascade panel
--
-- Uses the Command Palette command "Cascade: Switch AI Provider/Model..."
-- Discovered via Command Palette search ">Switch AI Provider"
-- Tested and confirmed working in Windsurf 2026-03-31

on run argv
    set bundleID to item 1 of argv
    set modelName to item 2 of argv

    tell application "System Events"
        tell (first process whose bundle identifier is bundleID)
            set frontmost to true
            delay 0.5

            -- Open command palette
            keystroke "p" using {command down, shift down}
            delay 0.8

            -- Type the model switch command
            set the clipboard to ">Switch AI Provider"
            keystroke "v" using command down
            delay 0.8

            -- Select the command (opens model picker)
            key code 36 -- Enter
            delay 1.0

            -- Type the model name to filter the picker list
            set the clipboard to modelName
            keystroke "v" using command down
            delay 0.5

            -- Select the filtered model
            key code 36 -- Enter

        end tell
    end tell

    return "model_selected: " & modelName
end run
