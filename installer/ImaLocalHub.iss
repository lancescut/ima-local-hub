; ImaLocalHub Windows 安装包脚本（Inno Setup 6）
; 构建: ISCC.exe ImaLocalHub.iss
; 免管理员（PrivilegesRequired=lowest），内嵌 Node 运行时，双击即装

#define MyAppName "ImaLocalHub"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "lancescut"
#define MyAppExeName "ImaLocalHub"

[Setup]
AppId={{8E4C2A1F-6B7D-4E3A-9C5E-IMALOCALHUB01}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=ImaLocalHub-Setup-{#MyAppVersion}
SetupIconFile=icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\hub.js

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"

[Files]
Source: "..\hub.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\lib\*"; DestDir: "{app}\lib"; Flags: ignoreversion recursesubdirs
Source: "..\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs
Source: "runtime-win\node.exe"; DestDir: "{app}\runtime"; Flags: ignoreversion
Source: "launch-hub.bat"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; 开机自启（用户启动文件夹）
Name: "{userstartup}\ImaLocalHub"; Filename: "{app}\launch-hub.bat"; WorkingDir: "{app}"; Comment: "ima 本地模型服务"
; 开始菜单快捷方式（打开管理页）
Name: "{userprograms}\ImaLocalHub"; Filename: "http://127.0.0.1:18080"; Comment: "打开 ImaLocalHub 管理页"

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    // launch-hub.bat 自带旧实例清理；分离启动守护进程并打开管理页
    ExecAsOriginalUser(ExpandConstant('{cmd}'), '/c start "" /min "' + ExpandConstant('{app}\launch-hub.bat') + '"', '', SW_HIDE, ewNoWait, ResultCode);
    ExecAsOriginalUser(ExpandConstant('{cmd}'), '/c start http://127.0.0.1:18080', '', SW_HIDE, ewNoWait, ResultCode);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Exec(ExpandConstant('{cmd}'), '/c powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter ""Name=''node.exe''"" | Where-Object { $_.CommandLine -like ''*ImaLocalHub*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ExpandConstant('{cmd}'), '/c powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter ""Name=''cloudflared.exe''"" | Where-Object { $_.ExecutablePath -like ''*ImaLocalHub*'' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;
