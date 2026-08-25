import unittest
from types import SimpleNamespace

from api.device import _open_repair_rsd


class _FailingProxy:
    @classmethod
    async def create(cls, lockdown):
        raise AssertionError("a second userspace tunnel must not be opened")


class _FallbackTunnelContext:
    def __init__(self):
        self.closed = False

    async def __aenter__(self):
        return SimpleNamespace(address="fd00::1", port=12345)

    async def __aexit__(self, exc_type, exc, traceback):
        self.closed = True


class _FallbackProxy:
    context = _FallbackTunnelContext()

    @classmethod
    async def create(cls, lockdown):
        cls.context = _FallbackTunnelContext()
        return cls()

    def start_tcp_tunnel(self):
        return self.context


class _FailingRsd:
    closed = False

    def __init__(self, address):
        type(self).closed = False

    async def connect(self):
        raise RuntimeError("connect failed")

    def close(self):
        type(self).closed = True


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

    async def test_cleans_up_fallback_tunnel_when_rsd_connect_fails(self):
        dm = SimpleNamespace(_connections={})

        with self.assertRaisesRegex(RuntimeError, "connect failed"):
            await _open_repair_rsd(
                dm,
                "phone",
                object(),
                _FallbackProxy,
                _FailingRsd,
            )

        self.assertTrue(_FailingRsd.closed)
        self.assertTrue(_FallbackProxy.context.closed)


if __name__ == "__main__":
    unittest.main()
