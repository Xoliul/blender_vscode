# Blender Reload Standalone Service

Standalone local service that launches or attaches to Blender, watches addon source files, and triggers automatic addon reload using the same protocol as the extension.

## Quick start

1. Install dependencies:
   - `cd standalone`
   - `npm install`
2. Build control page:
   - `npm run build:ui`
3. Start service:
   - `npm run dev`
4. Open control page:
   - [http://127.0.0.1:19321](http://127.0.0.1:19321)

## Ports

- `19321`: control page + REST API
- `19322`: editor bridge endpoint Blender posts events to

Override with env vars:
- `STANDALONE_WEB_PORT`
- `STANDALONE_EDITOR_PORT`

## Config

Config is stored at `standalone/data/service.config.json`.

Example:

```json
{
  "blenderExecutable": "C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe",
  "blenderArgs": [],
  "mode": "launch",
  "attach": {
    "host": "127.0.0.1",
    "blenderPort": 61555
  },
  "addonEntries": [
    {
      "sourceDir": "G:\\Code\\my_addon\\src",
      "loadDir": "G:\\Code\\my_addon\\src",
      "moduleName": "auto"
    }
  ],
  "watcher": {
    "enabled": true,
    "debounceMs": 250,
    "includeGlobs": ["**/*.py", "**/*.toml", "**/*.json"],
    "ignoredGlobs": ["**/.git/**", "**/__pycache__/**", "**/*.pyc"]
  },
  "environment": {},
  "preReloadCommand": ""
}
```

## Behavior notes

- In `launch` mode, the service starts Blender with `pythonFiles/launch.py`.
- In `attach` mode, provide a Blender HTTP port and the service will send reload commands directly.
- Reload payload contract remains unchanged:
  - `{"type":"reload","names":[...],"dirs":[...]}`
