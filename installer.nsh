; Custom NSIS hooks for the Dovakarn Launcher installer.
;
; Refuse to install/update while the launcher is running, otherwise its files
; are locked and the update silently half-applies. nsProcess ships with
; electron-builder's bundled NSIS, so no extra plugin install is needed.

!macro customInit
  ${If} ${Silent}
    ; In-app auto-update (/S): the launcher is quitting itself. Wait up to ~10s
    ; for it to release its files, then proceed without any prompt.
    StrCpy $R1 0
    silent_wait:
      nsProcess::_FindProcess "${PRODUCT_FILENAME}.exe"
      Pop $R0
      nsProcess::_Unload
      ${If} $R0 == 0
        IntOp $R1 $R1 + 1
        ${If} $R1 < 20
          Sleep 500
          Goto silent_wait
        ${EndIf}
      ${EndIf}
  ${Else}
    ; Manual run: ask the user to close a running launcher before continuing.
    retry_running_check:
      nsProcess::_FindProcess "${PRODUCT_FILENAME}.exe"
      Pop $R0
      ${If} $R0 == 0
        nsProcess::_Unload
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
          "The Dovakarn Launcher is still running.$\n$\nPlease fully quit it (check the system tray), then click Retry." \
          IDRETRY retry_running_check
        Abort
      ${EndIf}
      nsProcess::_Unload
  ${EndIf}
!macroend

; Uninstalling for good (never during an update, never silently): offer to delete Dovakarn's own game, which the
; launcher records in HKCU\Software\Dovakarn InstallDir (gameSetup.js). Only its Game and Downloads folders go, then the
; folder itself if that left it empty, as the launcher's own Remove does. The player's own Skyrim is never touched.
; A finished game has its marker; one whose setup stopped partway is offered too when the folder is named Dovakarn (the
; launcher only ever picks a folder that is, or one already holding a finished game).
!macro customUnInstall
  ${IfNot} ${isUpdated}
  ${AndIfNot} ${Silent}
    ReadRegStr $R0 HKCU "Software\Dovakarn" "InstallDir"
    StrCpy $R1 $R0 "" -9
    ${If} ${FileExists} "$R0\Game\Dovakarn game copy.json"
    ${OrIf} $R1 == "\Dovakarn"
    ${AndIf} $R0 != ""
    ${AndIf} ${FileExists} "$R0\Game\*.*"
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
        "Also delete Dovakarn's game in $R0?$\n$\nThat is its own copy of Skyrim and the mods' downloads, about 16 GB. Your own Skyrim stays as it is, and your characters live on the server." \
        IDNO keep_game
      RMDir /r "$R0\Game"
      RMDir /r "$R0\Downloads"
      RMDir "$R0"
      DeleteRegValue HKCU "Software\Dovakarn" "InstallDir"
      keep_game:
    ${EndIf}
  ${EndIf}
!macroend
