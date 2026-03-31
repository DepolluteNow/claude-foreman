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
                -- mode: "continue" uses existing Cascade (Shift+Cmd+C)
                --        "new" creates fresh Cascade window (Shift+Cmd+I)
                set mode to "continue"
                if (count of argv) > 2 then
                    set mode to item 3 of argv
                end if

                -- Save current clipboard, use it to paste (faster than keystroke)
                set the clipboard to prompt

                if mode is "new" then
                    -- Shift+Cmd+I = new Cascade window
                    keystroke "i" using {command down, shift down}
                else
                    -- Shift+Cmd+C = continue in existing Cascade
                    keystroke "c" using {command down, shift down}
                end if
                delay 0.8
                -- Clear any existing text in the input
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
                -- Screenshot approach: Cascade is in an Electron WebView
                -- that AppleScript can't read directly. Take a screenshot
                -- for the supervisor (Claude) to read visually.
                do shell script "screencapture -C -x /tmp/windsurf_cascade.png"
                return "/tmp/windsurf_cascade.png"

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
