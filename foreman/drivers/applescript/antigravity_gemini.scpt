-- Interacts with Antigravity's Gemini AI panel
-- Same action interface as windsurf_cascade.scpt

on run argv
    set action to item 1 of argv

    tell application "System Events"
        tell process "Antigravity"
            set frontmost to true
            delay 0.3

            if action is "send" then
                set prompt to item 2 of argv
                -- Open Gemini panel (Ctrl+Shift+Space or similar)
                keystroke " " using {control down, shift down}
                delay 0.5
                keystroke "a" using command down
                delay 0.1
                keystroke prompt
                delay 0.2
                key code 36
                return "sent"

            else if action is "status" then
                try
                    set stopButtons to every button of every group of every group of window 1 whose description contains "Stop"
                    if (count of stopButtons) > 0 then
                        return "generating"
                    end if
                end try
                return "idle"

            else if action is "read" then
                keystroke " " using {control down, shift down}
                delay 0.3
                keystroke "a" using command down
                delay 0.1
                keystroke "c" using command down
                delay 0.2
                return (the clipboard)

            else if action is "accept" then
                try
                    click button "Accept All" of window 1
                    return "accepted"
                on error
                    keystroke "y" using {command down, shift down}
                    return "accepted_via_shortcut"
                end try

            else if action is "reject" then
                try
                    click button "Reject" of window 1
                    return "rejected"
                on error
                    keystroke "n" using {command down, shift down}
                    return "rejected_via_shortcut"
                end try

            else if action is "recalibrate" then
                set uiElements to entire contents of window 1
                return uiElements as text
            end if

        end tell
    end tell
end run
