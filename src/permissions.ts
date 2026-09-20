import { chmod, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
// Static PowerShell program; the filename is passed through an environment variable,
// never interpolated into executable code. Restrict to current identity and SYSTEM.
const readAcl = `$ErrorActionPreference='Stop'; $p=$env:CLILINKAPI_ACL_PATH; $dir=[System.IO.Directory]::Exists($p); $a=if($dir){[System.IO.Directory]::GetAccessControl($p)}else{[System.IO.File]::GetAccessControl($p)};`;
const aclScript = readAcl + `$s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; if($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $s.Value){$a.SetOwner($s)}; $a.SetAccessRuleProtection($true,$false); foreach($r in @($a.Access)){[void]$a.RemoveAccessRuleSpecific($r)}; $inherit=if($dir){'ContainerInherit,ObjectInherit'}else{'None'}; foreach($id in @($s.Value,'S-1-5-18')) { $sid=[System.Security.Principal.SecurityIdentifier]::new($id); $r=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl',$inherit,'None','Allow'); $a.AddAccessRule($r) }; if($dir){[System.IO.Directory]::SetAccessControl($p,$a)}else{[System.IO.File]::SetAccessControl($p,$a)}`;
const verifyScript = readAcl + `$s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $s){exit 2}; foreach($r in $a.Access){$id=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($r.AccessControlType -eq 'Allow' -and $id -ne $s -and $id -ne 'S-1-5-18'){exit 3}}`;
async function windows(script: string, filename: string): Promise<void> { await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, CLILINKAPI_ACL_PATH: filename }, windowsHide: true, timeout: 10000 }); }
export async function protect(filename: string, directory = false): Promise<void> { if (process.platform === 'win32') await windows(aclScript, filename); else await chmod(filename, directory ? 0o700 : 0o600); }
export async function verifyOwner(filename: string): Promise<void> {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || (!info.isDirectory() && info.nlink > 1)) throw new Error('Secret storage must not be a symbolic or hard link.');
  if (process.platform === 'win32') {
    try { await windows(readAcl + `$s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; if($a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $s){exit 2}`, filename); }
    catch { throw new Error('Secret storage must be owned by the current runtime user before permissions can be repaired.'); }
  } else if (process.getuid && info.uid !== process.getuid()) throw new Error('Secret storage must be owned by the current runtime user before permissions can be repaired.');
}
export async function verifyPrivate(filename: string): Promise<void> {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || (!info.isDirectory() && info.nlink > 1)) throw new Error('Secret storage must not be a symbolic or hard link.');
  if (process.platform === 'win32') { try { await windows(verifyScript, filename); } catch { throw new Error(`Private storage check failed for "${filename}": ACL must grant access only to the runtime user and SYSTEM. Run: npm run aiclitoaiapi -- secure-config CONFIG_PATH`); } }
  else if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw new Error('Secret storage must be owned by the runtime user, with mode 0600 (file) or 0700 (directory).');
}
// A parent may be traversable/readable without making a protected secret file
// readable. Reject other identities' directory mutation rights, which could
// permit replacing that file. The file itself must still pass verifyPrivate.
export async function verifyConfigDirectory(directory: string): Promise<void> {
  await verifyOwner(directory);
  if (!(await lstat(directory)).isDirectory()) throw new Error('Configuration parent must be a directory.');
  if (process.platform !== 'win32') { await verifyPrivate(directory); return; }
  const script = readAcl + `$s=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $unsafe=[System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership; foreach($r in $a.Access){$id=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($r.AccessControlType -eq 'Allow' -and $id -ne $s -and $id -ne 'S-1-5-18' -and ($r.FileSystemRights -band $unsafe) -ne 0){exit 3}}`;
  try { await windows(script, directory); }
  catch { throw new Error(`Configuration directory "${directory}" permits modification by another account. Run: npm run aiclitoaiapi -- secure-config CONFIG_PATH`); }
}
