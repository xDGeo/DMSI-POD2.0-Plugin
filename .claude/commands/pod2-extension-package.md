# Package POD 2.0 Custom Extension

Create a deployment-ready zip artifact from this repository's root (the repo root *is* the
extension package root — `extension.json` lives at the top level).

## Steps

1. Detect the operating system using the Bash tool:
   ```bash
   uname -s 2>/dev/null || echo "Windows"
   ```

2. Locate the repo root (the directory containing `extension.json`):
   - On macOS/Linux:
     ```bash
     SOURCE=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
     echo "$SOURCE"
     ```
   - On Windows (PowerShell):
     ```powershell
     $SOURCE = (git rev-parse --show-toplevel 2>$null); if (-not $SOURCE) { $SOURCE = (Get-Location).Path }
     $SOURCE
     ```
   If `extension.json` is not found directly under `$SOURCE`, tell the user and stop.

3. Delete any existing `*.zip` files inside that directory.
   - On macOS/Linux:
     ```bash
     find "$SOURCE" -maxdepth 1 -name "*.zip" -delete
     ```
   - On Windows (PowerShell):
     ```powershell
     Get-ChildItem -Path $SOURCE -Depth 0 -Filter "*.zip" | Remove-Item
     ```

4. Create a new zip archive named `dmsi-pod2-extension.zip` containing **all content inside**
   the directory (not the directory itself). Exclude macOS metadata, `.git`, `.claude`, and
   this project's own docs/context/scratch files.
   - On macOS/Linux:
     ```bash
     cd "$SOURCE" && zip -r dmsi-pod2-extension.zip . \
       --exclude "*.DS_Store" --exclude "__MACOSX/*" \
       --exclude ".git/*" --exclude ".claude/*" \
       --exclude "Context.md" --exclude "1.txt" --exclude "image.png" --exclude "*.zip"
     ```
   - On Windows (PowerShell):
     ```powershell
     $items = Get-ChildItem -Path $SOURCE | Where-Object { $_.Name -notin @(".git", ".claude", "Context.md", "1.txt", "image.png") -and $_.Extension -ne ".zip" }
     Compress-Archive -Path $items.FullName -DestinationPath "$SOURCE\dmsi-pod2-extension.zip" -Force
     ```

5. Confirm the archive was created and report its size.
   - On macOS/Linux:
     ```bash
     ls -lh "$SOURCE/dmsi-pod2-extension.zip"
     ```
   - On Windows (PowerShell):
     ```powershell
     Get-Item "$SOURCE\dmsi-pod2-extension.zip" | Select-Object Name, @{Name="Size";Expression={"{0:N0} KB" -f ($_.Length/1KB)}}
     ```

6. Tell the user the full path to the zip file.

7. Print the **Manage POD 2.0 → Extensions upload values**:

```
╔══════════════════════════════════════════════════════════════════════════════════════════╗
║  Manage POD 2.0 → Extensions — Upload values                                             ║
╠══════════════════════════════════════════════════════════════════════════════════════════╣
║  Name:        dmsi-pod2-plugins                                                          ║
║  Description: DMSI POD 2.0 custom extension: Finished SFC List widget.                   ║
║  Namespace:   dmsi.pod2                                                                  ║
║  Source Code: dmsi-pod2-extension.zip  (upload the zip)                                  ║
╚══════════════════════════════════════════════════════════════════════════════════════════╝
```
