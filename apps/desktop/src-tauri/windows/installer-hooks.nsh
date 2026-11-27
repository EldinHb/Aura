; Aura's NSIS installer hooks (tauri.conf.json: bundle.windows.nsis.installerHooks).
;
; The installer only checks Aura's main executable before it copies the files,
; but aurad.exe (the daemon) and aura.exe (the command line) ship next to it,
; and Windows will not overwrite a running .exe: the install would stop half
; way. The app stops the daemon before it updates, and nothing starts it again
; while the update lock is held; this is the installer's own guard, for an
; install started by hand, or anything still running regardless: Restart
; Manager closes whatever runs these two files. Sessions keep their state and
; resume on the next daemon.
;
; Restart Manager closes every process that holds one of these files, not
; only processes running them: a program that has aurad.exe or aura.exe open
; (an antivirus scan, an editor, a backup) is closed too. Picking out only the
; processes whose image is one of these files is not practical from NSIS. For
; updates Aura starts itself, the update helper first stops exactly the
; processes running these two files (by image path), so this guard finds
; nothing left to close.
;
; Tauri's template includes this after Win\RestartManager.nsh (and LogicLib).

!macro AURA_CLOSE_SIDECARS
  DetailPrint "Closing Aura's daemon and command line if they run"
  !insertmacro RestartManager_ShutdownFile "$INSTDIR\aurad.exe" $R8
  !insertmacro RestartManager_ShutdownFile "$INSTDIR\aura.exe" $R9
  ${If} $R8 <> 0
  ${OrIf} $R9 <> 0
    Abort "Aura's daemon (aurad.exe) or command line (aura.exe) is still running and could not be closed (error $R8, $R9). Run 'aura daemon stop', close any aura command, and start the installer again."
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro AURA_CLOSE_SIDECARS
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro AURA_CLOSE_SIDECARS
!macroend
