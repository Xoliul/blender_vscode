import logging
import os
import sys
import json
import traceback
from pathlib import Path
from typing import TYPE_CHECKING

include_dir = Path(__file__).parent / "include"
sys.path.append(str(include_dir))

# Get proper type hinting without impacting runtime
if TYPE_CHECKING:
    from .include import blender_vscode
else:
    import blender_vscode

LOG = blender_vscode.log.getLogger()
LOG.info(f"ADDONS_TO_LOAD {json.loads(os.environ['ADDONS_TO_LOAD'])}")

try:
    recovery_blend = str(os.environ.get("BLENDER_VSCODE_RECOVERY_BLEND", "")).strip()
    if recovery_blend:
        import bpy

        def _recover_autosave():
            try:
                # Use Blender's own recovery flow so the session remains tied to the original file.
                bpy.ops.wm.recover_auto_save(filepath=recovery_blend)
            except Exception:
                LOG.exception("Failed to recover autosave file")
            return None

        bpy.app.timers.register(_recover_autosave, first_interval=0.1)

    addons_to_load = []
    for info in json.loads(os.environ["ADDONS_TO_LOAD"]):
        addon_info = blender_vscode.AddonInfo(**info)
        addon_info.load_dir = Path(addon_info.load_dir)
        addons_to_load.append(addon_info)

    blender_vscode.startup(
        editor_address=f"http://localhost:{os.environ['EDITOR_PORT']}",
        addons_to_load=addons_to_load,
    )
except Exception as e:
    if type(e) is not SystemExit:
        traceback.print_exc()
        sys.exit()
