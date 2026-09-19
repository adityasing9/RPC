"""Windows Audio Output Device management and default endpoint switching."""
import sys
import logging
from typing import List, Dict, Optional

logger = logging.getLogger("rcpc.audio_output")

def list_audio_outputs() -> List[Dict]:
    """
    Enumerate all Windows audio rendering (playback) endpoints.
    Returns list of dicts with id, name, state, is_active, is_default, is_bluetooth.
    """
    if not sys.platform.startswith("win"):
        return []

    import pycaw.pycaw as pycaw
    import comtypes
    import warnings
    warnings.filterwarnings("ignore", category=UserWarning, module="pycaw")

    try:
        comtypes.CoInitialize()
    except Exception:
        pass

    devices = []
    try:
        devs = pycaw.AudioUtilities.GetAllDevices(data_flow=0)  # eRender = 0
        spk = pycaw.AudioUtilities.GetSpeakers()
        default_id = spk.id if spk else None

        bt_keywords = [
            'bluetooth', 'hands-free', 'earbud', 'headphone', 'headset',
            'airbass', 'speaker', 'sound outdoor', 'buds', 'm51', 'jd1', 'toad', 'wireless'
        ]

        for d in devs:
            if not d or not d.FriendlyName:
                continue

            state_name = d.state.name if hasattr(d.state, 'name') else str(d.state)
            state_val = d.state.value if hasattr(d.state, 'value') else d.state
            is_active = (state_val == 1)
            is_def = (d.id == default_id)

            lower_name = d.FriendlyName.lower()
            is_built_in = any(x in lower_name for x in ['realtek', 'intel', 'nvidia', 'aux jack'])
            is_bt = any(k in lower_name for k in bt_keywords) and not is_built_in

            devices.append({
                "id": d.id,
                "name": d.FriendlyName,
                "state": state_name,
                "is_active": is_active,
                "is_default": is_def,
                "is_bluetooth": is_bt
            })

        # Sort: default device first, then other active devices, then unplugged/disabled
        devices.sort(key=lambda x: (not x["is_default"], not x["is_active"], x["name"]))

    except Exception as e:
        logger.error(f"Error enumerating audio outputs: {e}", exc_info=True)

    return devices


def set_default_audio_output(device_id: str) -> bool:
    """
    Set specified Windows audio playback device as default endpoint using IPolicyConfig.
    Applies to Console (0), Multimedia (1), and Communications (2) roles.
    """
    if not sys.platform.startswith("win"):
        logger.warning("Setting default audio device only supported on Windows")
        return False

    import comtypes
    from comtypes import GUID, IUnknown, COMMETHOD, HRESULT
    from ctypes import c_int, c_wchar_p, c_void_p

    CLSID_PolicyConfigClient = GUID('{870af99c-171d-4f9e-af0d-e63df40c2bc9}')

    class IPolicyConfig(IUnknown):
        _iid_ = GUID('{f8679f50-850a-41cf-9c72-430f290290c8}')
        _methods_ = [
            COMMETHOD([], HRESULT, 'GetMixFormat', (['in'], c_wchar_p, 'pszDeviceName'), (['out'], c_void_p, 'ppFormat')),
            COMMETHOD([], HRESULT, 'GetDeviceFormat'),
            COMMETHOD([], HRESULT, 'ResetDeviceFormat'),
            COMMETHOD([], HRESULT, 'SetDeviceFormat'),
            COMMETHOD([], HRESULT, 'GetProcessingPeriod'),
            COMMETHOD([], HRESULT, 'SetProcessingPeriod'),
            COMMETHOD([], HRESULT, 'GetShareMode'),
            COMMETHOD([], HRESULT, 'SetShareMode'),
            COMMETHOD([], HRESULT, 'GetPropertyValue'),
            COMMETHOD([], HRESULT, 'SetPropertyValue'),
            COMMETHOD([], HRESULT, 'SetDefaultEndpoint',
                      (['in'], c_wchar_p, 'pszDeviceName'),
                      (['in'], c_int, 'eRole')),
            COMMETHOD([], HRESULT, 'SetEndpointVisibility'),
        ]

    try:
        try:
            comtypes.CoInitialize()
        except Exception:
            pass

        policy_config = comtypes.CoCreateInstance(CLSID_PolicyConfigClient, IPolicyConfig, comtypes.CLSCTX_ALL)
        for role in (0, 1, 2):
            hr = policy_config.SetDefaultEndpoint(device_id, role)
            if hr != 0:
                logger.warning(f"SetDefaultEndpoint role={role} returned hr={hr}")

        logger.info(f"Successfully switched default audio endpoint to: {device_id}")
        return True
    except Exception as e:
        logger.error(f"Failed to set default audio output device: {e}", exc_info=True)
        return False
