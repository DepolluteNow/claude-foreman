-- select_model.scpt
-- Usage: osascript select_model.scpt <bundle_id> <model_name>
-- Selects a model in Windsurf/Antigravity/Cursor Cascade panel

on run argv
    set bundleID to item 1 of argv
    set modelName to item 2 of argv

    tell application "System Events"
        tell (first process whose bundle identifier is bundleID)
            set frontmost to true
            delay 0.3

            -- The model selector in Cascade is typically a dropdown at the top
            -- We use the Command Palette approach: search for "model" settings
            -- This is more reliable than trying to click UI elements directly

            -- Method: Use the model selector button in Cascade panel
            -- Windsurf/Antigravity: Click the model name text in Cascade header
            -- Then type to filter and press Enter

            -- Open command palette
            keystroke "p" using {command down, shift down}
            delay 0.5

            -- Type the model change command
            set the clipboard to ">Change Model"
            keystroke "v" using command down
            delay 0.5
            key code 36 -- Enter
            delay 0.5

            -- Type the model name to filter the list
            set the clipboard to modelName
            keystroke "v" using command down
            delay 0.3
            key code 36 -- Enter

        end tell
    end tell

    return "model_selected: " & modelName
end run
