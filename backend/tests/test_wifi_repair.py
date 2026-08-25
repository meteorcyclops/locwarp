import unittest
from types import SimpleNamespace

from api.device import _open_repair_rsd


class _FailingProxy:
    @classmethod
    async def create(cls, lockdown):
        raise AssertionError("a second userspace tunnel must not be opened")


class WifiRepairRsdTests(unittest.IsolatedAsyncioTestCase):
    async def test_reuses_active_usb_rsd(self):
        rsd = object()
        dm = SimpleNamespace(
            _connections={
                "phone": SimpleNamespace(
                    rsd=rsd,
                    connection_type="USB",
                )
            }
        )

        result = await _open_repair_rsd(
            dm,
            "phone",
            object(),
            _FailingProxy,
            object,
        )

        self.assertEqual(result, (rsd, None, None, False))

    async def test_reuses_active_rsd_even_when_usbmux_labels_it_network(self):
        rsd = object()
        dm = SimpleNamespace(
            _connections={
                "phone": SimpleNamespace(
                    rsd=rsd,
                    connection_type="Network",
                )
            }
        )

        result = await _open_repair_rsd(
            dm,
            "phone",
            object(),
            _FailingProxy,
            object,
        )

        self.assertEqual(result, (rsd, None, None, False))


if __name__ == "__main__":
    unittest.main()
