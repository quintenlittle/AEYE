; ============================================================================
;  AEYE -- Inno Setup script  (GUI installer, black/green, animated skull)
;
;  Built by build.py, which passes the version and the frozen-app source dir:
;     ISCC /DAppVersion=1.2.3 /DAppSrc="..\dist\AEYE" installer\aeye.iss
;  Requires Inno Setup 6.1+ (CreateCallback, used for the skull animation).
; ============================================================================

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef AppSrc
  #define AppSrc "..\dist\AEYE"
#endif

#define AppName    "AEYE"
#define AppPublisher "AEYE"
#define AppExe     "AEYE.exe"
; stable AppId => in-place upgrades land in the same folder & registry entry
#define AppId      "{{6E5A9C2E-7F44-4B2A-9E31-AE1E0F0C51A0}"

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
VersionInfoVersion={#AppVersion}
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
OutputDir=..\dist
OutputBaseFilename=aeye-setup-v{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; bigger wizard (max supported) so the whole skull fits on the Installing page
WizardSizePercent=150
PrivilegesRequired=admin
; the per-user voice pre-seed + optional data purge intentionally touch
; {userappdata}; each user's own first run also builds their AppData tree
UsedUserAreasWarning=no
ArchitecturesInstallIn64BitMode=x64compatible
SetupIconFile=..\assets\AEYE.ico
#if FileExists(AddBackslash(SourcePath) + "..\assets\wizard-large.bmp")
WizardImageFile=..\assets\wizard-large.bmp
#endif
#if FileExists(AddBackslash(SourcePath) + "..\assets\wizard-small.bmp")
WizardSmallImageFile=..\assets\wizard-small.bmp
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "full";    Description: "Full installation (recommended)"
Name: "compact"; Description: "Core application only"
Name: "custom";  Description: "Custom installation"; Flags: iscustom

[Components]
Name: "core";        Description: "AEYE core application";                              Types: full compact custom; Flags: fixed
Name: "voice";       Description: "Piper neural TTS + default offline voice";           Types: full
Name: "ollama";      Description: "Ollama local model runtime + default chat model";    Types: full
Name: "extras";      Description: "AI extras (PyTorch / transformers / diffusers / Whisper / RAG)"; Types: full
Name: "extras\hf";    Description: "HuggingFace transformers models";  Types: full
Name: "extras\image"; Description: "Image generation (diffusers)";     Types: full
Name: "extras\video"; Description: "Video generation";                 Types: full
Name: "extras\stt";   Description: "Speech-to-text (Whisper)";         Types: full
Name: "extras\rag";   Description: "Document memory (RAG)";            Types: full

[Tasks]
Name: "desktopicon"; Description: "Create a &Desktop shortcut"; GroupDescription: "Additional shortcuts:"
Name: "relayautostart"; Description: "Start the local board-ticker relay at login (background, hidden -- needs Python)"; GroupDescription: "Board tickers:"; Flags: unchecked

[Dirs]
; make sure the per-user data tree exists; never removed on uninstall (user data)
Name: "{userappdata}\AEYE";          Flags: uninsneveruninstall
Name: "{userappdata}\AEYE\relay";    Flags: uninsneveruninstall
Name: "{userappdata}\AEYE\plugins";  Flags: uninsneveruninstall

[Files]
; --- the frozen core app (whole PyInstaller onedir tree) ---
Source: "{#AppSrc}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion; Components: core
; --- the icon at {app} root so the shortcuts' IconFilename resolves ---
Source: "..\AEYE.ico"; DestDir: "{app}"; Flags: ignoreversion; Components: core
; --- README shipped at {app} root, out of the box ---
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist; Components: core
; --- requirements + extras tooling (needed to build the sidecar venv later) ---
Source: "..\requirements*.txt"; DestDir: "{app}"; Flags: ignoreversion; Components: core
Source: "..\pybuild.txt"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist; Components: core
Source: "..\tools\install_extras.py"; DestDir: "{app}\tools"; Flags: ignoreversion; Components: core
Source: "..\tools\install-extras.bat"; DestDir: "{app}\tools"; Flags: ignoreversion; Components: core
Source: "..\tools\setup_ollama.bat";  DestDir: "{app}\tools"; Flags: ignoreversion; Components: core
; --- relay login-task helpers (enable/disable the background relay) ---
Source: "..\tools\register-relay-task.bat";   DestDir: "{app}\tools"; Flags: ignoreversion skipifsourcedoesntexist; Components: core
Source: "..\tools\unregister-relay-task.bat"; DestDir: "{app}\tools"; Flags: ignoreversion skipifsourcedoesntexist; Components: core
; --- board-ticker relay script -> per-user data folder (bundled; never clobbers a user copy) ---
Source: "..\aeye-4chan-relay.py"; DestDir: "{userappdata}\AEYE\relay"; Flags: onlyifdoesntexist uninsneveruninstall skipifsourcedoesntexist; Components: core
; --- bundled RSS reader plugin -> per-user plugins (never clobbers a user copy) ---
Source: "..\plugins\rss\*"; DestDir: "{userappdata}\AEYE\plugins\rss"; Flags: recursesubdirs createallsubdirs onlyifdoesntexist uninsneveruninstall skipifsourcedoesntexist; Components: core
; --- WebView2 offline bootstrapper: copied to {tmp} only if the runtime is absent ---
Source: "..\assets\MicrosoftEdgeWebview2Setup.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall skipifsourcedoesntexist; Check: NeedsWebView2
; --- default Piper voice: pre-seed the per-user HF cache so TTS works offline OOTB ---
#if DirExists(AddBackslash(SourcePath) + "..\assets\hf-cache")
Source: "..\assets\hf-cache\*"; DestDir: "{userappdata}\AEYE\hf-cache"; Flags: recursesubdirs createallsubdirs ignoreversion; Components: voice
#endif
; --- skull animation frames (loaded at runtime by the wizard, not installed) ---
Source: "..\assets\skull_frames\jaw0.txt"; Flags: dontcopy skipifsourcedoesntexist
Source: "..\assets\skull_frames\jaw1.txt"; Flags: dontcopy skipifsourcedoesntexist
Source: "..\assets\skull_frames\jaw2.txt"; Flags: dontcopy skipifsourcedoesntexist
Source: "..\skull.txt"; Flags: dontcopy skipifsourcedoesntexist

[Icons]
Name: "{group}\{#AppName}";                     Filename: "{app}\{#AppExe}"; IconFilename: "{app}\AEYE.ico"
Name: "{group}\Install or Repair AI Extras";    Filename: "{app}\tools\install-extras.bat"; IconFilename: "{app}\AEYE.ico"
Name: "{group}\Set up Ollama + default model";  Filename: "{app}\tools\setup_ollama.bat";   IconFilename: "{app}\AEYE.ico"
Name: "{group}\AEYE README";                    Filename: "{app}\README.md"
Name: "{group}\Board relay - enable autostart";  Filename: "{app}\tools\register-relay-task.bat";   IconFilename: "{app}\AEYE.ico"
Name: "{group}\Board relay - disable autostart"; Filename: "{app}\tools\unregister-relay-task.bat"; IconFilename: "{app}\AEYE.ico"
Name: "{group}\Uninstall {#AppName}";           Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}";               Filename: "{app}\{#AppExe}"; IconFilename: "{app}\AEYE.ico"; Tasks: desktopicon

[Run]
; Everything below runs DURING the Installing page (the animated-skull screen),
; each waited-on, so the skull stays up until the whole install -- including
; these console windows -- is 100% done. Only "Launch AEYE" is a finish action.
;
; WebView2 first (the app can't render without it) -- only when missing
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft WebView2 runtime..."; Flags: waituntilterminated; Check: NeedsWebView2
; Ollama + default model (own console, real user, ~4 GB pull)
Filename: "{app}\tools\setup_ollama.bat"; Parameters: "auto"; StatusMsg: "Setting up Ollama + pulling the default chat model (~4 GB)..."; Flags: shellexec waituntilterminated runasoriginaluser; Components: ollama
; AI extras (own console so a Python-version prompt is answerable, real user so
; the venv lands in that user's %APPDATA%, several-GB download)
Filename: "{app}\tools\install-extras.bat"; Parameters: "{code:ExtrasParams}"; StatusMsg: "Installing AI extras (PyTorch / RAG / Whisper) -- several GB, please wait..."; Flags: shellexec waituntilterminated runasoriginaluser; Components: extras
; register the local relay to start at login -- only if the user opted in.
; runasoriginaluser so %APPDATA% resolves to the real user's data folder.
Filename: "{app}\tools\register-relay-task.bat"; StatusMsg: "Registering the local board-ticker relay (login task)..."; Flags: shellexec waituntilterminated runhidden runasoriginaluser; Tasks: relayautostart
; the only finish-page action -- open AEYE once everything is in
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; remove the relay login task on uninstall (before the tools\ bat is deleted)
Filename: "{app}\tools\unregister-relay-task.bat"; Flags: shellexec runhidden; RunOnceId: "DelRelayTask"

[UninstallDelete]
; the frozen tree is removed automatically; nothing extra here.
; user data in %APPDATA%\AEYE is preserved unless the user opts to purge it
; (handled in code, below).

; ============================================================================
[Code]
const
  WV2_GUID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

var
  SkullMemo: TNewMemo;
  SpeechLabel: TNewStaticText;
  Frames: array[0..2] of AnsiString;
  FramesOK: Boolean;
  SeqIdx: Integer;
  TimerCallback: LongWord;
  TimerId: LongWord;
  Captions: TStringList;
  CaptionIdx: Integer;
  RunPhase: Boolean;          // past file extraction, in the long console tasks
  RunStart: LongWord;         // GetTickCount when the run phase began
  LastStatus: string;         // last caption we painted (avoid needless repaint)

// --- WinAPI (timer for the jaw animation + progress creep) ---
function SetTimer(hWnd, nIDEvent, uElapse, lpTimerFunc: LongWord): LongWord;
  external 'SetTimer@user32.dll stdcall';
function KillTimer(hWnd, uIDEvent: LongWord): LongWord;
  external 'KillTimer@user32.dll stdcall';
function GetTickCount: LongWord;
  external 'GetTickCount@kernel32.dll stdcall';
function InternetGetConnectedState(var Flags: LongWord; Reserved: LongWord): Boolean;
  external 'InternetGetConnectedState@wininet.dll stdcall';

// ---- preflight: require admin + internet -----------------------------------
function InternetUp: Boolean;
var
  flags: LongWord;
  http: Variant;
begin
  Result := False;
  // 1) system connection state -- respects LAN/Wi-Fi/proxy and rarely false-
  //    negatives when actually online. This is the reliable primary check.
  try
    if InternetGetConnectedState(flags, 0) then
    begin
      Result := True;
      Exit;
    end;
  except
  end;
  // 2) fallback: a real request over PLAIN HTTP (avoids the TLS/proxy pitfalls
  //    that make an HTTPS probe wrongly report "offline").
  try
    http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    http.Open('GET', 'http://www.msftconnecttest.com/connecttest.txt', False);
    http.SetTimeouts(4000, 4000, 4000, 4000);
    http.Send();
    Result := (http.Status = 200);
  except
    Result := False;
  end;
end;

function InitializeSetup: Boolean;
begin
  Result := True;
  // admin: installs to Program Files. (PrivilegesRequired=admin already elevates,
  // so this is a belt-and-suspenders message.)
  if not IsAdminInstallMode then
  begin
    MsgBox('AEYE Setup must run as Administrator (it installs to Program Files).'
      + #13#10#13#10 + 'Right-click the installer and choose "Run as administrator",'
      + ' then try again.', mbCriticalError, MB_OK);
    Result := False;
    Exit;
  end;
  // internet: needed for the default voice, the AI extras (PyTorch etc.) and
  // models. Detection can be wrong behind some proxies/firewalls, so this is a
  // WARNING you can override rather than a hard stop -- a connected user is
  // never blocked by a false negative.
  if not InternetUp then
  begin
    if MsgBox('No internet connection was detected.'
      + #13#10#13#10 + 'AEYE Setup needs internet to download the default voice, the'
      + ' AI extras (PyTorch, RAG, Whisper) and models.'
      + #13#10#13#10 + 'If you ARE connected (some proxies/firewalls hide it), you can'
      + ' continue anyway.' + #13#10#13#10 + 'Continue with the installation?',
      mbConfirmation, MB_YESNO) = IDNO then
      Result := False;
  end;
end;

// ---- WebView2 detection ----------------------------------------------------
function WebView2Installed: Boolean;
var
  pv: string;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\' + WV2_GUID, 'pv', pv) and (pv <> '') and (pv <> '0.0.0.0')) or
    (RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\' + WV2_GUID, 'pv', pv) and (pv <> '') and (pv <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\' + WV2_GUID, 'pv', pv) and (pv <> '') and (pv <> '0.0.0.0'));
end;

function NeedsWebView2: Boolean;
begin
  Result := not WebView2Installed;
end;

// ---- extras flags from the selected sub-components --------------------------
function ExtrasParams(Param: string): string;
begin
  Result := '--gpu auto';
  if WizardIsComponentSelected('extras\hf')    then Result := Result + ' --hf';
  if WizardIsComponentSelected('extras\image') then Result := Result + ' --image';
  if WizardIsComponentSelected('extras\video') then Result := Result + ' --video';
  if WizardIsComponentSelected('extras\stt')   then Result := Result + ' --stt';
  if WizardIsComponentSelected('extras\rag')   then Result := Result + ' --rag';
  // no sub-item ticked but the parent is -> install everything
  if Result = '--gpu auto' then Result := Result + ' --all';
end;

// ---- helpers ---------------------------------------------------------------
function RepChar(c: Char; n: Integer): string;
var
  i: Integer;
begin
  Result := '';
  for i := 1 to n do Result := Result + c;
end;

function MaxLineLen(const s: AnsiString): Integer;
var
  i, cur: Integer;
begin
  Result := 0; cur := 0;
  for i := 1 to Length(s) do
  begin
    if (s[i] = #10) or (s[i] = #13) then
    begin
      if cur > Result then Result := cur;
      cur := 0;
    end
    else
      Inc(cur);
  end;
  if cur > Result then Result := cur;
end;

function CountLines(const s: AnsiString): Integer;
var
  i: Integer;
begin
  Result := 1;
  for i := 1 to Length(s) do
    if s[i] = #10 then Inc(Result);
end;

procedure SetSpeech(const s: string);
begin
  if SpeechLabel = nil then Exit;
  SpeechLabel.Caption := s;
  SpeechLabel.Left := (WizardForm.InstallingPage.Width - SpeechLabel.Width) div 2;
  SpeechLabel.Top := WizardForm.InstallingPage.Height - ScaleY(42);
end;

function FmtTime(secs: Integer): string;
var
  m, s: Integer;
begin
  m := secs div 60; s := secs mod 60;
  if s < 10 then
    Result := IntToStr(m) + ':0' + IntToStr(s)
  else
    Result := IntToStr(m) + ':' + IntToStr(s);
end;

// ---- skull animation -------------------------------------------------------
function LoadFrame(const Name: string; var Dest: AnsiString): Boolean;
var
  tmp: string;
begin
  Result := False;
  try
    ExtractTemporaryFile(Name);
    tmp := ExpandConstant('{tmp}\') + Name;
    if FileExists(tmp) then
      Result := LoadStringFromFile(tmp, Dest);
  except
    Result := False;
  end;
end;

procedure LoadSkullFrames;
var
  fallback: AnsiString;
begin
  FramesOK :=
    LoadFrame('jaw0.txt', Frames[0]) and
    LoadFrame('jaw1.txt', Frames[1]) and
    LoadFrame('jaw2.txt', Frames[2]);
  if not FramesOK then
  begin
    // degrade to a static skull if the generated frames aren't present
    if LoadFrame('skull.txt', fallback) then
    begin
      Frames[0] := fallback; Frames[1] := fallback; Frames[2] := fallback;
      FramesOK := True;
    end;
  end;
end;

procedure ShowFrame(k: Integer);
begin
  if FramesOK and (SkullMemo <> nil) then
    SkullMemo.Lines.Text := String(Frames[k]);
end;

function SeqFrame(i: Integer): Integer;
begin
  // closed -> ajar -> open -> ajar (looping)
  case i of
    0: Result := 0;
    1: Result := 1;
    2: Result := 2;
  else
    Result := 1;
  end;
end;

procedure OnTimer(H, Msg, Event, Time: LongWord);
var
  secs, pos: Integer;
  work, line: string;
begin
  SeqIdx := (SeqIdx + 1) mod 4;
  ShowFrame(SeqFrame(SeqIdx));

  // during the long [Run] downloads the message loop still pumps (the skull
  // animates), so drive the gauge + status here instead of leaving it at a
  // false 100%.
  if RunPhase then
  begin
    // Inno's StatusMsg can re-show its native labels -- keep them hidden
    WizardForm.StatusLabel.Visible := False;
    WizardForm.FilenameLabel.Visible := False;
    secs := Integer((GetTickCount - RunStart) div 1000);
    // creep 95% -> 99% over ~5 min, then HOLD at 99% (never 100% until done)
    WizardForm.ProgressGauge.Max := 1000;
    pos := 950 + ((secs * 40) div 300);
    if pos > 990 then pos := 990;
    WizardForm.ProgressGauge.Position := pos;
    // mirror the active step's StatusMsg + show elapsed time (kills the
    // "stuck" look: the bar creeps and the clock ticks)
    work := Trim(WizardForm.StatusLabel.Caption);
    if work = '' then work := 'Finishing installation';
    line := work + '     ' + FmtTime(secs) + ' elapsed';
    if line <> LastStatus then
    begin
      LastStatus := line;
      SetSpeech(line);
    end;
  end;
end;

procedure StartSkull;
begin
  if not FramesOK then Exit;
  if TimerId <> 0 then Exit;
  SeqIdx := 0;
  ShowFrame(0);
  TimerCallback := CreateCallback(@OnTimer);
  TimerId := SetTimer(0, 0, 130, TimerCallback);   // ~8 fps, choppy on purpose
end;

procedure StopSkull;
begin
  if TimerId <> 0 then
  begin
    KillTimer(0, TimerId);
    TimerId := 0;
  end;
  ShowFrame(0);   // jaw shut when not installing
end;

// ---- wizard theming + skull placement --------------------------------------
// Theme ONLY the Installing page (the "progress window"); every other page keeps
// its default colors so their text stays readable.
procedure InitializeWizard;
var
  bg, fg: TColor;
  pw, ph, blockW, blockH, lineH, sBottom, sTop, top, h: Integer;
  meas: TNewStaticText;
begin
  bg := $00050805;   // near-black
  fg := $0060F040;   // phosphor green

  WizardForm.InstallingPage.Color := bg;
  pw := WizardForm.InstallingPage.Width;
  ph := WizardForm.InstallingPage.Height;

  // hide the built-in status + long extracting-path labels; the skull and our
  // centered caption carry the page
  WizardForm.StatusLabel.Visible := False;
  WizardForm.FilenameLabel.Visible := False;
  // progress bar to the very bottom
  WizardForm.ProgressGauge.Top := ph - ScaleY(22);

  // green caption sits just above the progress bar (re-centered on each update)
  SpeechLabel := TNewStaticText.Create(WizardForm);
  SpeechLabel.Parent := WizardForm.InstallingPage;
  SpeechLabel.AutoSize := True;
  SpeechLabel.Color := bg;
  SpeechLabel.Font.Color := fg;
  SpeechLabel.Font.Name := 'Consolas';
  SpeechLabel.Font.Style := [fsBold];
  SpeechLabel.Caption := '';

  // the animated skull fills the space ABOVE the caption
  sBottom := ph - ScaleY(46);
  SkullMemo := TNewMemo.Create(WizardForm);
  SkullMemo.Parent := WizardForm.InstallingPage;
  SkullMemo.ReadOnly := True;
  SkullMemo.WantReturns := False;
  SkullMemo.ScrollBars := ssNone;
  SkullMemo.BorderStyle := bsNone;
  SkullMemo.Color := bg;
  SkullMemo.Font.Color := fg;
  SkullMemo.Font.Name := 'Consolas';
  SkullMemo.Font.Size := 6;   // small enough that all ~34 skull rows fit
  SkullMemo.TabStop := False;

  Captions := TStringList.Create;
  Captions.Add('Summoning the eye...');
  Captions.Add('Carving the skull...');
  Captions.Add('Binding Piper''s voice...');
  Captions.Add('Warding the vault...');
  Captions.Add('Sealing the sockets...');
  Captions.Add('Almost alive...');
  CaptionIdx := 0;

  LoadSkullFrames;

  // measure the skull block's pixel size so we can center it on BOTH axes
  // within the black area above the caption
  blockW := pw;
  lineH := 0;
  if FramesOK then
  begin
    meas := TNewStaticText.Create(WizardForm);
    try
      meas.Parent := WizardForm.InstallingPage;
      meas.AutoSize := True;
      meas.Font.Name := 'Consolas';
      meas.Font.Size := SkullMemo.Font.Size;
      meas.Caption := RepChar('0', MaxLineLen(Frames[0]));   // one row, full width
      if (meas.Width > 0) and (meas.Width <= pw) then blockW := meas.Width;
      lineH := meas.Height;
    finally
      meas.Free;
    end;
  end;

  sTop := ScaleY(4);                       // usable band: sTop..sBottom
  blockH := CountLines(Frames[0]) * lineH;
  top := sTop;
  if (blockH > 0) and (blockH < (sBottom - sTop)) then
    top := sTop + ((sBottom - sTop - blockH) div 2);   // vertical centering
  h := sBottom - top;
  SkullMemo.SetBounds((pw - blockW) div 2, top, blockW + ScaleX(4), h);

  ShowFrame(0);
  SetSpeech(Captions[0]);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = wpInstalling then
    StartSkull
  else
    StopSkull;
end;

procedure CurInstallProgressChanged(CurProgress, MaxProgress: Integer);
var
  idx: Integer;
begin
  if MaxProgress <= 0 then Exit;
  // own the gauge: file extraction fills only 0..95%, leaving headroom for the
  // long [Run] tasks so the bar never sits at a false 100%.
  WizardForm.ProgressGauge.Max := 1000;
  WizardForm.ProgressGauge.Position := (CurProgress * 950) div MaxProgress;

  if (SpeechLabel <> nil) and (Captions <> nil) then
  begin
    idx := (CurProgress * Captions.Count) div (MaxProgress + 1);
    if idx >= Captions.Count then idx := Captions.Count - 1;
    if idx <> CaptionIdx then
    begin
      CaptionIdx := idx;
      SetSpeech(Captions[idx]);
    end;
  end;

  // extraction complete -> enter the run phase (the console-window downloads)
  if (not RunPhase) and (CurProgress >= MaxProgress) then
  begin
    RunPhase := True;
    RunStart := GetTickCount;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  // ssPostInstall fires only AFTER every [Run] entry has finished -> now it is
  // genuinely complete, so fill 95->100%.
  if CurStep = ssPostInstall then
  begin
    RunPhase := False;
    WizardForm.ProgressGauge.Max := 1000;
    WizardForm.ProgressGauge.Position := 1000;
    SetSpeech('Complete');
    // if the AI extras were selected but didn't leave a success marker, the
    // extras install failed/aborted (e.g. Python not installed) -- say so
    // instead of reporting a fully successful install.
    if WizardIsComponentSelected('extras') and
       (not FileExists(ExpandConstant('{userappdata}\AEYE\extras\.aeye_extras_ok'))) then
      MsgBox('The AI extras did not finish installing.'
        + #13#10#13#10 + 'AEYE will still run (chat via Ollama works), but'
        + ' HuggingFace, image/video generation, Whisper and document memory'
        + ' will be unavailable until they are installed.'
        + #13#10#13#10 + 'Run "Install or Repair AI Extras" from the Start Menu'
        + ' to finish (watch its console for the reason it stopped).',
        mbError, MB_OK);
  end;
end;

procedure DeinitializeSetup;
begin
  if TimerId <> 0 then KillTimer(0, TimerId);
end;

// ---- uninstall: offer to purge per-user data -------------------------------
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  dataDir: string;
begin
  if CurUninstallStep = usUninstall then
  begin
    dataDir := ExpandConstant('{userappdata}\AEYE');
    if DirExists(dataDir) then
    begin
      if MsgBox('Also delete your AEYE data (chats, memory, documents, plugins,'
        + ' downloaded voices/models, and the AI-extras environment) at'
        + #13#10 + dataDir + ' ?'
        + #13#10#13#10 + 'Choose No to keep it for a future reinstall.',
        mbConfirmation, MB_YESNO) = IDYES then
        DelTree(dataDir, True, True, True);
    end;
  end;
end;
