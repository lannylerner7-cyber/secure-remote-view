# ConnectLive Admin — assets

Drop the admin branding icon here:

```
admin/assets/icon.ico
```

Requirements:

- Windows `.ico` container, 32-bit colour + alpha
- Multi-resolution: 16x16, 32x32, 48x48, 256x256 (all four in the one file)

How it is consumed:

| Consumer | Path | Behaviour when missing |
|---|---|---|
| `admin/src/ConnectLiveAdmin.csproj` `<ApplicationIcon>` | `..\..\assets\icon.ico` | falls back to `agent\assets\icon.ico`, then to the default .NET icon |
| WPF window / taskbar icon (`AppIcon.Apply`) | embedded `Resource` `assets/icon.ico` | window keeps the default icon, no crash |
| `admin/build.ps1` | staged into `dist\` and into `ConnectLiveAdmin.zip` | prints a warning, build continues |

Nothing here is required for the build to succeed — the icon is purely
cosmetic and every reference is conditional.
