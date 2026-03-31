-- Interacts with Windsurf's Cascade AI panel
-- Usage: osascript windsurf_cascade.scpt <action> [args...]
-- Actions: send, status, read, accept, reject, recalibrate

on run argv
    set action to item 1 of argv
    set result to "unknown"

    tell application "System Events"
        tell (first process whose bundle identifier is "com.exafunction.windsurf")
            set frontmost to true
            delay 0.3

            if action is "send" then
                set prompt to item 2 of argv
                -- Save current clipboard, use it to paste (faster than keystroke)
                set the clipboard to prompt
                -- Focus the Cascade input area (Cmd+L opens Cascade)
                keystroke "l" using command down
                delay 0.5
                -- Clear any existing text
                keystroke "a" using command down
                delay 0.1
                -- Paste the prompt from clipboard
                keystroke "v" using command down
                delay 0.3
                -- Press Enter to send
                key code 36 -- Return
                return "sent"

            else if action is "status" then
                -- Check if the stop button is visible (means generating)
                try
                    set stopButtons to every button of every group of every group of window 1 whose description contains "Stop"
                    if (count of stopButtons) > 0 then
                        return "generating"
                    end if
                end try
                return "idle"

            else if action is "read" then
                -- Read from the Cascade output panel via clipboard
                keystroke "l" using command down
                delay 0.3
                keystroke "a" using command down
                delay 0.1
                keystroke "c" using command down
                delay 0.2
                return (the clipboard)

            else if action is "accept" then
                -- Click Accept All button
                try
                    click button "Accept All" of window 1
                    return "accepted"
                on error
                    -- Try keyboard shortcut
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
                -- Dump accessibility tree for debugging
                set uiElements to entire contents of window 1
                return uiElements as text
            end if

        end tell
    end tell
end run
